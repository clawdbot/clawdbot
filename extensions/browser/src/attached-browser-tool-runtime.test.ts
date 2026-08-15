import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBrowserTool: vi.fn(),
  startBrowserBridgeServer: vi.fn(),
  stopBrowserBridgeServer: vi.fn(),
  closePlaywrightBrowserConnection: vi.fn(),
}));

vi.mock("./browser-tool.js", () => ({
  createBrowserTool: mocks.createBrowserTool,
}));

vi.mock("./browser/bridge-server.js", () => ({
  startBrowserBridgeServer: mocks.startBrowserBridgeServer,
  stopBrowserBridgeServer: mocks.stopBrowserBridgeServer,
}));

vi.mock("./browser/pw-session.js", () => ({
  closePlaywrightBrowserConnection: mocks.closePlaywrightBrowserConnection,
}));

import { createAttachedBrowserToolRuntime } from "./attached-browser-tool-runtime.js";

describe("attached Browser tool runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.closePlaywrightBrowserConnection.mockResolvedValue(undefined);
    mocks.createBrowserTool.mockReturnValue({ name: "browser" });
    mocks.startBrowserBridgeServer.mockResolvedValue({
      baseUrl: "http://127.0.0.1:18443",
      server: { marker: "bridge-server" },
    });
    mocks.stopBrowserBridgeServer.mockResolvedValue(undefined);
  });

  it("exposes only one raw attach-only CDP profile through an authenticated loopback bridge", async () => {
    const ensureAttachTarget = vi.fn().mockResolvedValue(undefined);
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "attached-browser-workspace-"));
    const runtime = await createAttachedBrowserToolRuntime({
      cdpUrl: "http://127.0.0.1:9222",
      ensureAttachTarget,
      agentSessionKey: "worker:session-1",
      agentDir: "/tmp/worker-state",
      workspaceDir,
    });

    expect(mocks.startBrowserBridgeServer).toHaveBeenCalledOnce();
    const bridgeParams = mocks.startBrowserBridgeServer.mock.calls[0]?.[0];
    expect(bridgeParams).toMatchObject({
      host: "127.0.0.1",
      port: 0,
      authToken: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/u),
      resolved: {
        enabled: true,
        attachOnly: true,
        defaultProfile: "worker",
        profiles: {
          worker: {
            driver: "openclaw",
            attachOnly: true,
            cdpUrl: "http://127.0.0.1:9222",
          },
        },
        extensionRelayPorts: {},
        extensionRelayInternalTokens: {},
      },
    });
    expect(Object.keys(bridgeParams.resolved.profiles)).toEqual(["worker"]);

    await bridgeParams.onEnsureAttachTarget();
    expect(ensureAttachTarget).toHaveBeenCalledOnce();
    expect(mocks.createBrowserTool).toHaveBeenCalledWith({
      sandboxBridgeUrl: "http://127.0.0.1:18443",
      allowHostControl: false,
      agentSessionKey: "worker:session-1",
      agentDir: "/tmp/worker-state",
      workspaceDir,
      screenshotResultMode: "path",
      persistScreenshot: expect.any(Function),
    });
    const toolParams = mocks.createBrowserTool.mock.calls[0]?.[0];
    const sourcePath = path.join(workspaceDir, "source.png");
    await fs.writeFile(sourcePath, "screenshot-bytes");
    const artifactPath = await toolParams.persistScreenshot({ sourcePath, type: "png" });
    expect(artifactPath.replaceAll("\\", "/")).toMatch(
      /\.artifacts\/cloud-worker-browser\/screenshot-[a-f0-9]{16}\.png$/u,
    );
    expect(await fs.readFile(artifactPath, "utf8")).toBe("screenshot-bytes");
    if (process.platform !== "win32") {
      expect((await fs.stat(artifactPath)).mode & 0o777).toBe(0o600);
    }
    const filesBeforeFailure = await fs.readdir(path.dirname(artifactPath));
    await expect(
      toolParams.persistScreenshot({
        sourcePath: path.join(workspaceDir, "missing.png"),
        type: "png",
      }),
    ).rejects.toThrow();
    expect(await fs.readdir(path.dirname(artifactPath))).toEqual(filesBeforeFailure);
    expect(runtime.tool).toEqual({ name: "browser" });

    await runtime.dispose();
    expect(mocks.stopBrowserBridgeServer).toHaveBeenCalledWith({ marker: "bridge-server" });
    expect(mocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
    });
    expect(ensureAttachTarget).toHaveBeenCalledOnce();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("retries exact Playwright CDP adapter disposal after a failed disconnect", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "attached-browser-workspace-"));
    const runtime = await createAttachedBrowserToolRuntime({
      cdpUrl: "http://127.0.0.1:9222",
      ensureAttachTarget: async () => {},
      workspaceDir,
    });
    mocks.closePlaywrightBrowserConnection
      .mockRejectedValueOnce(new Error("disconnect failed"))
      .mockResolvedValueOnce(undefined);

    await expect(runtime.dispose()).rejects.toThrow("disconnect failed");
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(mocks.stopBrowserBridgeServer).toHaveBeenCalledTimes(2);
    expect(mocks.closePlaywrightBrowserConnection).toHaveBeenCalledTimes(2);
    expect(mocks.closePlaywrightBrowserConnection).toHaveBeenNthCalledWith(1, {
      cdpUrl: "http://127.0.0.1:9222",
    });
    expect(mocks.closePlaywrightBrowserConnection).toHaveBeenNthCalledWith(2, {
      cdpUrl: "http://127.0.0.1:9222",
    });

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it.runIf(process.platform !== "win32")(
    "rejects screenshot artifact symlink escapes",
    async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "attached-browser-workspace-"));
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "attached-browser-outside-"));
      await fs.symlink(outsideDir, path.join(workspaceDir, ".artifacts"));
      await createAttachedBrowserToolRuntime({
        cdpUrl: "http://127.0.0.1:9222",
        ensureAttachTarget: async () => {},
        workspaceDir,
      });
      const toolParams = mocks.createBrowserTool.mock.calls.at(-1)?.[0];
      const sourcePath = path.join(workspaceDir, "source.png");
      await fs.writeFile(sourcePath, "screenshot-bytes");

      await expect(toolParams.persistScreenshot({ sourcePath, type: "png" })).rejects.toThrow();
      expect(await fs.readdir(outsideDir)).toEqual([]);
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
    },
  );

  it.each([
    "http://localhost:9222",
    "https://127.0.0.1:9222",
    "http://127.0.0.1",
    "http://127.0.0.1:9222/devtools/browser/target",
  ])("rejects non-canonical raw CDP URL %s before starting a bridge", async (cdpUrl) => {
    await expect(
      createAttachedBrowserToolRuntime({
        cdpUrl,
        ensureAttachTarget: async () => {},
        workspaceDir: "/tmp/workspace",
      }),
    ).rejects.toThrow("loopback HTTP URL with an explicit port");
    expect(mocks.startBrowserBridgeServer).not.toHaveBeenCalled();
  });
});
