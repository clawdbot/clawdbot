import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  loadBundledPluginPublicSurfaceModuleSyncCore: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("../plugin-sdk/facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSyncCore: mocks.loadBundledPluginPublicSurfaceModuleSyncCore,
}));

import { createWorkerBrowserToolRuntime } from "./browser-runtime.js";

describe("worker Browser runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads only the bundled Browser runtime and launches the fixed executable without arguments", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const createAttachedBrowserToolRuntime = vi.fn().mockResolvedValue({
      tool: { name: "browser" },
      dispose,
    });
    mocks.loadBundledPluginPublicSurfaceModuleSyncCore.mockReturnValue({
      createAttachedBrowserToolRuntime,
    });
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null) => void,
      ) => {
        callback(null);
        return {};
      },
    );

    const runtime = await createWorkerBrowserToolRuntime({
      descriptor: {
        cdpUrl: "http://127.0.0.1:9222",
        launcherPath: "/usr/local/bin/openclaw-worker-browser",
      },
      sessionKey: "worker:session-1",
      stateDir: "/tmp/worker-state",
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.loadBundledPluginPublicSurfaceModuleSyncCore).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "runtime-api.js",
      trackedPluginId: "browser",
    });
    expect(createAttachedBrowserToolRuntime).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      ensureAttachTarget: expect.any(Function),
      agentSessionKey: "worker:session-1",
      agentDir: "/tmp/worker-state",
      workspaceDir: "/tmp/workspace",
    });

    const ensureAttachTarget = createAttachedBrowserToolRuntime.mock.calls[0]?.[0]
      .ensureAttachTarget as () => Promise<void>;
    await ensureAttachTarget();
    expect(mocks.execFile).toHaveBeenCalledWith(
      "/usr/local/bin/openclaw-worker-browser",
      [],
      {
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      expect.any(Function),
    );

    await runtime.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("uses the build-composed Browser runtime without filesystem discovery", async () => {
    const createAttachedBrowserToolRuntime = vi.fn().mockResolvedValue({
      tool: { name: "browser" },
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    await createWorkerBrowserToolRuntime({
      descriptor: {
        cdpUrl: "http://127.0.0.1:9222",
        launcherPath: "/usr/local/bin/openclaw-worker-browser",
      },
      sessionKey: "worker:session-1",
      stateDir: "/tmp/worker-state",
      workspaceDir: "/tmp/workspace",
      runtime: { createAttachedBrowserToolRuntime },
    });

    expect(createAttachedBrowserToolRuntime).toHaveBeenCalledOnce();
    expect(mocks.loadBundledPluginPublicSurfaceModuleSyncCore).not.toHaveBeenCalled();
  });

  it("surfaces launcher failure without loading another browser route", async () => {
    const createAttachedBrowserToolRuntime = vi.fn().mockResolvedValue({
      tool: { name: "browser" },
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    mocks.loadBundledPluginPublicSurfaceModuleSyncCore.mockReturnValue({
      createAttachedBrowserToolRuntime,
    });
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null) => void,
      ) => {
        callback(new Error("launcher timed out"));
        return {};
      },
    );

    await createWorkerBrowserToolRuntime({
      descriptor: {
        cdpUrl: "http://127.0.0.1:9222",
        launcherPath: "/usr/local/bin/openclaw-worker-browser",
      },
      sessionKey: "worker:session-1",
      stateDir: "/tmp/worker-state",
      workspaceDir: "/tmp/workspace",
    });
    const ensureAttachTarget = createAttachedBrowserToolRuntime.mock.calls[0]?.[0]
      .ensureAttachTarget as () => Promise<void>;

    await expect(ensureAttachTarget()).rejects.toThrow(
      "Worker Browser launcher failed: launcher timed out",
    );
    expect(mocks.loadBundledPluginPublicSurfaceModuleSyncCore).toHaveBeenCalledOnce();
  });
});
