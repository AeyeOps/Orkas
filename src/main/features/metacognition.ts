/**
 * Metacognition persistence — per-agent self-assessment (COMPETENCE.md)
 * and learning strategies (LEARNING_STRATEGIES.md).
 *
 * Storage (follows the agent directory layout, lives at `<uid>/cloud/agents/<aid>/meta/`):
 *   <uid>/cloud/agents/<aid>/meta/COMPETENCE.md          — free-form markdown
 *   <uid>/cloud/agents/<aid>/meta/LEARNING_STRATEGIES.md — free-form markdown
 *   <uid>/cloud/agents/_default/meta/...                 — for unbound conversations
 *
 * Deleting an agent → `agents.deleteCustomAgent` runs `rm -rf agents/<aid>/`
 * directly, so the `meta/` subdirectory disappears with it; `purgeAgent`
 * remains as an explicit cleanup entry point (used by tests / recovery).
 *
 * Unlike memory.ts (which uses §-separated entries), metacognition files
 * are free-form markdown that the agent writes and reads as a whole.
 * The agent structures them with ## headings internally.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentCompetenceFile, agentStrategiesFile, agentMetaDir } from '../paths';
import { writeTextAtomicSync } from '../storage';
import { createLogger } from '../logger';
import { scanForInjection, memoryRejectionError } from './memory';
import { getActiveUserId } from './users';
import { getMetacognitionEnabledForUser } from './config';
import {
  COMPETENCE_CHAR_LIMIT, STRATEGIES_CHAR_LIMIT, mergeMetacognition,
  publishMetacognition, readSmallText, retainMetacognitionDraft,
} from './metacognition-state';
export { COMPETENCE_CHAR_LIMIT, STRATEGIES_CHAR_LIMIT } from './metacognition-state';

const log = createLogger('metacognition');

/** Sentinel agent id for conversations not bound to a specific agent. */
export const DEFAULT_AGENT_ID = '_default';

// ── Constants ────────────────────────────────────────────────────────────
type Target = 'competence' | 'strategies';
type Review = { snapshots: Record<Target, string | null>; deferred: Set<Target>; onDeferred?: (pending: boolean) => void };
const reviewKey = Symbol.for('orkas.metacognition-reviews');
const reviewRoot = globalThis as typeof globalThis & { [reviewKey]?: Map<string, Review> };
const reviews = reviewRoot[reviewKey] ??= new Map<string, Review>();
const reviewId = (uid: string, agentId: string) => JSON.stringify([uid, normalizeAgentId(agentId)]);

/** The same snapshots feed the unchanged review prompt and guard its writes.
 * Shared across host adapters; lifecycle is owned by the reflection lease. */
export function beginMetacognitionReview(uid: string, agentId: string, onDeferred?: (pending: boolean) => void) {
  const key = reviewId(uid, agentId);
  if (reviews.has(key)) throw new Error('metacognition review already active');
  const review: Review = { snapshots: {
    competence: readSmallText(fileForTargetForUser(uid, agentId, 'competence')),
    strategies: readSmallText(fileForTargetForUser(uid, agentId, 'strategies')),
  }, deferred: new Set(), onDeferred };
  reviews.set(key, review);
  return {
    competence: review.snapshots.competence?.trim() ?? '',
    strategies: review.snapshots.strategies?.trim() ?? '',
    hasDeferredWrites: () => review.deferred.size > 0,
    close: () => { if (reviews.get(key) === review) reviews.delete(key); },
  };
}

// ── Feature gate (single source of truth) ────────────────────────────────
// Master switch for metacognition / self-evolution. Two layers ANDed together:
//   1. env `ORKAS_METACOGNITION='0'` — dev/CI kill switch, hard off.
//   2. user preference `preferences.json::metacognition_enabled` — UI setting;
//      undefined (never written) → treated as on, preserving historical default.
// runner.ts and reflection-orchestrator.ts both read from here; don't sprinkle the
// env check around again.
export function isFeatureEnabled(): boolean {
  return isFeatureEnabledForUser(getActiveUserId());
}

/** Account-explicit feature gate for background/model work. */
export function isFeatureEnabledForUser(uid: string): boolean {
  if (process.env.ORKAS_METACOGNITION === '0') return false;
  return getMetacognitionEnabledForUser(uid);
}

// ── Types ────────────────────────────────────────────────────────────────
export interface MetacognitionOpResult {
  ok: boolean;
  error?: string;
  content: string;
  usage: { current: number; limit: number };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Normalize empty/undefined agent id to the default sentinel. */
function normalizeAgentId(agentId: string | undefined | null): string {
  return agentId || DEFAULT_AGENT_ID;
}

function fileForTargetForUser(uid: string, agentId: string, target: 'competence' | 'strategies'): string {
  const id = normalizeAgentId(agentId);
  return target === 'competence' ? agentCompetenceFile(uid, id) : agentStrategiesFile(uid, id);
}

function limitForTarget(target: 'competence' | 'strategies'): number {
  return target === 'competence' ? COMPETENCE_CHAR_LIMIT : STRATEGIES_CHAR_LIMIT;
}

// ── Public API ───────────────────────────────────────────────────────────

/** Read the full content of a metacognition file. */
export function readContent(agentId: string, target: 'competence' | 'strategies'): MetacognitionOpResult {
  return readContentForUser(getActiveUserId(), agentId, target);
}

/** Read metacognition for an explicit account.
 *
 * Use this from asynchronous work that can outlive the active account. */
export function readContentForUser(
  uid: string,
  agentId: string,
  target: 'competence' | 'strategies',
): MetacognitionOpResult {
  const filePath = fileForTargetForUser(uid, agentId, target);
  const limit = limitForTarget(target);
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    // File doesn't exist yet — that's fine
  }
  return {
    ok: true,
    content,
    usage: { current: content.length, limit },
  };
}

/** Write (replace) the full content of a metacognition file. */
export function writeContent(agentId: string, target: 'competence' | 'strategies', content: string): MetacognitionOpResult {
  return writeContentForUser(getActiveUserId(), agentId, target, content);
}

/** Replace metacognition for an explicit account. */
export function writeContentForUser(
  uid: string,
  agentId: string,
  target: 'competence' | 'strategies',
  content: string,
): MetacognitionOpResult {
  const trimmed = content.trim();
  const limit = limitForTarget(target);
  const id = normalizeAgentId(agentId);

  if (!trimmed) {
    return { ok: false, error: 'empty content', content: '', usage: { current: 0, limit } };
  }

  // Security scan
  const threat = scanForInjection(trimmed);
  if (threat) {
    log.warn('blocked metacognition write', { threat, chars: trimmed.length });
    return {
      ok: false,
      error: memoryRejectionError(trimmed, threat),
      content: '',
      usage: { current: 0, limit },
    };
  }

  // Reject oversize writes so the LLM sees the overflow and condenses,
  // instead of silently losing the tail of its self-assessment. The tool
  // description already tells the LLM the limit — this is the safety net.
  if (trimmed.length > limit) {
    log.warn(`${target} write rejected for agent ${id}: ${trimmed.length} > ${limit}`);
    return {
      ok: false,
      error: `content exceeds limit: ${trimmed.length}/${limit} chars — condense and retry`,
      content: '',
      usage: { current: trimmed.length, limit },
    };
  }

  const filePath = fileForTargetForUser(uid, agentId, target);
  const relPath = `cloud/agents/${id}/meta/${target === 'competence' ? 'COMPETENCE' : 'LEARNING_STRATEGIES'}.md`;
  const review = reviews.get(reviewId(uid, agentId));
  const current = readSmallText(filePath);
  const base = review?.snapshots[target] ?? null;
  const final = review && current !== base
    ? mergeMetacognition(relPath, base, current ?? '', trimmed)
    : trimmed;
  const defer = (): MetacognitionOpResult => {
    review?.deferred.add(target);
    review?.onDeferred?.(true);
    retainMetacognitionDraft(uid, relPath, base, trimmed);
    return { ok: false, error: 'notes changed during reflection; candidate retained; no update committed',
      content: '', usage: { current: current?.length ?? 0, limit } };
  };
  // A concurrent deletion is an intentional state change, not an empty base.
  if (final === null || (review && base !== null && current === null)) return defer();
  const mergedThreat = final === trimmed ? null : scanForInjection(final);
  if (mergedThreat) return defer();
  if (!publishMetacognition(uid, relPath, current, final)) return defer();
  if (review) {
    review.snapshots[target] = final;
    review.deferred.delete(target);
    review.onDeferred?.(review.deferred.size > 0);
  }

  log.info(`updated ${target} for agent ${id} (${final.length}/${limit} chars)`);

  return {
    ok: true,
    content: final,
    usage: { current: final.length, limit },
  };
}

/** Clear a metacognition file. */
export function clearContent(agentId: string, target: 'competence' | 'strategies'): void {
  clearContentForUser(getActiveUserId(), agentId, target);
}

/** Clear metacognition for an explicit account. */
export function clearContentForUser(
  uid: string,
  agentId: string,
  target: 'competence' | 'strategies',
): void {
  const filePath = fileForTargetForUser(uid, agentId, target);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeTextAtomicSync(filePath, '');
  } catch (err) {
    log.warn(`clearContent(${target}) failed: ${(err as Error).message}`);
  }
}

/** Remove all metacognition data for an agent (used on agent deletion). */
export function purgeAgent(agentId: string): void {
  purgeAgentForUser(getActiveUserId(), agentId);
}

/** Remove all metacognition data for one agent in an explicit account. */
export function purgeAgentForUser(uid: string, agentId: string): void {
  const dir = agentMetaDir(uid, normalizeAgentId(agentId));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    log.info(`purged metacognition for agent ${agentId}`);
  } catch (err) {
    log.warn(`purgeAgent(${agentId}) failed: ${(err as Error).message}`);
  }
}

// ── System prompt formatting ─────────────────────────────────────────────

/**
 * Format metacognition content for system prompt injection.
 * Returns empty string if no content exists for this agent.
 */
export function formatForSystemPrompt(agentId: string): string {
  return formatForSystemPromptForUser(getActiveUserId(), agentId);
}

/** Format metacognition for a model turn owned by an explicit account. */
export function formatForSystemPromptForUser(uid: string, agentId: string): string {
  const comp = readContentForUser(uid, agentId, 'competence');
  const strat = readContentForUser(uid, agentId, 'strategies');

  if (!comp.content && !strat.content) return '';

  const parts: string[] = ['## Metacognition (self-assessment & learning strategies)'];

  if (comp.content) {
    parts.push('### Competence profile (COMPETENCE)');
    parts.push(comp.content);
  }
  if (strat.content) {
    parts.push('### Learning strategies (STRATEGIES)');
    parts.push(strat.content);
  }

  return parts.join('\n\n');
}
