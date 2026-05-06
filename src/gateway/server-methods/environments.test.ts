import { beforeEach, describe, expect, it, vi } from "vitest";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { listNodePairing } from "../../infra/node-pairing.js";
import { ErrorCodes } from "../protocol/index.js";
import { environmentsHandlers } from "./environments.js";

vi.mock("../../infra/device-pairing.js", () => ({
  listDevicePairing: vi.fn(),
}));

vi.mock("../../infra/node-pairing.js", () => ({
  listNodePairing: vi.fn(),
}));

function mockContext() {
  return {
    nodeRegistry: {
      listConnected: () => [
        {
          nodeId: "node-live",
          connId: "conn-live",
          displayName: "Live Node",
          platform: "ios",
          caps: ["camera"],
          commands: ["system.run"],
          connectedAtMs: 123,
        },
      ],
    },
  };
}

async function callEnvironmentMethod(
  method: "environments.list" | "environments.status",
  params: unknown,
) {
  const respond = vi.fn();
  await environmentsHandlers[method]?.({
    params: params as Record<string, unknown>,
    respond,
    context: mockContext(),
  } as never);
  return respond.mock.calls[0];
}

beforeEach(() => {
  vi.mocked(listDevicePairing).mockResolvedValue({ paired: [] } as never);
  vi.mocked(listNodePairing).mockResolvedValue({
    paired: [
      {
        nodeId: "node-offline",
        displayName: "Offline Node",
        caps: ["screen"],
        commands: ["camera.snap"],
      },
    ],
  } as never);
});

describe("environment gateway methods", () => {
  it("lists the gateway and node environment candidates", async () => {
    const [ok, payload] = await callEnvironmentMethod("environments.list", {});

    expect(ok).toBe(true);
    expect(payload).toEqual({
      environments: [
        {
          id: "gateway",
          type: "local",
          label: "Gateway local",
          status: "available",
          capabilities: ["agent.run", "sessions", "tools", "workspace"],
        },
        {
          id: "node:node-live",
          type: "node",
          label: "Live Node",
          status: "available",
          capabilities: ["camera", "system.run"],
        },
        {
          id: "node:node-offline",
          type: "node",
          label: "Offline Node",
          status: "unavailable",
          capabilities: ["camera.snap", "screen"],
        },
      ],
    });
  });

  it("returns status for one environment", async () => {
    const [ok, payload] = await callEnvironmentMethod("environments.status", {
      environmentId: "node:node-live",
    });

    expect(ok).toBe(true);
    expect(payload).toEqual({
      id: "node:node-live",
      type: "node",
      label: "Live Node",
      status: "available",
      capabilities: ["camera", "system.run"],
    });
  });

  it("rejects unknown environment ids", async () => {
    const [ok, , error] = await callEnvironmentMethod("environments.status", {
      environmentId: "missing",
    });

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: "unknown environmentId",
    });
  });
});
