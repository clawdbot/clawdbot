// Browser tests cover cancellation while waiting on the per-profile lifecycle barrier.
import { describe, expect, it, vi } from "vitest";
import {
  enqueueProfileStart,
  getOrCreateProfileRuntime,
  withProfileOperationLease,
} from "./server-context.lifecycle.js";
import { makeBrowserProfile } from "./server-context.test-harness.js";
import type { BrowserServerState } from "./server-context.types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("profile lifecycle barrier cancellation", () => {
  it("stops waiting when the caller aborts without cancelling the lifecycle owner", async () => {
    const profile = makeBrowserProfile();
    const state = {
      resolved: { profiles: { [profile.name]: profile } },
      profiles: new Map(),
    } as unknown as BrowserServerState;
    const runtime = getOrCreateProfileRuntime(state, profile);
    const startGate = deferred<void>();
    const startEntered = deferred<void>();
    const start = enqueueProfileStart({
      state,
      runtime,
      configRevision: 0,
      key: "stuck-start",
      run: async () => {
        startEntered.resolve();
        await startGate.promise;
      },
    });
    await startEntered.promise;

    const abort = new AbortController();
    const run = vi.fn(async () => "never");
    const operation = withProfileOperationLease({
      state,
      runtime,
      configRevision: 0,
      signal: abort.signal,
      run,
    });
    const reason = new Error("browser request timed out");
    abort.abort(reason);

    await expect(operation).rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled();

    startGate.resolve();
    await expect(start).resolves.toBeUndefined();
  });
});
