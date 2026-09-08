import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listNodePairing } from "../../infra/device-pairing-node.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { NodeRegistry } from "../node-registry.js";
import { environmentsHandlers } from "./environments.js";

const registries: NodeRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) {
    for (const node of registry.listConnected()) {
      registry.unregister(node.connId);
    }
  }
  vi.restoreAllMocks();
});

vi.mock("../../infra/device-pairing.js", () => ({
  listDevicePairing: vi.fn(),
  resolveNodePairingState: vi.fn(),
}));

vi.mock("../../infra/device-pairing-node.js", () => ({
  listNodePairing: vi.fn(),
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
      approved: ["system.which", "codex.exec-server.stdio.v1", "system.run"],
      allow: ["codex.exec-server.stdio.v1"],
      deny: ["system.run"],
      expected: ["codex.exec-server.stdio.v1", "system.which"],
      state: "invocable",
    },
    {
      name: "declared command pending pairing approval",
      declared: ["codex.exec-server.stdio.v1"],
      approved: [],
      allow: ["codex.exec-server.stdio.v1"],
      deny: [],
      expected: [],
      state: "pending-approval",
    },
    {
      name: "declared command blocked by current Gateway policy",
      declared: ["codex.exec-server.stdio.v1"],
      approved: ["codex.exec-server.stdio.v1"],
      allow: ["codex.exec-server.stdio.v1"],
      deny: ["codex.exec-server.stdio.v1"],
      expected: [],
      state: "unauthorized",
    },
    {
      name: "approved command removed from the effective surface by a hot deny",
      declared: ["codex.exec-server.stdio.v1"],
      approved: ["codex.exec-server.stdio.v1"],
      initialPolicy: { allow: ["codex.exec-server.stdio.v1"], deny: [] },
      allow: ["codex.exec-server.stdio.v1"],
      deny: ["codex.exec-server.stdio.v1"],
      expected: [],
      state: "unauthorized",
    },
    {
      name: "approved command removed from the effective surface after allow removal",
      declared: ["codex.exec-server.stdio.v1"],
      approved: ["codex.exec-server.stdio.v1"],
      initialPolicy: { allow: ["codex.exec-server.stdio.v1"], deny: [] },
      allow: [],
      deny: [],
      expected: [],
      state: "unauthorized",
    },
    {
      name: "required command blocked while an unrelated declaration awaits approval",
      declared: ["codex.exec-server.stdio.v1", "fixture.unrelated"],
      approved: ["codex.exec-server.stdio.v1"],
      allow: [],
      deny: [],
      expected: [],
      state: "unauthorized",
    },
    {
      name: "command not declared by the node",
      declared: [],
      approved: [],
      allow: ["codex.exec-server.stdio.v1"],
      deny: [],
      expected: [],
      state: "undeclared",
    },
  ])("projects $name", async (testCase) => {
    const { declared, approved, allow, deny, expected, state } = testCase;
    const commandPolicy = { allow, deny };
    const initialPolicy = "initialPolicy" in testCase ? testCase.initialPolicy : undefined;
    let config = { gateway: { nodes: { commands: initialPolicy ?? commandPolicy } } };
    const registry = new NodeRegistry({ getConfig: () => config });
    registries.push(registry);
    const node = registry.register(
      {
        connId: "conn-exec",
        socket: { readyState: 1, bufferedAmount: 0, send: vi.fn() },
        connect: {
          client: {
            id: "node-host",
            mode: "node",
            displayName: "Execution Node",
            platform: "linux",
            deviceFamily: "Linux",
          },
          device: { id: "node-exec" },
          caps: ["session.host"],
          declaredCommands: declared,
          commands: approved,
        },
      } as never,
      { pairingIdentity: "node-exec" },
    );
    if (initialPolicy) {
      // Reload the registered connection so withholding comes from its real policy owner.
      expect(node.commands).toEqual(approved);
      config = { gateway: { nodes: { commands: commandPolicy } } };
      registry.refreshRuntimePolicy(config);
    }
    vi.spyOn(registry, "listConnectedForPairingStates").mockReturnValue([node]);
    const context = {
      logGateway: { warn: vi.fn() },
      getRuntimeConfig: () => config,
      nodeRegistry: registry,
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
    for (const command of node.commands) {
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
