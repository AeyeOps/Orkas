import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getAgent: vi.fn(), info: vi.fn(), upgrade: vi.fn() }));
vi.mock('../../../src/main/features/agents', () => ({
  isValidAgentId: (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id),
  getAgent: mocks.getAgent,
}));
vi.mock('../../../src/main/features/local_agents/upgrade', () => ({ getCliUpgradeInfo: mocks.info, upgradeLocalCli: mocks.upgrade }));
import { invokeHandlers } from '../../../src/main/ipc/local_agents';
beforeEach(() => { vi.resetAllMocks(); mocks.upgrade.mockResolvedValue({ ok: true }); mocks.info.mockResolvedValue({ can_upgrade: true }); });
describe('CLI upgrade IPC authority', () => {
  it.each(['localAgents.upgrade', 'localAgents.upgradeInfo'] as const)('rejects invalid targets before %s', async channel => {
    await expect(invokeHandlers[channel]({ type: 'unknown' })).rejects.toThrow('invalid CLI type');
    await expect(invokeHandlers[channel]({ agent_id: '../agent', type: 'codex' })).rejects.toThrow('invalid agent_id');
    mocks.getAgent.mockResolvedValue({ runtime: { kind: 'in_process' } });
    await expect(invokeHandlers[channel]({ agent_id: 'ordinary' })).rejects.toThrow('invalid CLI Agent');
    expect(mocks.info).not.toHaveBeenCalled(); expect(mocks.upgrade).not.toHaveBeenCalled();
  });
  it.each(['claude', 'codex', 'opencode', 'openclaw', 'hermes'])('uses the current %s Agent binding and ignores supplied command targets', async cli => {
    mocks.getAgent.mockResolvedValue({ runtime: { kind: 'cli', cli } });
    await invokeHandlers['localAgents.upgrade']({ agent_id: 'saved_agent', type: 'codex', path: '/other', command: 'unsafe' } as any);
    expect(mocks.upgrade).toHaveBeenCalledExactlyOnceWith(cli);
  });
  it.each(['claude', 'codex', 'opencode', 'openclaw', 'hermes'])('routes machine-scoped maintenance to exactly %s', async cli => {
    await invokeHandlers['localAgents.upgradeInfo']({ type: cli });
    await invokeHandlers['localAgents.upgrade']({ type: cli });
    expect(mocks.info).toHaveBeenCalledExactlyOnceWith(cli);
    expect(mocks.upgrade).toHaveBeenCalledExactlyOnceWith(cli);
    expect(mocks.getAgent).not.toHaveBeenCalled();
  });
});
