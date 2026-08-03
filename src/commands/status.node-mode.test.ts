// Status node-mode tests cover node host config and node status rendering.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadNodeHostConfig: vi.fn(),
}));

vi.mock("../node-host/config.js", () => ({
  loadNodeHostConfig: mocks.loadNodeHostConfig,
}));

import { resolveNodeOnlyGatewayInfo } from "./status.node-mode.js";

describe("resolveNodeOnlyGatewayInfo", () => {
  beforeEach(() => {
    mocks.loadNodeHostConfig.mockReset();
  });

  it("returns node-only gateway details when no local gateway is installed", async () => {
    mocks.loadNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "node-1",
      gateway: { host: "gateway.example.com", port: 19000 },
    });

    await expect(
      resolveNodeOnlyGatewayInfo({
        daemon: { installed: false },
        node: {
          installed: true,
          loaded: true,
          externallyManaged: false,
          runtimeShort: "running (pid 4321)",
        },
      }),
    ).resolves.toEqual({
      gatewayTarget: "gateway.example.com:19000",
      gatewayValue: "node → gateway.example.com:19000 · no local gateway",
      connectionDetails: [
        "Node-only mode detected",
        "Local gateway: not expected on this machine",
        "Remote gateway target: gateway.example.com:19000",
        "Inspect the remote gateway host for live channel and health details.",
      ].join("\n"),
    });
  });

  it("does not claim node-only mode when the node service is installed but inactive", async () => {
    mocks.loadNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "node-1",
      gateway: { host: "gateway.example.com", port: 19000 },
    });

    await expect(
      resolveNodeOnlyGatewayInfo({
        daemon: { installed: false },
        node: {
          installed: true,
          loaded: false,
          externallyManaged: false,
          runtime: { status: "stopped" },
          runtimeShort: "stopped",
        },
      }),
    ).resolves.toBeNull();
  });

  it("falls back to an unknown gateway target when node-only config is missing", async () => {
    mocks.loadNodeHostConfig.mockResolvedValueOnce(null);

    await expect(
      resolveNodeOnlyGatewayInfo({
        daemon: { installed: false },
        node: {
          installed: true,
          loaded: true,
          externallyManaged: false,
          runtimeShort: "running (pid 4321)",
        },
      }),
    ).resolves.toEqual({
      gatewayTarget: "(gateway address unknown)",
      gatewayValue: "node → (gateway address unknown) · no local gateway",
      connectionDetails: [
        "Node-only mode detected",
        "Local gateway: not expected on this machine",
        "Remote gateway target: (gateway address unknown)",
        "Inspect the remote gateway host for live channel and health details.",
      ].join("\n"),
    });
  });
});
