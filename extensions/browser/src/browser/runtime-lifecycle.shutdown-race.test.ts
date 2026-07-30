// Browser tests cover runtime shutdown against deferred profile starts.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningChrome } from "./chrome.js";
import { makeBrowserProfile } from "./server-context.test-harness.js";
import type { BrowserServerState } from "./server-context.types.js";

const mocks = vi.hoisted(() => ({
  closeChromeMcpSession: vi.fn(async () => false),
  stopOpenClawChrome: vi.fn(async (_running: RunningChrome) => {}),
}));

vi.mock("./chrome.js", () => ({
  stopOpenClawChrome: mocks.stopOpenClawChrome,
}));

vi.mock("./chrome-mcp.runtime.js", () => ({
  getChromeMcpModule: async () => ({
    closeChromeMcpSession: mocks.closeChromeMcpSession,
  }),
}));

vi.mock("./pw-ai-module.js", () => ({
  getLoadedPwAiModule: () => null,
  getPwAiModule: async () => null,
}));

const { stopBrowserBridgeRuntime } = await import("./runtime-lifecycle.js");
const {
  enqueueProfileStart,
  getProfileLifecycle,
  getOrCreateProfileRuntime,
  registerProfileHandle,
} = await import("./server-context.lifecycle.js");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeRunning(pid: number): RunningChrome {
  return {
    pid,
    exe: { kind: "chromium", path: "/usr/bin/chromium" },
    userDataDir: `/tmp/profile-${pid}`,
    cdpPort: 18_800 + pid,
    startedAt: Date.now(),
    proc: new EventEmitter() as unknown as ChildProcessWithoutNullStreams,
  };
}

beforeEach(() => {
  mocks.closeChromeMcpSession.mockReset().mockResolvedValue(false);
  mocks.stopOpenClawChrome.mockReset().mockResolvedValue(undefined);
});

describe("browser runtime shutdown profile races", () => {
  it("invalidates every deferred start before draining late children and clearing state", async () => {
    const profiles = [
      makeBrowserProfile({ name: "alpha", cdpPort: 18_801 }),
      makeBrowserProfile({ name: "beta", cdpPort: 18_802 }),
    ];
    const state = {
      port: 18_791,
      resolved: {
        profiles: Object.fromEntries(profiles.map((profile) => [profile.name, profile])),
      },
      profiles: new Map(),
    } as unknown as BrowserServerState;
    const runtimes = profiles.map((profile) => getOrCreateProfileRuntime(state, profile));
    const launches = [deferred<RunningChrome>(), deferred<RunningChrome>()];
    const entered = [deferred<void>(), deferred<void>()];
    const startSignals: AbortSignal[] = [];
    const starts = runtimes.map((runtime, index) =>
      enqueueProfileStart({
        state,
        runtime,
        configRevision: 0,
        key: "default",
        run: async (signal) => {
          startSignals[index] = signal;
          entered[index]?.resolve();
          const running = await launches[index]!.promise;
          registerProfileHandle(runtime, running);
          signal.throwIfAborted();
          runtime.running = running;
        },
      }),
    );
    await Promise.all(entered.map((gate) => gate.promise));
    const children = [fakeRunning(1), fakeRunning(2)];
    const clearState = vi.fn(() => {
      for (const runtime of runtimes) {
        expect(runtime.running).toBeNull();
        expect(getProfileLifecycle(runtime).handles.size).toBe(0);
      }
    });

    const stopping = stopBrowserBridgeRuntime({
      current: state,
      getState: () => state,
      clearState,
      onWarn: vi.fn(),
    });

    expect(startSignals).toHaveLength(2);
    expect(startSignals.every((signal) => signal.aborted)).toBe(true);
    expect(() =>
      enqueueProfileStart({
        state,
        runtime: runtimes[0]!,
        configRevision: 0,
        key: "after-shutdown",
        run: async () => {},
      }),
    ).toThrow("Browser runtime is stopping");
    expect(clearState).not.toHaveBeenCalled();

    launches.forEach((launch, index) => launch.resolve(children[index]!));
    await Promise.all(
      starts.map(async (start) => await expect(start).rejects.toThrow(/lifecycle changed/i)),
    );
    await expect(stopping).resolves.toBeUndefined();

    expect(mocks.stopOpenClawChrome.mock.calls.map(([running]) => running)).toEqual(children);
    expect(mocks.closeChromeMcpSession).not.toHaveBeenCalled();
    expect(clearState).toHaveBeenCalledTimes(1);
  });
});
