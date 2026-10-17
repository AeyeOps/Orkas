'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');

/** Register before evaluation; never retry a partially initialized module. */
function registerSkillEsmLoader(pcDir, nodePaths, nativeJsLoader) {
  const esbuild = require(path.join(pcDir, 'node_modules', 'esbuild'));
  const commonJsSources = new Map();
  function classifyCommonJs(filename, source) {
    const ext = path.extname(filename);
    const parsed = esbuild.buildSync({
      stdin: { contents: source, sourcefile: `${filename}.js`, loader: ext === '.ts' ? 'ts' : 'js' },
      write: false, metafile: true, format: 'esm', platform: 'node', logLevel: 'silent',
    });
    if (Object.values(parsed.metafile.inputs)[0]?.format !== 'cjs') return null;
    const compiled = ext === '.ts'
      ? esbuild.transformSync(source, { loader: 'ts', format: 'cjs', sourcefile: filename, logLevel: 'silent' }).code
      : source;
    commonJsSources.set(filename, compiled);
    return compiled;
  }
  function commonJsSource(filename) {
    return commonJsSources.has(filename) ? commonJsSources.get(filename)
      : classifyCommonJs(filename, fs.readFileSync(filename, 'utf8'));
  }
  // tsx installs a CJS transform for .mjs. Native require of a synchronous ESM
  // dependency must instead share the import cache and this load hook.
  const loadScript = (module, filename) => {
    const source = commonJsSource(filename);
    // Native .js loading infers ESM again from .mjs even after hook classification.
    if (source !== null) module._compile(source, filename, 'commonjs');
    else nativeJsLoader(module, filename);
  };
  Module._extensions['.mjs'] = loadScript;
  Module._extensions['.ts'] = loadScript;
  const fallbackParents = nodePaths.map((directory) => (
    pathToFileURL(path.join(directory, '..', '__orkas_skill_resolution__.mjs')).href
  ));

  const hooks = Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        // Retain tsx's relative file/directory resolution for legacy imports.
        if (context.parentURL?.startsWith('file:') && specifier.startsWith('.')
          && ['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error.code)) {
          const resolved = Module.createRequire(context.parentURL).resolve(specifier);
          return nextResolve(pathToFileURL(resolved).href, context);
        }
        // Native imports do not honor NODE_PATH. Keep import conditions when
        // using the same fallback roots as the legacy CJS loader, and never
        // rescue a broken locally installed package with a different copy.
        if (error.code !== 'ERR_MODULE_NOT_FOUND'
          || specifier.startsWith('.') || specifier.startsWith('/')
          || specifier.startsWith('#') || URL.canParse(specifier)
          || !context.parentURL?.startsWith('file:')) throw error;
        const segments = specifier.split('/');
        const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
        const localPaths = Module._nodeModulePaths(path.dirname(fileURLToPath(context.parentURL)));
        if (localPaths.some((directory) => fs.existsSync(path.join(directory, packageName)))) throw error;
        for (let i = 0; i < fallbackParents.length; i++) {
          try {
            return nextResolve(specifier, { ...context, parentURL: fallbackParents[i] });
          } catch (fallbackError) {
            if (fallbackError.code !== 'ERR_MODULE_NOT_FOUND'
              || fs.existsSync(path.join(nodePaths[i], packageName))) throw fallbackError;
          }
        }
        throw error;
      }
    },
    load(url, context, nextLoad) {
      const ext = url.startsWith('file:') ? path.extname(fileURLToPath(url)) : '';
      const loaded = nextLoad(url, ext === '.ts' ? { ...context, format: 'module' } : context);
      if (ext !== '.mjs' && ext !== '.ts') return loaded;
      const filename = fileURLToPath(url);
      // Native CJS cache loading may omit source; classify the actual file.
      const source = loaded.source == null ? fs.readFileSync(filename, 'utf8')
        : Buffer.isBuffer(loaded.source) || ArrayBuffer.isView(loaded.source)
          ? Buffer.from(loaded.source).toString('utf8') : String(loaded.source);
      // Some existing .mjs files actually export through CommonJS. Classify
      // syntax without evaluation, using a neutral extension so esbuild does
      // not assume ESM solely from the filename. Keep those files in the native
      // CJS cache instead of changing their require() return shape.
      const commonJs = classifyCommonJs(filename, source);
      if (commonJs !== null) return { ...loaded, format: 'commonjs', source: commonJs };
      // esbuild substitutes unbound identifiers only, so authored createRequire
      // bindings and local variables keep their semantics. Pick a collision-free
      // helper name before transforming, without rewriting the installed file.
      let name = '__orkas_skill_cjs';
      while (source.includes(name)) name += '_';
      const transformed = esbuild.transformSync(source, {
        loader: ext === '.ts' ? 'ts' : 'js', format: 'esm', platform: 'node', target: 'node22',
        sourcefile: filename, sourcemap: 'inline', logLevel: 'silent',
        define: {
          require: `${name}.require`, module: name, exports: `${name}.exports`,
          __filename: JSON.stringify(filename), __dirname: JSON.stringify(path.dirname(filename)),
        },
        banner: [
          `import { Module as ${name}_Module, createRequire as ${name}_createRequire } from 'node:module';`,
          `const ${name} = new ${name}_Module(${JSON.stringify(filename)});`,
          `${name}.filename = ${JSON.stringify(filename)};`,
          `${name}.require = ${name}_createRequire(import.meta.url);`,
        ].join('\n'),
      });
      return { ...loaded, format: 'module', source: transformed.code };
    },
  });
  return { hooks, isCommonJs: (filename) => commonJsSource(filename) !== null };
}

module.exports = { registerSkillEsmLoader };
