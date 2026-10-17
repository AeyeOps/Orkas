import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { LOCALES } from '../../src/main/i18n';

const root = path.resolve(__dirname, '../../src/renderer');
function harness() {
  const section = { hidden: true };
  const slot = { innerHTML: '', querySelector: () => null };
  const pending: Array<(v: any) => void> = [];
  const failures: Array<(error: Error) => void> = [];
  const warn = vi.fn();
  const calls: any[] = [];
  const context = vm.createContext({
    document: { getElementById: (id: string) => id.endsWith('-section') ? section : slot },
    window: { orkas: { invoke: (...args: any[]) => { calls.push(args); return new Promise((r, reject) => { pending.push(r); failures.push(reject); }); } } },
    createLogger: () => ({ warn }),
    escapeHtml: (v: any) => String(v).replaceAll('<', '&lt;'),
    getLang: () => 'en',
    t: (key: string, vars: any = {}) => key + JSON.stringify(vars),
    Date, Intl,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'modules/cli-account-usage.js'), 'utf8'), context);
  return { section, slot, pending, failures, warn, calls, render: (agent: any) => context.renderCliAccountUsage(agent) };
}
const agent = (id: string, cli = 'codex') => ({ agent_id: id, runtime: { kind: 'cli', cli } });
const reply = (remaining: number) => ({ usage: { status: 'ready', checked_at: 1900000000000, windows: [
  { label: '<img>', minutes: 300, remaining_percent: remaining, resets_at: 1900000000000 },
] } });

describe('CLI account allowance detail', () => {
  it('shows only quota and reset details and rechecks when details are rendered again', async () => {
    const h = harness(); const render = h.render(agent('one'));
    expect(h.slot.innerHTML).toContain('common.loading');
    h.pending.shift()!(reply(83)); await render;
    expect(h.slot.innerHTML).toContain('83%');
    expect(h.slot.innerHTML).toContain('agents.cli_usage_resets');
    expect(h.slot.innerHTML).toContain('&lt;img>');
    expect(h.slot.innerHTML).not.toContain('<img>');
    expect(h.slot.innerHTML).not.toContain('agents.cli_usage_shared');
    expect(h.slot.innerHTML).not.toContain('agents.cli_usage_checked');
    expect(h.slot.innerHTML).not.toContain('<button');
    const reopened = h.render(agent('one'));
    expect(h.calls[1]).toEqual(['localAgents.accountUsage', { agent_id: 'one', force: false }]);
    h.pending.shift()!({ usage: { status: 'unavailable', windows: [] } }); await reopened;
    expect(h.slot.innerHTML).toContain('agents.cli_usage_unavailable');
    expect(h.slot.innerHTML).not.toContain('83%');
  });

  it('ignores a late response after switching agents or leaving CLI details', async () => {
    const h = harness(); const first = h.render(agent('one')); const second = h.render(agent('two', 'claude'));
    h.pending[1](reply(20)); await second;
    h.pending[0](reply(99)); await first;
    expect(h.slot.innerHTML).toContain('20%'); expect(h.slot.innerHTML).not.toContain('99%');
    const third = h.render(agent('three'));
    await h.render({ agent_id: 'ordinary', runtime: { kind: 'in_process' } });
    h.pending[2](reply(50)); await third;
    expect(h.section.hidden).toBe(true); expect(h.slot.innerHTML).toBe('');
  });

  it('localizes all visible quota states in every registered locale', () => {
    for (const { code } of LOCALES) {
      const table = JSON.parse(fs.readFileSync(path.join(root, 'locales', code + '.json'), 'utf8'));
      for (const key of ['title', 'unavailable', 'unsupported', 'resets', 'hours', 'days', 'window']) {
        expect(table['agents.cli_usage_' + key], code + ':' + key).toBeTruthy();
      }
      expect(table['agents.cli_usage_shared']).toBeUndefined();
      expect(table['agents.cli_usage_checked']).toBeUndefined();
      if (code === 'zh') expect(table['agents.cli_usage_title']).toBe('剩余额度');
    }
  });

  it('logs a rejected IPC safely while keeping the unavailable recovery state', async () => {
    const h = harness();
    const render = h.render(agent('one'));
    h.failures[0](new Error('private-account /private/fixture/token.txt'));
    await render;
    expect(h.slot.innerHTML).toContain('agents.cli_usage_unavailable');
    expect(h.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('private');
  });
});
