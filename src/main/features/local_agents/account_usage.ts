/** Read-only account allowance probes. No user messages, model calls, transcript
 * scans, credential extraction, or account data persisted to disk. The Claude
 * control response is experimental; reject missing fields rather than inventing
 * quota. Verified against Codex 0.160.0 and Claude Code 2.1.296. */
import { spawnCli, killProcessTree, LineSplitter } from './backends/base.js';
import { cliVersionAtLeast } from './version.js';
import type { LocalCliEntry } from './registry.js';
import { createLogger } from '../../logger.js';

const log = createLogger('local-agents:account-usage');

export interface AccountUsageWindow {
  label: string;
  minutes: number | null;
  remaining_percent: number;
  resets_at: number | null;
}
export interface LocalCliAccountUsage {
  status: 'ready' | 'unavailable' | 'unsupported';
  windows: AccountUsageWindow[];
  checked_at: number;
}
const cache = new Map<string, LocalCliAccountUsage>();
const inFlight = new Map<string, Promise<LocalCliAccountUsage>>();
const empty = (status: LocalCliAccountUsage['status']): LocalCliAccountUsage => ({ status, windows: [], checked_at: Date.now() });
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const positive = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const label = (value: unknown): string => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : '';

export function normalizeAccountUsage(cli: string, value: unknown): LocalCliAccountUsage {
  const data = object(value);
  const windows: AccountUsageWindow[] = [];
  const add = (name: string, minutes: number | null, used: unknown, reset: unknown) => {
    if (windows.length >= 16 || typeof used !== 'number' || !Number.isFinite(used) || used < 0) return;
    const resets = positive(reset);
    windows.push({ label: label(name), minutes, remaining_percent: Math.max(0, 100 - used),
      resets_at: resets && resets <= 8640000000000000 ? resets : null });
  };
  if (cli === 'codex') {
    const buckets = object(data.rateLimitsByLimitId);
    const rows = Object.keys(buckets).length ? Object.entries(buckets).slice(0, 16) : [['', data.rateLimits]];
    for (const [id, raw] of rows) {
      const bucket = object(raw);
      for (const key of ['primary', 'secondary']) {
        const window = object(bucket[key]);
        add(bucket.limitName || bucket.limitId || id, positive(window.windowDurationMins), window.usedPercent,
          positive(window.resetsAt) ? window.resetsAt * 1000 : null);
      }
    }
  } else if (cli === 'claude' && data.rate_limits_available === true) {
    const limits = object(data.rate_limits);
    const addClaude = (name: string, minutes: number, raw: unknown) => {
      const window = object(raw);
      add(name, minutes, window.utilization, typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : null);
    };
    addClaude('', 300, limits.five_hour);
    addClaude('', 10080, limits.seven_day);
    // Prefer the dynamic model-scoped rows when present; legacy versions report
    // fixed Opus/Sonnet windows instead. No arbitrary fields cross IPC.
    if (Array.isArray(limits.model_scoped) && limits.model_scoped.length) {
      for (const row of limits.model_scoped.slice(0, 14)) addClaude(label(object(row).display_name), 10080, row);
    } else {
      addClaude('Opus', 10080, limits.seven_day_opus);
      addClaude('Sonnet', 10080, limits.seven_day_sonnet);
    }
  }
  return { status: windows.length ? 'ready' : 'unavailable', windows, checked_at: Date.now() };
}

function probe(entry: LocalCliEntry, cwd: string): Promise<LocalCliAccountUsage> {
  log.info('CLI account allowance probe started', { cli: entry.type });
  return new Promise(resolve => {
    const isCodex = entry.type === 'codex';
    const args = isCodex ? ['app-server', '--listen', 'stdio://'] : [
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
    ];
    let child: ReturnType<typeof spawnCli>;
    try { child = spawnCli(entry.path!, args, cwd); } catch {
      log.warn('CLI account allowance probe unavailable', { cli: entry.type, reason_code: 'spawn_failed' });
      resolve(empty('unavailable')); return;
    }
    let settled = false;
    let bytes = 0;
    let initialized = false;
    const splitter = new LineSplitter();
    const timer = setTimeout(() => finish(empty('unavailable'), false, 'timeout'), 20_000);
    timer.unref?.();
    const finish = (result: LocalCliAccountUsage, closed = false, reason: 'probe_failed' | 'timeout' | 'output_limit' = 'probe_failed') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result.status === 'unavailable') {
        log.warn('CLI account allowance probe unavailable', { cli: entry.type, reason_code: reason });
      }
      if (closed) resolve(result);
      else killProcessTree(child, 'SIGKILL', { onComplete: () => resolve(result) });
    };
    const send = (message: object) => {
      if (settled) return;
      try { child.stdin.write(JSON.stringify(message) + '\n'); } catch { finish(empty('unavailable')); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 256 * 1024) return finish(empty('unavailable'), false, 'output_limit');
      splitter.push(String(chunk), line => {
        if (settled) return;
        let message: any;
        try { message = JSON.parse(line); } catch { return; }
        if (isCodex) {
          if (message?.id === 1 && !initialized) {
            if (message.error) return finish(empty('unavailable'));
            initialized = true;
            send({ method: 'initialized' });
            send({ id: 2, method: 'account/rateLimits/read' });
          } else if (message?.id === 2 && initialized) {
            finish(message.error ? empty('unavailable') : normalizeAccountUsage('codex', message.result));
          }
        } else if (message?.type === 'control_response' && message.response?.request_id === 'orkas-account-usage') {
          finish(message.response.subtype === 'success'
            ? normalizeAccountUsage('claude', message.response.response) : empty('unavailable'));
        }
      });
    });
    // Drain and cap diagnostics without storing or exposing raw provider output.
    child.stderr.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 256 * 1024) finish(empty('unavailable'), false, 'output_limit');
    });
    child.stdin.on('error', () => finish(empty('unavailable')));
    child.on('error', () => finish(empty('unavailable')));
    child.on('close', () => finish(empty('unavailable'), true));
    send(isCodex ? { id: 1, method: 'initialize', params: { clientInfo: { name: 'orkas', version: '1.0.0' } } }
      : { type: 'control_request', request_id: 'orkas-account-usage', request: { subtype: 'get_usage', skip_behaviors: true } });
  });
}

export async function getLocalCliAccountUsage(
  userId: string, entry: LocalCliEntry, cwd: string,
  options: { force?: boolean; customArgs?: readonly string[] } = {},
): Promise<LocalCliAccountUsage> {
  const minimum = entry.type === 'codex' ? '0.160.0' : entry.type === 'claude' ? '2.1.296' : null;
  // Custom arguments can select another profile/provider. Never show the
  // default account's allowance as if it belonged to that invocation.
  if (!minimum || options.customArgs?.length || !cliVersionAtLeast(entry.fullVersion || entry.version, minimum)) return empty('unsupported');
  if (!entry.available || !entry.path) return empty('unavailable');
  const key = JSON.stringify([userId, entry.type, entry.path, entry.fullVersion || entry.version, cwd]);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const cached = cache.get(key);
  if (!options.force && cached && Date.now() - cached.checked_at < 30_000) return cached;
  if (inFlight.size >= 8) return empty('unavailable');
  const request = probe(entry, cwd).then(result => {
    cache.delete(key);
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return result;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}
