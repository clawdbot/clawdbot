import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBrowserTool: vi.fn(),
  startBrowserBridgeServer: vi.fn(),
  stopBrowserBridgeServer: vi.fn(),
}));

vi.mock("./browser-tool.js", () => ({
  createBrowserTool: mocks.createBrowserTool,
}));

vi.mock("./browser/bridge-server.js", () => ({
  startBrowserBridgeServer: mocks.startBrowserBridgeServer,
  stopBrowserBridgeServer: mocks.stopBrowserBridgeServer,
}));

import { createAttachedBrowserToolRuntime } from "./attached-browser-tool-runtime.js";

describe("attached Browser tool runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createBrowserTool.mockReturnValue({ name: "browser" });
    mocks.startBrowserBridgeServer.mockResolvedValue({
      baseUrl: "http://127.0.0.1:18443",
      server: { marker: "bridge-server" },
    });
    mocks.stopBrowserBridgeServer.mockResolvedValue(undefined);
  });

  it("exposes only one raw attach-only CDP profile through an authenticated loopback bridge", async () => {
    const ensureAttachTarget = vi.fn().mockResolvedValue(undefined);
    const runtime = await createAttachedBrowserToolRuntime({
      cdpUrl: "http://127.0.0.1:9222",
      ensureAttachTarget,
      agentSessionKey: "worker:session-1",
      agentDir: "/tmp/worker-state",
      workspaceDir: "/tmp/workspace",
      activeModel: { provider: "openai", model: "gpt-test" },
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
      workspaceDir: "/tmp/workspace",
      activeModel: { provider: "openai", model: "gpt-test" },
    });
    expect(runtime.tool).toEqual({ name: "browser" });

    await runtime.dispose();
    expect(mocks.stopBrowserBridgeServer).toHaveBeenCalledWith({ marker: "bridge-server" });
    expect(ensureAttachTarget).toHaveBeenCalledOnce();
  });

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
      }),
    ).rejects.toThrow("loopback HTTP URL with an explicit port");
    expect(mocks.startBrowserBridgeServer).not.toHaveBeenCalled();
  });
});
