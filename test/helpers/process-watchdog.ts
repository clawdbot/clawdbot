import { vi } from "vitest";
import { createDeferred } from "./promise.js";

export function startProcessWatchdogFixture<T>(start: () => Promise<T>) {
  const ready = createDeferred();
  const schedule = globalThis.setTimeout;
  // Release only after a child-owned PID confirms its signal handlers are installed.
  // Gate only the initial watchdog, returning its native handle. Restore before
  // yielding so readiness polling, grace timers, and concurrent tests stay real.
  const timeoutSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementationOnce((callback, ms, ...args) =>
      schedule(() => {
        void ready.promise.then(() => callback(...args));
      }, ms),
    );
  try {
    const completion = start();
    return function releaseAndWait() {
      ready.resolve();
      return completion;
    };
  } finally {
    timeoutSpy.mockRestore();
  }
}
