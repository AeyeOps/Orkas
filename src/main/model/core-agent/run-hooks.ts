/** Reply activity counter shared by the runner and the desktop idle guard. */
let activeRuns = 0;

export function activeAgentRunCount(): number {
  return activeRuns;
}

export function notifyAgentRunStarted(): void {
  activeRuns += 1;
}

export function notifyAgentRunFinished(): void {
  activeRuns = Math.max(0, activeRuns - 1);
}
