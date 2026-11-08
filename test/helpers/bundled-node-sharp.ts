import path from 'node:path';
import type {
  FlattenOptions, JpegOptions, Metadata, OutputInfo, OverlayOptions, PngOptions, RawOptions, Region,
  ResizeOptions, SharpInput, SharpOptions, Stats, WebpOptions,
} from 'sharp';
import { BundledNodeProcess } from './bundled-node';

type Step = { method: string; args: unknown[] };

const sharpChain = path.join(__dirname, 'sharp-chain.cjs');
let shared: BundledNodeProcess | undefined;

function run(input: unknown[], steps: Step[], terminal: Step): Promise<any> {
  if (!shared?.connected) shared = new BundledNodeProcess();
  return shared.call(sharpChain, { input, steps, terminal });
}

/** The part of sharp's fluent API the tests use, run in the bundled stock-Node process instead of the Electron test worker. */
class BundledNodeSharp {
  private readonly steps: Step[] = [];

  constructor(private readonly input: unknown[]) {}

  private chain(method: string, args: unknown[]): this {
    this.steps.push({ method, args });
    return this;
  }

  clone(): BundledNodeSharp {
    const copy = new BundledNodeSharp(this.input);
    copy.steps.push(...this.steps);
    return copy;
  }

  resize(...args: [widthOrOptions?: number | ResizeOptions | null, height?: number | null, options?: ResizeOptions]): this {
    return this.chain('resize', args);
  }

  extract(...args: [region: Region]): this { return this.chain('extract', args); }
  composite(...args: [images: OverlayOptions[]]): this { return this.chain('composite', args); }
  ensureAlpha(...args: [alpha?: number]): this { return this.chain('ensureAlpha', args); }
  removeAlpha(): this { return this.chain('removeAlpha', []); }
  flatten(...args: [flatten?: boolean | FlattenOptions]): this { return this.chain('flatten', args); }
  raw(...args: [options?: RawOptions]): this { return this.chain('raw', args); }
  png(...args: [options?: PngOptions]): this { return this.chain('png', args); }
  jpeg(...args: [options?: JpegOptions]): this { return this.chain('jpeg', args); }
  webp(...args: [options?: WebpOptions]): this { return this.chain('webp', args); }

  toBuffer(options?: { resolveWithObject: false }): Promise<Buffer>;
  toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: OutputInfo }>;
  toBuffer(...args: [options?: { resolveWithObject: boolean }]): Promise<Buffer | { data: Buffer; info: OutputInfo }> {
    return run(this.input, this.steps, { method: 'toBuffer', args });
  }

  toFile(...args: [fileOut: string]): Promise<OutputInfo> { return run(this.input, this.steps, { method: 'toFile', args }); }
  metadata(): Promise<Metadata> { return run(this.input, this.steps, { method: 'metadata', args: [] }); }
  stats(): Promise<Stats> { return run(this.input, this.steps, { method: 'stats', args: [] }); }
}

function sharp(options?: SharpOptions): BundledNodeSharp;
function sharp(input: SharpInput, options?: SharpOptions): BundledNodeSharp;
function sharp(...input: unknown[]): BundledNodeSharp {
  return new BundledNodeSharp(input);
}

export default sharp;
