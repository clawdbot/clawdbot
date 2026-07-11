// Browser tests cover the per-profile lifecycle actor.
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningChrome } from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import type { ExtensionRelayHandle } from "./extension-relay/relay-server.js";
import { makeBrowserProfile } from "./server-context.test-harness.js";
import type { BrowserServerState } from "./server-context.types.js";

const mocks = vi.hoisted(() => ({
  closeChromeMcpSession: vi.fn(async () => false),
  closePlaywrightBrowserConnection: vi.fn(async (_opts?: { cdpUrl?: string }) => {}),
  playwrightLoaded: true,
  retirePlaywrightBrowserConnection: vi.fn((_opts?: { cdpUrl?: string }) => true),
  stopOpenClawChrome: vi.fn(async () => {}),
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
  getLoadedPwAiModule: () =>
    mocks.playwrightLoaded
      ? {
          retirePlaywrightBrowserConnectionExact: (opts: { cdpUrl: string }) => ({
            retired: mocks.retirePlaywrightBrowserConnection(opts),
            close: async () => await mocks.closePlaywrightBrowserConnection(opts),
          }),
        }
      : undefined,
  getPwAiModule: async () => null,
}));

const {
  beginProfileTransition,
  createProfileRuntimeState,
  enqueueProfileStart,
  getProfileLifecycle,
  registerProfileHandle,
  withProfileOperationLease,
} = await import("./server-context.lifecycle.js");

beforeEach(() => {
  mocks.closeChromeMcpSession.mockReset().mockResolvedValue(false);
  mocks.closePlaywrightBrowserConnection.mockReset().mockResolvedValue(undefined);
  mocks.playwrightLoaded = true;
  mocks.retirePlaywrightBrowserConnection.mockReset().mockReturnValue(true);
  mocks.stopOpenClawChrome.mockReset().mockResolvedValue(undefined);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function actorHarness(profile: ResolvedBrowserProfile = makeBrowserProfile()) {
  const runtime = createProfileRuntimeState(profile);
  const state = {
    resolved: { profiles: { [profile.name]: profile } },
    profiles: new Map([[profile.name, runtime]]),
  } as unknown as BrowserServerState;
  return { runtime, state };
}

function fakeRunning(pid: number): RunningChrome {
  return {
    pid,
    exe: { kind: "chromium", path: "/usr/bin/chromium" },
    userDataDir: `/tmp/profile-${pid}`,
    cdpPort: 18_800,
    startedAt: Date.now(),
    proc: { on: vi.fn() } as never,
  };
}

describe("profile lifecycle actor", () => {
  it("lets lifecycle-owned start work enter a nested profile operation without self-deadlock", async () => {
    const { state, runtime } = actorHarness();
    const nested = vi.fn(async () => {});

    await enqueueProfileStart({
      state,
      runtime,
      configRevision: 0,
      key: "default",
      run: async () => {
        await withProfileOperationLease({
          state,
          runtime,
          configRevision: 0,
          run: nested,
        });
      },
    });

    expect(nested).toHaveBeenCalledOnce();
  });

  it("coalesces a shared start while each caller owns only its waiter abort", async () => {
    const { state, runtime } = actorHarness();
    const launched = deferred<void>();
    const run = vi.fn(async () => await launched.promise);
    const caller = new AbortController();
    const first = enqueueProfileStart({
      state,
      runtime,
      configRevision: 0,
      key: "default",
      signal: caller.signal,
      run,
    });
    const second = enqueueProfileStart({
      state,
      runtime,
      configRevision: 0,
      key: "default",
      run,
    });

    caller.abort(new Error("caller timed out"));
    await expect(first).rejects.toThrow("caller timed out");
    launched.resolve();
    await expect(second).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("invalidates running and queued differing-key starts without poisoning the tail", async () => {
    const { state, runtime } = actorHarness();
    const launched = deferred<void>();
    const calls: string[] = [];
    const first = enqueueProfileStart({
      state,
      runtime,
      configRevision: 0,
      key: "headless:true",
      run: async (signal) => {
        calls.push("first");
        await launched.promise;
        signal.throwIfAborted();
      },
    });
    await Promise.resolve();
    const queued = enqueueProfileStart({
      state,
      runtime,
      configRevision: 0,
      key: "headless:false",
      run: async () => {
        calls.push("queued");
      },
    });
    const stopping = beginProfileTransition({
      state,
      runtime,
      reason: "stop requested",
    });
    launched.resolve();

    await expect(first).rejects.toThrow(/lifecycle changed|superseded/i);
    await expect(queued).rejects.toThrow(/lifecycle changed|superseded/i);
    await expect(stopping).resolves.toEqual({ stopped: true });
    await expect(
      enqueueProfileStart({
        state,
        runtime,
        configRevision: 0,
        key: "default",
        run: async () => {
          calls.push("after");
        },
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["first", "after"]);
  });

  it("rejects pre-stop work queued behind an older lifecycle tail", async () => {
    const { state, runtime } = actorHarness();
    const cleanup = deferred<void>();
    const operation = vi.fn(async () => "done");
    const leased = withProfileOperationLease({
      state,
      runtime,
      configRevision: 0,
      run: operation,
    });
    const stopping = beginProfileTransition({
      state,
      runtime,
      reason: "stop requested",
      afterCleanup: async () => await cleanup.promise,
    });

    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    cleanup.resolve();
    await stopping;
    await expect(leased).rejects.toThrow(/lifecycle changed|superseded/i);
    expect(operation).not.toHaveBeenCalled();

    await expect(
      withProfileOperationLease({
        state,
        runtime,
        configRevision: 0,
        run: operation,
      }),
    ).resolves.toBe("done");
  });

  it("rejects a stale operation even when its implementation swallows cancellation", async () => {
    const { state, runtime } = actorHarness();
    const admitted = deferred<void>();
    const leased = withProfileOperationLease({
      state,
      runtime,
      configRevision: 0,
      run: async (signal) => {
        admitted.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
        });
        return "stale-success";
      },
    });
    await admitted.promise;
    const stopping = beginProfileTransition({
      state,
      runtime,
      reason: "stop requested",
    });

    await expect(leased).rejects.toThrow(/lifecycle changed|stop requested/i);
    await stopping;
  });

  it("retires a Playwright adapter loaded after invalidation but before lease drain", async () => {
    const { state, runtime } = actorHarness();
    const operationStarted = deferred<void>();
    const releaseOperation = deferred<void>();
    mocks.playwrightLoaded = false;
    const operation = withProfileOperationLease({
      state,
      runtime,
      configRevision: 0,
      run: async () => {
        operationStarted.resolve();
        await releaseOperation.promise;
        mocks.playwrightLoaded = true;
      },
    });
    await operationStarted.promise;

    const transition = beginProfileTransition({
      state,
      runtime,
      reason: "stop requested",
    });
    expect(mocks.retirePlaywrightBrowserConnection).not.toHaveBeenCalled();
    releaseOperation.resolve();

    await expect(operation).rejects.toThrow(/lifecycle changed|superseded/i);
    await expect(transition).resolves.toEqual({ stopped: true });
    expect(mocks.retirePlaywrightBrowserConnection).toHaveBeenCalledOnce();
    expect(mocks.closePlaywrightBrowserConnection).toHaveBeenCalledOnce();
  });

  it("retries one retained Playwright retirement without duplicating it", async () => {
    const { state, runtime } = actorHarness();
    mocks.closePlaywrightBrowserConnection
      .mockRejectedValueOnce(new Error("adapter still closing"))
      .mockRejectedValueOnce(new Error("adapter still closing"))
      .mockResolvedValue(undefined);

    await expect(beginProfileTransition({ state, runtime, reason: "stop" })).rejects.toThrow(
      "adapter still closing",
    );
    await expect(beginProfileTransition({ state, runtime, reason: "stop retry" })).rejects.toThrow(
      "adapter still closing",
    );
    await expect(
      beginProfileTransition({ state, runtime, reason: "stop retry again" }),
    ).resolves.toEqual({ stopped: true });

    expect(mocks.retirePlaywrightBrowserConnection).toHaveBeenCalledOnce();
    expect(mocks.closePlaywrightBrowserConnection).toHaveBeenCalledTimes(3);
  });

  it("linearizes an admitted async commit before a later transition drains", async () => {
    const { state, runtime } = actorHarness();
    const commitEntered = deferred<void>();
    const releaseCommit = deferred<void>();
    const operation = withProfileOperationLease({
      state,
      runtime,
      configRevision: 0,
      run: async () => "imported",
      commit: async () => {
        commitEntered.resolve();
        await releaseCommit.promise;
      },
    });
    await commitEntered.promise;

    let transitionSettled = false;
    const transition = beginProfileTransition({
      state,
      runtime,
      reason: "delete requested",
    }).finally(() => {
      transitionSettled = true;
    });
    await Promise.resolve();
    expect(transitionSettled).toBe(false);

    releaseCommit.resolve();
    await expect(operation).resolves.toBe("imported");
    await expect(transition).resolves.toEqual({ stopped: true });
  });

  it("retains failed relay cleanup targets for a later repair transition", async () => {
    const profileA = makeBrowserProfile({
      cdpUrl: "http://127.0.0.1:18800",
      driver: "extension",
    });
    const profileB = makeBrowserProfile({ cdpUrl: "http://127.0.0.1:18801" });
    const { state, runtime } = actorHarness(profileA);
    const relay = {
      close: vi.fn().mockRejectedValueOnce(new Error("relay busy")).mockResolvedValue(undefined),
    } as unknown as ExtensionRelayHandle;
    state.extensionRelays = new Map([[profileA.name, relay]]);

    await expect(
      beginProfileTransition({
        state,
        runtime,
        reason: "A to B",
        closeRelay: true,
      }),
    ).rejects.toThrow("relay busy");
    expect(state.extensionRelays.get(profileA.name)).toBe(relay);
    runtime.profile = profileB;

    await expect(
      beginProfileTransition({
        state,
        runtime,
        reason: "repair",
      }),
    ).resolves.toEqual({ stopped: true });
    expect(mocks.retirePlaywrightBrowserConnection.mock.calls.map(([arg]) => arg)).toEqual([
      { cdpUrl: profileA.cdpUrl },
      { cdpUrl: profileB.cdpUrl },
    ]);
    expect(mocks.closePlaywrightBrowserConnection.mock.calls.map(([arg]) => arg)).toEqual([
      { cdpUrl: profileA.cdpUrl },
      { cdpUrl: profileB.cdpUrl },
    ]);
    expect(relay.close).toHaveBeenCalledTimes(2);
    expect(state.extensionRelays.has(profileA.name)).toBe(false);
    expect(getProfileLifecycle(runtime).blockedReason).toBeNull();
  });

  it("disconnects only the adapter owned by each profile driver", async () => {
    const existing = makeBrowserProfile({ driver: "existing-session", cdpUrl: "" });
    const { state: existingState, runtime: existingRuntime } = actorHarness(existing);
    await beginProfileTransition({
      state: existingState,
      runtime: existingRuntime,
      reason: "existing-session stop",
    });
    expect(mocks.closeChromeMcpSession).toHaveBeenCalledWith(existing.name);
    expect(mocks.closePlaywrightBrowserConnection).not.toHaveBeenCalled();

    mocks.closeChromeMcpSession.mockClear();
    mocks.closePlaywrightBrowserConnection.mockClear();
    const remote = makeBrowserProfile({
      cdpUrl: "https://browser.example.test",
      cdpIsLoopback: false,
      attachOnly: true,
    });
    const { state: remoteState, runtime: remoteRuntime } = actorHarness(remote);
    await beginProfileTransition({
      state: remoteState,
      runtime: remoteRuntime,
      reason: "remote stop",
    });
    expect(mocks.retirePlaywrightBrowserConnection).toHaveBeenCalledOnce();
    expect(mocks.closePlaywrightBrowserConnection).toHaveBeenCalledOnce();
    expect(mocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: remote.cdpUrl,
    });
    expect(mocks.closeChromeMcpSession).not.toHaveBeenCalled();
  });

  it("retains an old MCP cleanup target across a driver transition", async () => {
    const existing = makeBrowserProfile({ driver: "existing-session", cdpUrl: "" });
    const replacement = makeBrowserProfile({ driver: "openclaw" });
    const { state, runtime } = actorHarness(existing);
    mocks.closeChromeMcpSession
      .mockRejectedValueOnce(new Error("MCP close failed"))
      .mockRejectedValueOnce(new Error("MCP close failed"))
      .mockResolvedValue(false);

    await expect(
      beginProfileTransition({ state, runtime, reason: "existing to managed" }),
    ).rejects.toThrow("MCP close failed");
    runtime.profile = replacement;

    await expect(
      beginProfileTransition({
        state,
        runtime,
        reason: "cleanup retry",
        captureProfileResources: false,
      }),
    ).resolves.toEqual({ stopped: false });
    expect(mocks.closeChromeMcpSession).toHaveBeenCalledTimes(3);
    expect(mocks.closeChromeMcpSession).toHaveBeenNthCalledWith(3, existing.name);
  });

  it("keeps shared adapters open while draining an exact managed handle", async () => {
    const { state, runtime } = actorHarness();
    const running = fakeRunning(91);
    registerProfileHandle(runtime, running);
    runtime.running = running;

    await expect(
      beginProfileTransition({
        state,
        runtime,
        reason: "bridge shutdown",
        closeSharedAdapters: false,
      }),
    ).resolves.toEqual({ stopped: true });

    expect(mocks.stopOpenClawChrome).toHaveBeenCalledExactlyOnceWith(running);
    expect(mocks.closeChromeMcpSession).not.toHaveBeenCalled();
    expect(mocks.retirePlaywrightBrowserConnection).not.toHaveBeenCalled();
    expect(mocks.closePlaywrightBrowserConnection).not.toHaveBeenCalled();
    expect(runtime.running).toBeNull();
    expect(getProfileLifecycle(runtime).handles.size).toBe(0);
  });

  it("drains a legacy running handle that was not lifecycle-registered", async () => {
    const { state, runtime } = actorHarness();
    const running = fakeRunning(92);
    runtime.running = running;

    await expect(
      beginProfileTransition({ state, runtime, reason: "runtime shutdown" }),
    ).resolves.toEqual({ stopped: true });

    expect(mocks.stopOpenClawChrome).toHaveBeenCalledExactlyOnceWith(running);
    expect(runtime.running).toBeNull();
  });

  it("ignores an old process exit after a same-PID replacement is adopted", () => {
    const { runtime } = actorHarness();
    const oldProcess = new EventEmitter();
    const oldHandle = {
      ...fakeRunning(42),
      proc: oldProcess as unknown as RunningChrome["proc"],
    };
    const replacement = {
      ...fakeRunning(42),
      proc: new EventEmitter() as unknown as RunningChrome["proc"],
    };
    registerProfileHandle(runtime, oldHandle);
    registerProfileHandle(runtime, replacement);
    runtime.running = replacement;

    oldProcess.emit("exit", 0, null);

    expect(runtime.running).toBe(replacement);
    expect(getProfileLifecycle(runtime).handles.has(oldHandle)).toBe(false);
    expect(getProfileLifecycle(runtime).handles.has(replacement)).toBe(true);
  });

  it("keeps failed exact-handle cleanup blocked until a retry succeeds", async () => {
    const { state, runtime } = actorHarness();
    const running = fakeRunning(88);
    registerProfileHandle(runtime, running);
    runtime.running = running;
    mocks.stopOpenClawChrome
      .mockRejectedValueOnce(new Error("child still alive"))
      .mockResolvedValue(undefined);

    await expect(beginProfileTransition({ state, runtime, reason: "stop" })).rejects.toThrow(
      "child still alive",
    );
    expect(() =>
      enqueueProfileStart({
        state,
        runtime,
        configRevision: 0,
        key: "default",
        run: async () => {},
      }),
    ).toThrow(/cleanup failed/i);

    await expect(beginProfileTransition({ state, runtime, reason: "stop retry" })).resolves.toEqual(
      { stopped: true },
    );
    expect(runtime.running).toBeNull();
    expect(getProfileLifecycle(runtime).handles.size).toBe(0);
  });
});
