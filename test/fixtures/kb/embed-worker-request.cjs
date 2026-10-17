// Exercise the worker protocol with fixture-only dependencies. An isolated
// process also releases Electron's native ASAR cache before fixture cleanup.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

async function requestWorker(sourceFile, workerDir, modelDir) {
  let receive;
  let reply;
  const response = new Promise(resolve => { reply = resolve; });
  const timer = setTimeout(() => reply({ timedOut: true }), 2000);
  try {
    vm.runInNewContext(fs.readFileSync(sourceFile, 'utf8'), {
      __dirname: workerDir,
      require: createRequire(path.join(workerDir, 'kb-embed-worker.cjs')),
      process: {
        env: { ORKAS_EMBED_MODEL_DIR: modelDir },
        parentPort: { on: (_name, callback) => { receive = callback; }, postMessage: reply },
        exit: () => { throw new Error('Worker exited before handling a request'); },
      },
    });
    assert.equal(typeof receive, 'function');
    receive({ data: { id: 17, type: 'embed', texts: ['first document', 'second document'] } });
    return await response;
  } finally { clearTimeout(timer); }
}

module.exports = { requestWorker };
if (require.main === module) {
  requestWorker(...process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result));
  }, error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
}
