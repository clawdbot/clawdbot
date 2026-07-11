// Browser tests cover profile reset through the lifecycle actor.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import "./server-context.chrome-test-harness.js";
import type { RunningChrome } from "./chrome.js";
import * as chromeModule from "./chrome.js";
import { createBrowserRouteContext } from "./server-context.js";
import {
  createProfileRuntimeState,
  enqueueProfileStart,
  getProfileLifecycle,
} from "./server-context.lifecycle.js";
import { createProfileResetOps } from "./server-context.reset.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => ({
  closeChromeMcpSession: vi.fn(async () => false),
  closePlaywrightBrowserConnection: vi.fn(async (_opts?: { cdpUrl?: string }) => {}),
  movePathToTrash: vi.fn(async (from: string) => `${from}.trashed`),
}));

vi.mock("./chrome-mcp.runtime.js", () => ({
  getChromeMcpModule: async () => ({ closeChromeMcpSession: mocks.closeChromeMcpSession }),
}));
vi.mock("./pw-ai-module.js", () => ({
  getLoadedPwAiModule: () => ({
    retirePlaywrightBrowserConnectionExact: (opts: { cdpUrl: string }) => ({
      retired: true,
      close: async () => await mocks.closePlaywrightBrowserConnection(opts),
    }),
  }),
  getPwAiModule: async () => null,
}));
vi.mock("./trash.js", () => ({ movePathToTrash: mocks.movePathToTrash }));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createResetHarness(profile = makeBrowserProfile(), userDataDir = `/tmp/${profile.name}`) {
  const state = makeBrowserServerState({ profile });
  const runtime = createProfileRuntimeState(profile);
  state.profiles.set(profile.name, runtime);
  return {
    state,
    runtime,
    ops: createProfileResetOps({
      profile,
      state: () => state,
      runtime,
      configRevision: getProfileLifecycle(runtime).configRevision,
      resolveOpenClawUserDataDir: () => userDataDir,
    }),
  };
}

describe("createProfileResetOps", () => {
  it("rejects remote non-extension profiles", async () => {
    const { ops } = createResetHarness(
      makeBrowserProfile({
        name: "remote",
        cdpUrl: "https://browserless.example/chrome",
        cdpHost: "browserless.example",
        cdpIsLoopback: false,
        cdpPort: 443,
      }),
    );

    await expect(ops.resetProfile()).rejects.toThrow(/only supported for local profiles/i);
  });

  it("stops the exact managed child before trashing its profile directory", async () => {
    const profileDir = tempDirs.make("openclaw-reset-");
    const { ops, runtime } = createResetHarness(makeBrowserProfile(), profileDir);
    const running = { pid: 1 } as never;
    getProfileLifecycle(runtime).handles.add(running);
    runtime.running = running;

    await expect(ops.resetProfile()).resolves.toEqual({
      moved: true,
      from: profileDir,
      to: `${profileDir}.trashed`,
    });

    expect(chromeModule.stopOpenClawChrome).toHaveBeenCalledWith(running);
    expect(mocks.movePathToTrash).toHaveBeenCalledWith(profileDir);
    expect(mocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
    });
  });

  it("stops a deferred managed launch before trashing without stale adoption", async () => {
    const profileDir = tempDirs.make("openclaw-reset-race-");
    const profile = makeBrowserProfile();
    const state = makeBrowserServerState({ profile });
    const profileContext = createBrowserRouteContext({ getState: () => state }).forProfile(
      profile.name,
    );
    const runtime = state.profiles.get(profile.name);
    if (!runtime) {
      throw new Error("Expected profile runtime");
    }

    const launchEntered = deferred<void>();
    const deferredLaunch = deferred<RunningChrome>();
    const late = {
      pid: 42,
      exe: { kind: "chromium", path: "/usr/bin/chromium" },
      userDataDir: profileDir,
      cdpPort: profile.cdpPort,
      startedAt: Date.now(),
      proc: { on: vi.fn(), exitCode: null, signalCode: null },
    } as unknown as RunningChrome;
    vi.mocked(chromeModule.resolveOpenClawUserDataDir).mockReturnValueOnce(profileDir);
    vi.mocked(chromeModule.isChromeReachable)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    vi.mocked(chromeModule.launchOpenClawChrome).mockImplementationOnce(async () => {
      launchEntered.resolve();
      return await deferredLaunch.promise;
    });
    const order: string[] = [];
    vi.mocked(chromeModule.stopOpenClawChrome).mockImplementationOnce(async (running) => {
      order.push("stop");
      expect(running).toBe(late);
      expect(runtime.running).toBeNull();
      expect(getProfileLifecycle(runtime).handles.has(late)).toBe(true);
    });
    mocks.movePathToTrash.mockImplementationOnce(async (from) => {
      order.push("trash");
      expect(runtime.running).toBeNull();
      expect(getProfileLifecycle(runtime).handles.size).toBe(0);
      return `${from}.trashed`;
    });

    const starting = profileContext.ensureBrowserAvailable();
    await launchEntered.promise;
    const startExpectation = expect(starting).rejects.toThrow(/profile reset|lifecycle changed/i);
    const resetting = profileContext.resetProfile();
    deferredLaunch.resolve(late);

    await startExpectation;
    await expect(resetting).resolves.toEqual({
      moved: true,
      from: profileDir,
      to: `${profileDir}.trashed`,
    });
    expect(order).toEqual(["stop", "trash"]);
    expect(chromeModule.stopOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(runtime.running).toBeNull();
    expect(getProfileLifecycle(runtime).handles.size).toBe(0);
  });

  it("disconnects adapters and trashes an idle managed profile", async () => {
    const profileDir = tempDirs.make("openclaw-reset-idle-");
    const { ops } = createResetHarness(makeBrowserProfile(), profileDir);

    await expect(ops.resetProfile()).resolves.toMatchObject({ moved: true, from: profileDir });

    expect(chromeModule.stopOpenClawChrome).not.toHaveBeenCalled();
    expect(mocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
    });
  });

  it("keeps reset reversible when Trash fails after resource cleanup", async () => {
    const profileDir = tempDirs.make("openclaw-reset-");
    const { ops, runtime, state } = createResetHarness(makeBrowserProfile(), profileDir);
    mocks.movePathToTrash.mockRejectedValueOnce(new Error("Trash unavailable"));

    await expect(ops.resetProfile()).rejects.toThrow("Trash unavailable");
    expect(getProfileLifecycle(runtime).blockedReason).toBeNull();
    await expect(
      enqueueProfileStart({
        state,
        runtime,
        configRevision: getProfileLifecycle(runtime).configRevision,
        key: "default",
        run: async () => {},
      }),
    ).resolves.toBeUndefined();
  });
});
