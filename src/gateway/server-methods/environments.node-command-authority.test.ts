import { beforeEach, describe, expect, it, vi } from "vitest";
import { listNodePairing } from "../../infra/device-pairing-node.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { environmentsHandlers } from "./environments.js";

vi.mock("../../infra/device-pairing.js", () => ({
  listDevicePairing: vi.fn(),
  resolveNodePairingState: vi.fn(),
}));

vi.mock("../../infra/device-pairing-node.js", () => ({
  listNodePairing: vi.fn(),
}));

vi.mock("../node-registry-private.js", () => ({
  collectNodeCatalogRuntimeState: vi.fn(() => ({
    sessionHostNodeIds: new Set(),
    issuesByNodeId: new Map(),
    workerSlotsByNodeId: new Map(),
    workerBundleByNodeId: new Map(),
  })),
}));

vi.mock("../worker-environments/placement-capabilities.js", () => ({
  resolveWorkerPlacementCapabilities: vi.fn((runtimeId: string) =>
    runtimeId === "codex"
      ? {
          executionMode: "remote-exec",
          devicePlacement: {
            requiredNodeCommands: ["codex.exec-server.stdio.v1"],
            consumesWorkerSlot: false,
          },
        }
      : {},
  ),
}));

beforeEach(() => {
  vi.mocked(listDevicePairing).mockResolvedValue({ paired: [] } as never);
  vi.mocked(listNodePairing).mockResolvedValue({ paired: [] } as never);
});

describe("node environment command authority", () => {
  it.each([
    {
      name: "invocable command",
      declared: ["system.which", "codex.exec-server.stdio.v1", "system.run", "system.run"],
      effective: ["system.which", "codex.exec-server.stdio.v1", "system.run"],
      allow: ["codex.exec-server.stdio.v1"],
      deny: ["system.run"],
      expected: ["codex.exec-server.stdio.v1", "system.which"],
      state: "invocable",
    },
    {
      name: "declared command pending pairing approval",
      declared: ["codex.exec-server.stdio.v1"],
      effective: [],
      allow: ["codex.exec-server.stdio.v1"],
      deny: [],
      expected: [],
      state: "pending-approval",
    },
    {
      name: "declared command blocked by current Gateway policy",
      declared: ["codex.exec-server.stdio.v1"],
      effective: ["codex.exec-server.stdio.v1"],
      allow: ["codex.exec-server.stdio.v1"],
      deny: ["codex.exec-server.stdio.v1"],
      expected: [],
      state: "unauthorized",
    },
    {
      name: "required command blocked while an unrelated declaration awaits approval",
      declared: ["codex.exec-server.stdio.v1", "fixture.unrelated"],
      effective: ["codex.exec-server.stdio.v1"],
      allow: [],
      deny: [],
      expected: [],
      state: "unauthorized",
    },
    {
      name: "command not declared by the node",
      declared: [],
      effective: [],
      allow: ["codex.exec-server.stdio.v1"],
      deny: [],
      expected: [],
      state: "undeclared",
    },
  ])("projects $name", async ({ declared, effective, allow, deny, expected, state }) => {
    const context = {
      logGateway: { warn: vi.fn() },
      getRuntimeConfig: () => ({ gateway: { nodes: { commands: { allow, deny } } } }),
      nodeRegistry: {
        listConnectedForPairingStates: () => [
          {
            nodeId: "node-exec",
            connId: "conn-exec",
            displayName: "Execution Node",
            platform: "linux",
            deviceFamily: "Linux",
            caps: ["session.host"],
            declaredCommands: declared,
            commands: effective,
            connectedAtMs: 123,
          },
        ],
      },
    };

    const listRespond = vi.fn();
    await environmentsHandlers["environments.list"]?.({
      params: { runtimeId: "codex" },
      respond: listRespond,
      client: { connect: { scopes: ["operator.write"] } },
      context,
    } as never);
    const listPayload = listRespond.mock.calls.at(0)?.[1] as
      | {
          environments: Array<{
            id: string;
            capabilities?: string[];
            invocableCommands?: string[];
            requiredNodeCommand?: { command: string; state: string };
          }>;
        }
      | undefined;
    const listed = listPayload?.environments.find(
      (environment) => environment.id === "node:node-exec",
    );

    expect(listed?.invocableCommands ?? []).toEqual(expected);
    expect(listed?.requiredNodeCommand).toEqual({
      command: "codex.exec-server.stdio.v1",
      state,
    });
    for (const command of effective) {
      expect(listed?.capabilities).toContain(command);
    }

    const statusRespond = vi.fn();
    await environmentsHandlers["environments.status"]?.({
      params: { environmentId: "node:node-exec" },
      respond: statusRespond,
      context,
    } as never);
    const statusPayload = statusRespond.mock.calls.at(0)?.[1] as
      | { invocableCommands?: string[] }
      | undefined;
    expect(statusPayload?.invocableCommands ?? []).toEqual(expected);
  });

  it("requires write scope only for runtime-specific command state", async () => {
    const context = {
      logGateway: { warn: vi.fn() },
      getRuntimeConfig: () => ({}),
      nodeRegistry: { listConnectedForPairingStates: () => [] },
    };
    const readOnlyRespond = vi.fn();
    await environmentsHandlers["environments.list"]?.({
      params: { runtimeId: "codex" },
      respond: readOnlyRespond,
      client: { connect: { scopes: ["operator.read"] } },
      context,
    } as never);
    expect(readOnlyRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN", message: "missing scope: operator.write" }),
    );

    const inventoryRespond = vi.fn();
    await environmentsHandlers["environments.list"]?.({
      params: {},
      respond: inventoryRespond,
      client: { connect: { scopes: ["operator.read"] } },
      context,
    } as never);
    expect(inventoryRespond.mock.calls.at(0)?.[0]).toBe(true);
  });
});
