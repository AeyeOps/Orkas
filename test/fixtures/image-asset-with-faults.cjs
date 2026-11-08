'use strict';

const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const scriptPath = path.join(__dirname, '../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/image_asset.js');

module.exports = ({ args, op, invalidPreparedImage, renameFault }) => {
  const root = args[args.indexOf('--project') + 1];
  if (op !== 'process') {
    process.env.ORKAS_REMBG_BIN = 'fixture-image-transform';
    process.env.ORKAS_REALESRGAN_BIN = 'fixture-image-transform';
    childProcess.spawn = (_command, spawnArgs) => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
      queueMicrotask(() => {
        const target = op === 'remove_background' ? spawnArgs[2] : spawnArgs[spawnArgs.indexOf('-o') + 1];
        fs.writeFileSync(target, invalidPreparedImage ? Buffer.from('invalid image') : fs.readFileSync(path.join(root, 'source.png')));
        child.emit('close', 0);
      });
      return child;
    };
  }
  if (renameFault) {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(to) === path.join(root, 'output.png')) {
        throw Object.assign(new Error('Synthetic replacement denial'), { code: renameFault });
      }
      return rename(from, to);
    };
  }
  return require(scriptPath)({ args });
};
