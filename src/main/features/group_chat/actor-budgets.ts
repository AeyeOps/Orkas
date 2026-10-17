import type { ActorKind } from './state';

/**
 * Per-turn tool-round budgets for dispatched actors, kept out of bus.ts so they
 * are unit-testable and cannot silently drift.
 *
 * Commander and named agents share the core-agent default of 500 rounds.
 * Periodic checkpoints, the hard cap, repeat protection and idle watchdogs
 * bound long-running work. Ephemeral workers inherit the schema default.
 */
export const COMMANDER_MAX_TOOL_LOOPS = 500;
export const AGENT_MAX_TOOL_LOOPS = 500;

/**
 * Per-turn tool-round budget for a dispatched actor, or `undefined` to let
 * core-agent apply its schema default. Pure — pinned by unit tests so the
 * named-agent budget cannot silently drift with the schema default.
 */
export function maxToolLoopsForActorKind(kind: ActorKind): number | undefined {
  if (kind === 'commander') return COMMANDER_MAX_TOOL_LOOPS;
  if (kind === 'agent') return AGENT_MAX_TOOL_LOOPS;
  return undefined; // 'worker' (ephemeral) / 'user' → schema default
}
