import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { bundledNodeExecutable } from '../../src/main/util/bundled-runtime';

type Pending = { resolve(value: unknown): void; reject(error: Error): void };
type Reply = { id: number; ok: boolean; result?: unknown; message?: string; code?: string };

/** A bundled stock-Node process that answers each call with `await require(modulePath)(input)`, the contract bin/run-skill.cjs gives skill scripts. */
export class BundledNodeProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;

  constructor() {
    const node = bundledNodeExecutable();
    if (!node) throw new Error('The bundled Node runtime is missing. Run npm run runtime:prepare:dev.');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    this.child = fork(path.join(__dirname, 'bundled-node-worker.cjs'), [], {
      execPath: node, execArgv: [], env, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.child.on('message', ({ id, ok, result, message, code }: Reply) => {
      const request = this.pending.get(id);
      this.pending.delete(id);
      if (!this.pending.size) this.child.channel.unref();
      if (ok) request.resolve(result);
      else request.reject(Object.assign(new Error(message), { code }));
    });
    this.child.on('exit', (code, signal) => {
      const error = new Error(`The bundled Node process exited with code ${code} and signal ${signal}.`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
    this.child.unref();
    this.child.channel.unref();
  }

  get connected(): boolean {
    return this.child.connected;
  }

  call(modulePath: string, input: unknown): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.child.send({ id, modulePath, input });
      this.pending.set(id, { resolve, reject });
      this.child.channel.ref();
    });
  }

  close(): void {
    if (this.child.connected) this.child.disconnect();
  }
}

/** Runs one call in a fresh bundled-Node process that sees the caller's current environment. */
export async function runInBundledNode(modulePath: string, input: unknown): Promise<any> {
  const node = new BundledNodeProcess();
  try {
    return await node.call(modulePath, input);
  } finally {
    node.close();
  }
}
