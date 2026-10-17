interface ShutdownTask {
  name: string;
  run: () => void | Promise<void>;
}

/** Start and await each local durability task exactly once before exit. */
export function createShutdownCoordinator({ localTasks, onFailure }: {
  localTasks: readonly ShutdownTask[];
  onFailure: (name: string) => void;
}) {
  let pending: Promise<void> | null = null;
  let complete = false;
  const run = async (task: ShutdownTask) => {
    try { await task.run(); }
    catch { onFailure(task.name); }
  };
  return {
    get complete() { return complete; },
    prepare(): Promise<void> {
      if (pending) return pending;
      // Publish the shared promise before any cleanup can synchronously emit
      // another quit (for example while Electron loads a native module).
      pending = Promise.resolve().then(async () => {
        // Start every local save/close even if another one is slow or fails.
        await Promise.all(localTasks.map(run));
      }).finally(() => { complete = true; });
      return pending;
    },
  };
}
