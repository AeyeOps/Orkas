/** Observe real host calls, never accept receipts written by generated code. */
export async function observeWebAppCalls() {
  const { WebAppRuntime } = await import('../../../src/main/features/web_apps/runtime');
  const original = WebAppRuntime.prototype.call;
  const calls: Array<{method:string;ok:boolean;code?:string}> = [];
  WebAppRuntime.prototype.call = async function (...args: Parameters<typeof original>) {
    try { const result = await original.apply(this,args); calls.push({method:args[4],ok:true}); return result; }
    catch (error) { calls.push({method:args[4],ok:false,code:(error as any).code || 'E_FAILED'}); throw error; }
  };
  return { read:() => [...calls], restore:() => { WebAppRuntime.prototype.call = original; } };
}

/** Model availability is a simulated host prerequisite; the real runtime still
 * owns capability checks, rejection, SDK delivery and explicit retry. */
let restoreModelAvailability: (() => boolean) | undefined;
export async function setWebAppModelAvailable(available: boolean) {
  const { runtime } = await import('../../../src/main/features/web_apps/host');
  const host = (runtime as any).host;
  if (!restoreModelAvailability) restoreModelAvailability = host.modelAvailable;
  host.modelAvailable = available ? restoreModelAvailability : () => false;
}
