import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectLocalChromeHeadlessMode, isChromeCdpReady } from "./chrome.js";
import { createProfileAvailability } from "./server-context.availability.js";
import { beginProfileTransition } from "./server-context.lifecycle.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";
import type { ProfileRuntimeState } from "./server-context.types.js";

vi.mock("./chrome.js", () => ({
  inspectLocalChromeHeadlessMode: vi.fn(),
  isChromeCdpReady: vi.fn(),
  stopOpenClawChrome: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

function createAvailability() {
  const profile = makeBrowserProfile({ attachOnly: true });
  const state = makeBrowserServerState({ profile });
  const runtime: ProfileRuntimeState = { profile, running: null };
  state.profiles.set(profile.name, runtime);
  const availability = createProfileAvailability({
    opts: { getState: () => state },
    profile,
    state: () => state,
    runtime,
    configRevision: 0,
  });
  vi.mocked(isChromeCdpReady).mockImplementation(async (...args) => {
    await args[4]?.onDiagnostic?.({
      ok: true,
      cdpUrl: profile.cdpUrl,
      wsUrl: "ws://127.0.0.1:18800/devtools/browser/synthetic",
      elapsedMs: 1,
    });
    return true;
  });
  return { availability, runtime, state };
}

describe("external browser mode availability", () => {
  it("observes the mode again on the next request after an inconclusive inspection", async () => {
    const { availability, runtime } = createAvailability();
    vi.mocked(inspectLocalChromeHeadlessMode)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(false);

    await expect(availability.isReachable()).resolves.toBe(true);
    await expect(availability.isReachable()).resolves.toBe(true);
    await expect(runtime.externalBrowserMode?.headless).resolves.toBe(false);
    expect(inspectLocalChromeHeadlessMode).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent target requests waiting for the shared mode observation", async () => {
    const { availability } = createAvailability();
    const observation = createDeferred<boolean>();
    const observing = createDeferred<void>();
    vi.mocked(inspectLocalChromeHeadlessMode).mockImplementation(() => {
      observing.resolve();
      return observation.promise;
    });

    const first = availability.isReachable();
    await observing.promise;
    const secondReady = vi.fn();
    const second = availability.isReachable().then(secondReady);
    await vi.waitFor(() => expect(isChromeCdpReady).toHaveBeenCalledTimes(2));
    // Advance a turn so any incorrectly completed second request becomes visible.
    await setImmediate();
    expect(secondReady).not.toHaveBeenCalled();

    observation.resolve(false);
    await Promise.all([first, second]);
    expect(secondReady).toHaveBeenCalledWith(true);
    expect(inspectLocalChromeHeadlessMode).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared observation alive when its first caller cancels", async () => {
    const { availability, runtime } = createAvailability();
    const observation = createDeferred<boolean>();
    const observing = createDeferred<AbortSignal | undefined>();
    vi.mocked(inspectLocalChromeHeadlessMode).mockImplementation(({ signal }) => {
      observing.resolve(signal);
      return observation.promise;
    });
    const caller = new AbortController();
    const first = availability.isReachable(undefined, { signal: caller.signal });
    const rejected = expect(first).rejects.toThrow("cancel first caller");
    const ownerSignal = await observing.promise;
    const second = availability.isReachable();
    caller.abort(new Error("cancel first caller"));
    await rejected;
    expect(ownerSignal?.aborted).toBe(false);

    observation.resolve(false);
    await expect(second).resolves.toBe(true);
    await expect(runtime.externalBrowserMode?.headless).resolves.toBe(false);
    expect(inspectLocalChromeHeadlessMode).toHaveBeenCalledTimes(1);
  });

  it("aborts the observation and clears its cache on a profile transition", async () => {
    const { availability, runtime, state } = createAvailability();
    const observing = createDeferred<void>();
    vi.mocked(inspectLocalChromeHeadlessMode).mockImplementation(({ signal }) => {
      observing.resolve();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new Error("mode observation aborted", { cause: signal.reason })),
          { once: true },
        );
      });
    });
    const pending = availability.isReachable();
    const rejected = expect(pending).rejects.toThrow("mode observation aborted");
    await observing.promise;
    await beginProfileTransition({
      state,
      runtime,
      reason: "test transition",
      closeSharedAdapters: false,
    });
    await rejected;
    expect(runtime.externalBrowserMode).toBeUndefined();
  });
});
