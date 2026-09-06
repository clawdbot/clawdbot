import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/index.js";
import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { selectDevicePlacementCandidates } from "./device-placement-selector.js";
import { bindDeviceWorkerAvailability, type DeviceWorkerAvailability } from "./device-provider.js";

const WORKER_REQUIREMENT: DevicePlacementRequirement = {
  requiredNodeCommands: [],
  consumesWorkerSlot: true,
};
const REMOTE_REQUIREMENT: DevicePlacementRequirement = {
  requiredNodeCommands: ["runtime.exec"],
  consumesWorkerSlot: false,
};
const CONFIG: OpenClawConfig = {
  gateway: { nodes: { commands: { allow: ["runtime.exec"] } } },
};

function nodeEnvironment(
  deviceId: string,
  available: number,
  overrides: Partial<EnvironmentSummary> = {},
): EnvironmentSummary {
  return {
    id: `node:${deviceId}`,
    type: "node",
    status: "available",
    sessionHost: true,
    workerSlots: { total: Math.max(available, 1), available },
    ...overrides,
  };
}

function nodeProof(environment: EnvironmentSummary): NodeWorkerSupervisorNodeProof {
  const deviceId = environment.id.slice("node:".length);
  return {
    nodeId: deviceId,
    connId: `connection-${deviceId}`,
    pairingIdentity: `identity-${deviceId}`,
    pairingGeneration: `generation-${deviceId}`,
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: {
      enabled: true,
      capacity: environment.workerSlots ?? { total: 1, available: 0 },
    },
    commands: ["runtime.exec"],
  };
}

async function selectNodes(
  environments: EnvironmentSummary[],
  options: {
    requirement?: DevicePlacementRequirement;
    config?: OpenClawConfig;
    commands?: string[];
    declaredCommands?: string[];
    availability?: (deviceId: string) => Promise<DeviceWorkerAvailability>;
  } = {},
) {
  const proofs = new Map(
    environments.map((environment) => {
      const proof = {
        ...nodeProof(environment),
        ...(options.commands ? { commands: options.commands } : {}),
        ...(options.declaredCommands ? { declaredCommands: options.declaredCommands } : {}),
      };
      return [proof.nodeId, proof] as const;
    }),
  );
  const environmentService = {};
  bindDeviceWorkerAvailability(
    environmentService,
    options.availability ??
      (async (deviceId) => {
        const node = proofs.get(deviceId);
        return node
          ? { available: true, node }
          : { available: false, unavailableReason: "unpaired" };
      }),
  );
  return await selectDevicePlacementCandidates({
    environments,
    nodeRegistry: { get: (deviceId) => proofs.get(deviceId) as never },
    environmentService,
    requirement: options.requirement ?? WORKER_REQUIREMENT,
    runtimeId: "test-runtime",
    config: options.config ?? CONFIG,
  });
}

describe("paired-device automatic placement selection", () => {
  it("prefers hosts with the most available worker slots", async () => {
    const result = await selectNodes([
      nodeEnvironment("alpha", 1),
      nodeEnvironment("charlie", 2),
      nodeEnvironment("bravo", 4),
    ]);

    expect(result).toEqual({
      ok: true,
      candidates: [
        { deviceId: "bravo", availableSlots: 4 },
        { deviceId: "charlie", availableSlots: 2 },
        { deviceId: "alpha", availableSlots: 1 },
      ],
    });
  });

  it("ranks current worker capacity instead of stale environment snapshots", async () => {
    const environments = [
      nodeEnvironment("alpha", 9),
      nodeEnvironment("bravo", 1),
      nodeEnvironment("charlie", 5),
    ];
    const liveCapacity = new Map([
      ["alpha", 2],
      ["bravo", 4],
      ["charlie", 2],
    ]);
    const currentNodes = new Map(
      environments.map((environment) => {
        const node = nodeProof(environment);
        return [
          node.nodeId,
          {
            ...node,
            workerHost: {
              ...node.workerHost,
              capacity: { total: 9, available: liveCapacity.get(node.nodeId) ?? 0 },
            },
          },
        ] as const;
      }),
    );

    const result = await selectNodes(environments, {
      availability: async (deviceId) => ({ available: true, node: currentNodes.get(deviceId) }),
    });

    expect(result).toEqual({
      ok: true,
      candidates: [
        { deviceId: "bravo", availableSlots: 4 },
        { deviceId: "alpha", availableSlots: 2 },
        { deviceId: "charlie", availableSlots: 2 },
      ],
    });
  });

  it("breaks equal-capacity ties by device identity, independently of catalog order", async () => {
    const result = await selectNodes([
      nodeEnvironment("charlie", 2),
      nodeEnvironment("alpha", 2),
      nodeEnvironment("bravo", 2),
    ]);

    expect(result).toEqual({
      ok: true,
      candidates: [
        { deviceId: "alpha", availableSlots: 2 },
        { deviceId: "bravo", availableSlots: 2 },
        { deviceId: "charlie", availableSlots: 2 },
      ],
    });
  });

  it("excludes disconnected, full, outdated, non-host, and no-longer-paired nodes", async () => {
    const environments = [
      nodeEnvironment("full", 0),
      nodeEnvironment("outdated", 3, {
        sessionHost: false,
        issues: [NODE_RUNNER_UPDATE_REQUIRED_ISSUE],
      }),
      nodeEnvironment("offline", 3, { status: "unavailable" }),
      nodeEnvironment("not-host", 3, { sessionHost: false }),
      nodeEnvironment("unpaired", 3),
      nodeEnvironment("eligible", 1),
    ];
    const proofs = new Map(environments.map((node) => [node.id, nodeProof(node)]));
    const result = await selectNodes(environments, {
      availability: async (deviceId) =>
        deviceId === "unpaired"
          ? { available: false, unavailableReason: "unpaired" }
          : { available: true, node: proofs.get(`node:${deviceId}`) },
    });

    expect(result).toEqual({
      ok: true,
      candidates: [{ deviceId: "eligible", availableSlots: 1 }],
    });
  });

  it("orders remote-exec hosts only by device identity, including hosts with no free slots", async () => {
    const result = await selectNodes(
      [nodeEnvironment("charlie", 5), nodeEnvironment("alpha", 0), nodeEnvironment("bravo", 2)],
      { requirement: REMOTE_REQUIREMENT },
    );

    expect(result).toEqual({
      ok: true,
      candidates: [
        { deviceId: "alpha", availableSlots: 0 },
        { deviceId: "bravo", availableSlots: 2 },
        { deviceId: "charlie", availableSlots: 5 },
      ],
    });
  });

  it.each([
    {
      name: "no paired session host",
      environments: [nodeEnvironment("plain-node", 2, { sessionHost: false })],
      message: "pair a node, enable session hosting",
    },
    {
      name: "all hosts disconnected",
      environments: [nodeEnvironment("offline", 2, { status: "unavailable" })],
      message: "all paired session-host nodes are disconnected",
    },
    {
      name: "all hosts full",
      environments: [nodeEnvironment("full", 0)],
      message: "all paired session-host nodes are at capacity",
    },
    {
      name: "an outdated node whose live runner can no longer advertise session hosting",
      environments: [
        nodeEnvironment("outdated", 0, {
          sessionHost: false,
          issues: [NODE_RUNNER_UPDATE_REQUIRED_ISSUE],
        }),
      ],
      message: "run openclaw update, then reconnect",
    },
  ])("explains $name with an operator recovery action", async ({ environments, message }) => {
    const result = await selectNodes(environments);

    expect(result).toEqual({ ok: false, error: expect.stringContaining(message) });
  });

  it.each([
    {
      name: "a declared command missing from Gateway policy",
      commands: ["runtime.exec"],
      config: {},
      guidance:
        /review gateway\.nodes\.commands\.allow.*gateway\.nodes\.commands\.deny.*deny overrides allow/,
      wrongGuidance: /plugin|reconnect|approve/,
    },
    {
      name: "an explicit deny overriding an explicit allow",
      commands: ["runtime.exec"],
      config: {
        gateway: { nodes: { commands: { allow: ["runtime.exec"], deny: ["runtime.exec"] } } },
      },
      guidance:
        /review gateway\.nodes\.commands\.allow.*gateway\.nodes\.commands\.deny.*deny overrides allow/,
      wrongGuidance: /plugin|reconnect|approve/,
    },
    {
      name: "an allowed command missing from a nonempty device surface",
      commands: ["runtime.other"],
      config: CONFIG,
      guidance: /plugin.*device.*reconnect.*approve/,
      wrongGuidance: /commands\.allow/,
    },
    {
      name: "an allowed command on a device declaring no commands",
      commands: [],
      config: CONFIG,
      guidance: /plugin.*device.*reconnect.*approve/,
      wrongGuidance: /commands\.allow/,
    },
    {
      name: "a declared command awaiting pairing approval",
      commands: [],
      declaredCommands: ["runtime.exec"],
      config: CONFIG,
      guidance: /pending.*approval.*openclaw nodes pending.*openclaw nodes approve/,
      wrongGuidance: /commands\.allow|plugin|reconnect/,
    },
  ])("explains $name with the matching recovery action", async (scenario) => {
    const environment = nodeEnvironment("runner", 1);
    const result = await selectNodes([environment], {
      requirement: REMOTE_REQUIREMENT,
      config: scenario.config,
      commands: scenario.commands,
      declaredCommands: scenario.declaredCommands,
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("runtime.exec"),
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("runner"),
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(scenario.guidance),
    });
    expect(result).not.toEqual({
      ok: false,
      error: expect.stringMatching(scenario.wrongGuidance),
    });
  });

  it("rejects runtimes that do not declare paired-device placement support", async () => {
    const result = await selectDevicePlacementCandidates({
      environments: [nodeEnvironment("eligible", 1)],
      nodeRegistry: { get: () => undefined },
      environmentService: {},
      requirement: undefined,
      runtimeId: "cloud-only",
      config: CONFIG,
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("runtime cloud-only does not support paired-device placement"),
    });
  });
});
