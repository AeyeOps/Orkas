/** Requester-approved minimum for native Orkas chat models; decimal tokens.
 * Unknown legacy metadata retains compatibility; request admission remains
 * authoritative for the complete input and actual output reservation. */
export const MIN_NATIVE_MODEL_CONTEXT_WINDOW = 32_000;

export function modelContextWindowBelowMinimum(window: number | undefined): boolean {
  return typeof window === 'number' && Number.isFinite(window)
    && window < MIN_NATIVE_MODEL_CONTEXT_WINDOW;
}
