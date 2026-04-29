import { afterEach, describe, expect, it, vi } from "vitest";

const transportState = vi.hoisted(() => ({
  lastTransport: null as { onclose?: (() => void) | undefined } | null,
}));
const serverState = vi.hoisted(() => ({
  connect: vi.fn(async (_transport: unknown) => {}),
  close: vi.fn(async () => {}),
}));
const bridgeState = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  close: vi.fn(async () => {
    throw new Error("close boom");
  }),
  setServer: vi.fn(),
  handleClaudePermissionRequest: vi.fn(async (_payload: unknown) => {}),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class MockStdioServerTransport {
    onclose?: () => void;

    constructor() {
      transportState.lastTransport = this;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class MockMcpServer {
    server = {
      setNotificationHandler: vi.fn(),
    };

    async connect(transport: unknown) {
      return serverState.connect(transport);
    }

    async close() {
      return serverState.close();
    }
  },
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("../version.js", () => ({
  VERSION: "test",
}));

vi.mock("./channel-bridge.js", () => ({
  OpenClawChannelBridge: class MockOpenClawChannelBridge {
    setServer(server: unknown) {
      bridgeState.setServer(server);
    }

    async start() {
      return bridgeState.start();
    }

    async close() {
      return bridgeState.close();
    }

    async handleClaudePermissionRequest(payload: unknown) {
      return bridgeState.handleClaudePermissionRequest(payload);
    }
  },
}));

vi.mock("./channel-shared.js", () => ({
  ClaudePermissionRequestSchema: {},
}));

vi.mock("./channel-tools.js", () => ({
  getChannelMcpCapabilities: vi.fn(() => undefined),
  registerChannelMcpTools: vi.fn(),
}));

async function waitForTransport(): Promise<{ onclose?: (() => void) | undefined }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (transportState.lastTransport) {
      return transportState.lastTransport;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("MCP stdio transport was not created");
}

describe("serveOpenClawChannelMcp shutdown", () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    unhandledRejections.length = 0;
    transportState.lastTransport = null;
    serverState.connect.mockClear();
    serverState.close.mockClear();
    bridgeState.start.mockClear();
    bridgeState.close.mockClear();
    bridgeState.setServer.mockClear();
    bridgeState.handleClaudePermissionRequest.mockClear();
  });

  it("does not leak unhandled rejections when shutdown close fails", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const { serveOpenClawChannelMcp } = await import("./channel-server.js");

    const servePromise = serveOpenClawChannelMcp({ verbose: false });
    const transport = await waitForTransport();

    transport.onclose?.();
    await servePromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unhandledRejections).toEqual([]);
    expect(bridgeState.close).toHaveBeenCalledTimes(1);
  });
});
