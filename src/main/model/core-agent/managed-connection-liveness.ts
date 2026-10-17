/**
 * Connection liveness for Orkas managed-model requests.
 *
 * A half-open connection (proxy/VPN node switch, network change) delivers no
 * bytes and no close, which is indistinguishable from a model that is still
 * thinking when only parsed SDK events are observed. Orkas Server targets
 * headers or a controlled error with a 90s relay-opening budget, then
 * writes an SSE keepalive comment every 45s that the SDK discards. Watching raw
 * bytes here separates the two cases:
 *
 * - no response headers within MANAGED_HEADER_TIMEOUT_MS, or
 * - no byte at all (keepalives included) for MANAGED_BODY_IDLE_TIMEOUT_MS
 *   on an event stream
 *
 * fails the request with an undici-style transport timeout code, so the
 * existing retry/rotation owner handles it exactly like any other dropped
 * connection. User cancellation keeps its own abort semantics. The Agent idle
 * budget and retry policy are unchanged.
 */
import { createLogger } from '../../logger';

const log = createLogger('managed-connection-liveness');

/** Server opening budget (90s) plus nominal upload/preparation margin. */
export const MANAGED_HEADER_TIMEOUT_MS = 105_000;
/** Three Server keepalive intervals (45s). */
export const MANAGED_BODY_IDLE_TIMEOUT_MS = 135_000;

function transportTimeout(code: 'UND_ERR_HEADERS_TIMEOUT' | 'UND_ERR_BODY_TIMEOUT', message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function withManagedConnectionLiveness(next: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const callerSignal = init?.signal ?? undefined;
    if (callerSignal?.aborted) return next(input, init);
    const controller = new AbortController();
    let failure: Error | undefined;
    const forwardAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', forwardAbort, { once: true });
    const detach = () => callerSignal?.removeEventListener('abort', forwardAbort);
    const fail = (error: Error) => {
      if (failure || controller.signal.aborted) return;
      failure = error;
      log.warn('managed model connection considered lost', { error_code: (error as { code?: string }).code });
      controller.abort(error);
    };

    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    let response: Response;
    try {
      response = await new Promise<Response>((resolve, reject) => {
        headerTimer = setTimeout(() => {
          fail(transportTimeout('UND_ERR_HEADERS_TIMEOUT', 'Orkas model response headers did not arrive'));
          reject(failure);
        }, MANAGED_HEADER_TIMEOUT_MS);
        next(input, { ...init, signal: controller.signal }).then(resolve, reject);
      });
    } catch (error) {
      detach();
      throw failure ?? error;
    } finally {
      clearTimeout(headerTimer);
    }

    const isEventStream = response.headers.get('content-type')?.toLowerCase().includes('text/event-stream');
    if (!response.body) {
      detach();
      return response;
    }

    const reader = response.body.getReader();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = () => {
      settled = true;
      clearTimeout(idleTimer);
      detach();
    };
    const arm = () => {
      if (!isEventStream) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled) return;
        fail(transportTimeout('UND_ERR_BODY_TIMEOUT', 'Orkas model stream stopped sending data'));
        finish();
        stream.error(failure);
        void reader.cancel(failure).catch(() => {});
      }, MANAGED_BODY_IDLE_TIMEOUT_MS);
    };
    const body = new ReadableStream<Uint8Array>({
      start(controllerForStream) {
        stream = controllerForStream;
        arm();
      },
      async pull() {
        try {
          const part = await reader.read();
          if (settled) return;
          if (part.done) {
            finish();
            stream.close();
            return;
          }
          arm();
          stream.enqueue(part.value);
        } catch (error) {
          if (settled) return;
          finish();
          stream.error(failure ?? error);
        }
      },
      async cancel(reason) {
        finish();
        await reader.cancel(reason).catch(() => {});
      },
    }, { highWaterMark: 0 });
    const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    for (const name of ['url', 'redirected', 'type'] as const) Object.defineProperty(observed, name, { value: response[name] });
    return observed;
  };
}
