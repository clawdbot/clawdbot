import { describe, expect, it, vi } from "vitest";
import type { GatewayClientOptions } from "../gateway/client.js";
import { runNodeHost } from "./runner.js";

const mocks = vi.hoisted(() => ({
  capturedGatewayClientOptions: [] as GatewayClientOptions[],
  ensureNodeHostConfig: vi.fn(async () => ({
    version: 1,
    nodeId: "node-test",
  })),
  saveNodeHostConfig: vi.fn(async () => undefined),
  getRuntimeConfig: vi.fn(() => ({
    gateway: {
      handshakeTimeoutMs: 1_000,
    },
  })),
  startGatewayClientWhenEventLoopReady: vi.fn(async () => ({
    ready: false,
    aborted: false,
    elapsedMs: 0,
  })),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../gateway/client-start-readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: mocks.startGatewayClientWhenEventLoopReady,
}));

vi.mock("../gateway/client.js", () => ({
  GatewayClient: function GatewayClient(opts: GatewayClientOptions) {
    mocks.capturedGatewayClientOptions.push(opts);
  },
}));

vi.mock("../gateway/connection-auth.js", () => ({
  resolveGatewayConnectionAuth: vi.fn(async () => ({})),
}));

vi.mock("../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: vi.fn(() => ({
    id: "device-test",
    publicKey: "public-key-test",
    privateKey: "private-key-test",
  })),
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn(async () => "test-node"),
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: vi.fn(),
}));

vi.mock("./config.js", () => ({
  ensureNodeHostConfig: mocks.ensureNodeHostConfig,
  saveNodeHostConfig: mocks.saveNodeHostConfig,
}));

vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  listRegisteredNodeHostCapsAndCommands: vi.fn(() => ({
    caps: [],
    commands: [],
  })),
}));

describe("runNodeHost", () => {
  it("passes the resolved Gateway URL to the Gateway client", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(mocks.capturedGatewayClientOptions).toHaveLength(1);
    expect(mocks.capturedGatewayClientOptions[0]?.url).toBe("ws://127.0.0.1:18789");
  });
});
