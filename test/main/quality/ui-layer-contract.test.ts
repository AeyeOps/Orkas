import * as fs from 'node:fs';
import * as path from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const renderer = path.resolve(__dirname, '../../../src/renderer');

function sourceFiles(directory: string, extension: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'vendor') return [];
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(full, extension) : entry.name.endsWith(extension) ? [full] : [];
  });
}

function undeclaredInlineLayers(source: string): string[] {
  const file = ts.createSourceFile('surface.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const findings: string[] = [];
  function scope(node: ts.Node): ts.Node {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionLike(parent)) return parent;
    }
    return file;
  }
  function declared(owner: string, container: ts.Node): boolean {
    let found = false;
    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && [owner + '.dataset.uiOverlay', owner + '.dataset.uiLayoutChrome'].includes(node.left.getText(file))
        && ts.isStringLiteralLike(node.right)) found = true;
      ts.forEachChild(node, visit);
    };
    visit(container); return found;
  }
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node)) findings.push(...undeclaredMarkup(node.text));
    if (ts.isTemplateExpression(node)) findings.push(...undeclaredMarkup(
      [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join('__dynamic__'),
    ));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      const left = node.left;
      const style = left.expression;
      if (ts.isPropertyAccessExpression(style) && style.name.text === 'style') {
        const empty = ts.isStringLiteralLike(node.right) && node.right.text === '';
        const fixed = left.name.text === 'position' && (!ts.isStringLiteralLike(node.right)
          || ['absolute', 'fixed'].includes(node.right.text));
        const css = left.name.text === 'cssText' && ts.isStringLiteralLike(node.right)
          && undeclaredLayers(`.inline { ${node.right.text} }`).length > 0;
        if ((fixed || (!empty && left.name.text === 'zIndex') || css) && !declared(style.expression.getText(file), scope(node))) {
          findings.push(left.getText(file));
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file); return findings;
}

function undeclaredLayers(source: string): string[] {
  const findings: string[] = [];
  postcss.parse(source).walkRules(rule => {
    const declarations = new Map(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value.trim()]));
    if (!declarations.has('z-index') && !['absolute', 'fixed'].includes(declarations.get('position') || '')) return;
    const kind = declarations.get('--orkas-ui-layer') || '';
    if (!['overlay', 'chrome'].includes(kind)
      || (kind === 'overlay' && /:(?:hover|active|focus(?:-visible|-within)?)(?![\w-])/.test(rule.selector))) findings.push(rule.selector);
  });
  return findings;
}

function undeclaredMarkup(source: string): string[] {
  const findings: string[] = [];
  for (const style of source.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)) findings.push(...undeclaredLayers(style[1]));
  for (const tag of source.match(/<[\w:-]+(?:[^>"']|"[^"]*"|'[^']*')*>/g) || []) {
    const style = /\sstyle\s*=\s*(["'])(.*?)\1/s.exec(tag)?.[2];
    if (!style || undeclaredLayers(`.inline { ${style} }`).length === 0) continue;
    const classes = /\sclass\s*=\s*(["'])(.*?)\1/s.exec(tag)?.[2].split(/\s+/) || [];
    if (!classes.includes('ui-overlay') && !/\sdata-ui-(?:overlay|layout-chrome)(?:[\s=>])/.test(tag)) findings.push(tag);
  }
  return findings;
}

describe('application stacking layer ownership', () => {
  it('requires declarations across the actual application stylesheet inventory, including new view directories', () => {
    const findings = sourceFiles(renderer, '.css').flatMap(file => undeclaredLayers(fs.readFileSync(file, 'utf8')).map(selector => (
      `${path.relative(renderer, file)}: ${selector}`
    )));
    expect(findings).toEqual([]);
  });

  it('rejects a new unnamed floating family and accepts a shared declaration without browser-specific registration', () => {
    expect(undeclaredLayers('.new-surface { position: fixed; z-index: 5000; }')).toEqual(['.new-surface']);
    expect(undeclaredLayers('.new-surface { position: absolute; z-index: 5000; --orkas-ui-layer: overlay; }')).toEqual([]);
    expect(undeclaredLayers('@media (min-width: 600px) { .new-surface { position: fixed; } }')).toEqual(['.new-surface']);
    expect(undeclaredLayers('.new-surface { position: fixed; --orkas-ui-layer: guessed; }')).toEqual(['.new-surface']);
    expect(undeclaredLayers('.new-surface { position: absolute; }')).toEqual(['.new-surface']);
    expect(undeclaredLayers('.new-surface:hover { position:absolute; --orkas-ui-layer:overlay; }')).toEqual(['.new-surface:hover']);
  });

  it('discovers new directories rather than inheriting a frozen filename list', () => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ui-layer-inventory-'));
    try {
      fs.mkdirSync(path.join(root, 'new-view'));
      fs.writeFileSync(path.join(root, 'new-view', 'new.css'), '.new { position: fixed; }');
      expect(sourceFiles(root, '.css').flatMap(file => undeclaredLayers(fs.readFileSync(file, 'utf8')))).toEqual(['.new']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('requires the same public marker for direct inline floating styles across all first-party renderer scripts', () => {
    const findings = sourceFiles(renderer, '.js').flatMap(file => undeclaredInlineLayers(fs.readFileSync(file, 'utf8')).map(selector => (
      `${path.relative(renderer, file)}: ${selector}`
    )));
    expect(findings).toEqual([]);
    expect(undeclaredInlineLayers("function open() { node.style.position = 'fixed'; node.style.zIndex = '900'; }")).toEqual(['node.style.position', 'node.style.zIndex']);
    expect(undeclaredInlineLayers("function open() { node.dataset.uiOverlay = ''; node.style.position = 'fixed'; node.style.zIndex = '900'; }")).toEqual([]);
    expect(undeclaredInlineLayers("function a() { node.dataset.uiOverlay = ''; } function b() { node.style.position = 'fixed'; }")).toEqual(['node.style.position']);
    expect(undeclaredInlineLayers("node.style.position = 'absolute'")).toEqual(['node.style.position']);
  });

  it('covers static and generated inline markup so a new panel cannot bypass the stylesheet gate', () => {
    expect(sourceFiles(renderer, '.html').flatMap(file => undeclaredMarkup(fs.readFileSync(file, 'utf8')))).toEqual([]);
    expect(undeclaredMarkup('<section style="position:fixed;z-index:999">')).toHaveLength(1);
    expect(undeclaredMarkup('<section class="ui-overlay" style="position:fixed;z-index:999">')).toEqual([]);
    expect(undeclaredMarkup('<section style="position:fixed;--orkas-ui-layer:overlay">')).toEqual([]);
    expect(undeclaredInlineLayers('node.innerHTML = `<section style="position:fixed;z-index:999">`')).toHaveLength(1);
    expect(undeclaredInlineLayers('node.innerHTML = `<section style="position:fixed;z-index:${level}">`')).toHaveLength(1);
    expect(undeclaredMarkup('<style>.new { position:fixed; z-index:900; }</style>')).toEqual(['.new']);
  });
});
