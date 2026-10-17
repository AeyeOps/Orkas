import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({ warn: mocks.warn, info: mocks.info }) }));
vi.mock('../../../../src/main/features/local_agents/backends/base', async importOriginal => ({
  ...await importOriginal<object>(), spawnCli: mocks.spawn, killProcessTree: mocks.kill,
}));
import { getLocalCliAccountUsage, normalizeAccountUsage } from '../../../../src/main/features/local_agents/account_usage';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const codex = { type: 'codex' as const, path: '/test/codex', version: '0.160.0', available: true };

function fakeCli(reply: (request: any) => any) {
  const requests: any[] = [];
  const child: any = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk)); requests.push(request);
    const response = reply(request);
    if (response) queueMicrotask(() => child.stdout.write(JSON.stringify(response) + '\n'));
    done();
  } });
  mocks.spawn.mockReturnValue(child);
  mocks.kill.mockImplementation((_child, _signal, options) => options?.onComplete?.());
  return { child, requests };
}

describe('CLI account remaining allowance', () => {
  it('uses the authoritative Codex buckets and preserves zero versus unknown', () => {
    const result = normalizeAccountUsage('codex', {
      rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 } },
      rateLimitsByLimitId: { codex: {
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1900000000 },
        secondary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: null },
        accountId: 'PRIVATE', credits: { balance: 'PRIVATE' },
      }, other: { primary: { usedPercent: null, windowDurationMins: 300 } } },
    });
    expect(result.windows).toEqual([
      { label: 'codex', minutes: 300, remaining_percent: 0, resets_at: 1900000000000 },
      { label: 'codex', minutes: 10080, remaining_percent: 83, resets_at: null },
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('reads Claude percentage units and ISO reset times without treating missing values as free quota', () => {
    const result = normalizeAccountUsage('claude', { rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 23, resets_at: '2030-01-01T00:00:00Z' },
      seven_day: { utilization: 0, resets_at: null },
      seven_day_opus: { utilization: null },
      model_scoped: [{ display_name: 'Fable', utilization: 40, resets_at: null }],
    } });
    expect(result.windows).toEqual([
      { label: '', minutes: 300, remaining_percent: 77, resets_at: 1893456000000 },
      { label: '', minutes: 10080, remaining_percent: 100, resets_at: null },
      { label: 'Fable', minutes: 10080, remaining_percent: 60, resets_at: null },
    ]);
    for (const value of [null, '20', NaN, -1]) {
      expect(normalizeAccountUsage('codex', { rateLimits: { primary: { usedPercent: value } } }).status).toBe('unavailable');
    }
    expect(normalizeAccountUsage('claude', { rate_limits_available: false }).status).toBe('unavailable');
  });

  it('queries Codex without starting a thread, coalesces requests and isolates users', async () => {
    const { requests } = fakeCli(request => request.id === 1 ? { id: 1, result: {} }
      : request.id === 2 ? { id: 2, result: { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } } } : null);
    const [a, b] = await Promise.all([
      getLocalCliAccountUsage('coalesce', codex, '/test'),
      getLocalCliAccountUsage('coalesce', codex, '/test'),
    ]);
    expect(a.windows[0].remaining_percent).toBe(75); expect(b).toEqual(a);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(requests.map(r => r.method)).toEqual(['initialize', 'initialized', 'account/rateLimits/read']);
    await getLocalCliAccountUsage('coalesce', codex, '/test');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    await getLocalCliAccountUsage('another-user', codex, '/test');
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.kill).toHaveBeenCalledTimes(2);
  });

  it('queries Claude safely without a user turn or scanning transcript history', async () => {
    const { requests } = fakeCli(r => ({ type: 'control_response', response: {
      request_id: r.request_id, subtype: 'success', response: {
        rate_limits_available: true, rate_limits: { five_hour: { utilization: 20 } },
      },
    } }));
    const result = await getLocalCliAccountUsage('claude-test', { ...codex, type: 'claude', version: '2.1.296' }, '/test');
    expect(result.windows[0].remaining_percent).toBe(80);
    expect(requests).toEqual([{ type: 'control_request', request_id: 'orkas-account-usage', request: { subtype: 'get_usage', skip_behaviors: true } }]);
    expect(mocks.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['--safe-mode', '--strict-mcp-config', '--no-session-persistence']));
  });

  it('does not launch unverified versions or custom invocation profiles', async () => {
    for (const version of ['2.1.295', '2.1.296-beta.1', null]) {
      expect((await getLocalCliAccountUsage('old', { ...codex, type: 'claude', version }, '/test')).status).toBe('unsupported');
    }
    expect((await getLocalCliAccountUsage('old-codex', { ...codex, version: '0.159.0' }, '/test')).status).toBe('unsupported');
    expect((await getLocalCliAccountUsage('custom', codex, '/test', { customArgs: ['--profile', 'other'] })).status).toBe('unsupported');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('cleans up a stalled or oversized reply and allows explicit recovery', async () => {
    vi.useFakeTimers();
    fakeCli(() => null);
    const pending = getLocalCliAccountUsage('timeout', codex, '/test');
    await vi.advanceTimersByTimeAsync(20001);
    expect((await pending).status).toBe('unavailable');
    expect(mocks.kill).toHaveBeenCalled();
    const { child } = fakeCli(() => null);
    const oversized = getLocalCliAccountUsage('timeout', codex, '/test', { force: true });
    child.stdout.write('x'.repeat(256 * 1024 + 1));
    expect((await oversized).status).toBe('unavailable');
    fakeCli(r => r.id === 1 ? { id: 1, result: {} } : r.id === 2 ? { id: 2, result: { rateLimits: { primary: { usedPercent: 0 } } } } : null);
    expect((await getLocalCliAccountUsage('timeout', codex, '/test', { force: true })).windows[0].remaining_percent).toBe(100);
  });

  it('diagnoses a failed launch once without exposing the exception or account path', async () => {
    const privateMessage = 'private-account /private/fixture/token.txt';
    mocks.spawn.mockImplementationOnce(() => { throw new Error(privateMessage); });
    expect((await getLocalCliAccountUsage('diagnostic-launch', codex, '/private/fixture')).status).toBe('unavailable');
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('private');
    expect(mocks.warn.mock.calls[0][1]).toMatchObject({ cli: 'codex', reason_code: 'spawn_failed' });
  });

  it('reports a stalled probe once and suppresses late close diagnostics after cleanup', async () => {
    vi.useFakeTimers();
    const { child } = fakeCli(() => null);
    const request = getLocalCliAccountUsage('diagnostic-timeout', codex, '/test');
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await request).status).toBe('unavailable');
    child.emit('close');
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(mocks.warn.mock.calls[0][1]).toMatchObject({ cli: 'codex', reason_code: 'timeout' });
  });
});
