import { describe, it, expect } from 'vitest';

import { createConfig } from '../../../../src/core-agent/src/config';
import {
  maxToolLoopsForActorKind,
  COMMANDER_MAX_TOOL_LOOPS,
  AGENT_MAX_TOOL_LOOPS,
} from '../../../../src/main/features/group_chat/actor-budgets';

// These values pin the per-turn tool-round budgets and deliberately cross-check
// the core-agent schema default so the two policies cannot silently diverge.
describe('actor-budgets › maxToolLoopsForActorKind', () => {
  it('gives the commander the shared 500-round budget', () => {
    expect(maxToolLoopsForActorKind('commander')).toBe(COMMANDER_MAX_TOOL_LOOPS);
    expect(COMMANDER_MAX_TOOL_LOOPS).toBe(500);
  });

  it('pins named agent workers to the current 500-round production budget', () => {
    expect(maxToolLoopsForActorKind('agent')).toBe(AGENT_MAX_TOOL_LOOPS);
    expect(AGENT_MAX_TOOL_LOOPS).toBe(500);
    expect(AGENT_MAX_TOOL_LOOPS).toBe(createConfig().agent.maxToolLoops);
  });

  it('leaves ephemeral workers and users on the 500-round core-agent schema default', () => {
    expect(createConfig().agent.maxToolLoops).toBe(500);
    expect(maxToolLoopsForActorKind('worker')).toBeUndefined();
    expect(maxToolLoopsForActorKind('user')).toBeUndefined();
  });
});
