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

beforeEach(() => {
  vi.mocked(listDevicePairing).mockResolvedValue({ paired: [] } as never);
  vi.mocked(listNodePairing).mockResolvedValue({ paired: [] } as never);
});

describe("node environment command authority", () => {
  it.each([
    {
      name: "projects sorted approved commands while preserving denied declarations",
      declared: ["system.which", "codex.exec-server.stdio.v1", "system.run", "system.run"],
      allow: ["codex.exec-server.stdio.v1"],
      deny: ["system.run"],
      expected: ["codex.exec-server.stdio.v1", "system.which"],
    },
    {
      name: "withholds declared commands without explicit Gateway approval",
      declared: ["codex.exec-server.stdio.v1"],
      allow: [],
      deny: [],
      expected: [],
    },
    {
      name: "honors Gateway denial even when the command was explicitly allowed",
      declared: ["codex.exec-server.stdio.v1"],
      allow: ["codex.exec-server.stdio.v1"],
      deny: ["codex.exec-server.stdio.v1"],
      expected: [],
    },
    {
      name: "does not project approved commands the node did not declare",
      declared: ["system.which"],
      allow: ["codex.exec-server.stdio.v1"],
      deny: [],
      expected: ["system.which"],
    },
  ])("$name", async ({ declared, allow, deny, expected }) => {
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
            commands: declared,
            connectedAtMs: 123,
          },
        ],
      },
    };

    const listRespond = vi.fn();
    await environmentsHandlers["environments.list"]?.({
      params: {},
      respond: listRespond,
      context,
    } as never);
    const listPayload = listRespond.mock.calls.at(0)?.[1] as
      | {
          environments: Array<{
            id: string;
            capabilities?: string[];
            invocableCommands?: string[];
          }>;
        }
      | undefined;
    const listed = listPayload?.environments.find(
      (environment) => environment.id === "node:node-exec",
    );

    expect(listed?.invocableCommands ?? []).toEqual(expected);
    for (const command of declared) {
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
});
