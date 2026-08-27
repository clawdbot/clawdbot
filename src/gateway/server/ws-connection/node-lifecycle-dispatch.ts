const NODE_LIFECYCLE_METHODS = new Set(["node.invoke.progress", "node.invoke.result"]);

export const NODE_LIFECYCLE_DISPATCH_DRAIN_TIMEOUT_MS = 1_000;

/**
 * Tracks admitted node progress/result requests so physical disconnect cleanup
 * drains their existing work before retiring invokes. It does not add a queue.
 */
export class GatewayNodeLifecycleDispatchTracker {
  private active = new Set<Promise<void>>();

  hasActive(): boolean {
    return this.active.size > 0;
  }

  dispatch(method: string, run: () => Promise<void>): Promise<void> {
    const execution = run();
    if (!NODE_LIFECYCLE_METHODS.has(method)) {
      return execution;
    }
    const settled = execution.then(
      () => undefined,
      () => undefined,
    );
    this.active.add(settled);
    void settled.finally(() => {
      this.active.delete(settled);
    });
    return execution;
  }

  async drain(timeoutMs = NODE_LIFECYCLE_DISPATCH_DRAIN_TIMEOUT_MS): Promise<boolean> {
    const deadlineAt = Date.now() + Math.max(0, timeoutMs);
    while (this.active.size > 0) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        return false;
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol("node-lifecycle-dispatch-timeout");
      const result = await Promise.race([
        Promise.allSettled(this.active),
        new Promise<typeof timedOut>((resolve) => {
          timeout = setTimeout(() => resolve(timedOut), remainingMs);
        }),
      ]);
      if (timeout) {
        clearTimeout(timeout);
      }
      if (result === timedOut) {
        return false;
      }
    }
    return true;
  }
}
