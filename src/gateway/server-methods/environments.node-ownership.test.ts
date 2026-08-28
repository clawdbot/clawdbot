import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { listNodePairing } from "../../infra/device-pairing-node.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { collectNodeCatalogRuntimeState } from "../node-registry-private.js";
import type {
  WorkerEnvironmentServiceContract,
  WorkerEnvironmentServiceRecord,
} from "../worker-environments/service-contract.js";
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

type TestWorkerService = Pick<WorkerEnvironmentServiceContract, "get" | "list">;

const CONNECTED_NODE = {
  nodeId: "node-live",
  connId: "conn-live",
  displayName: "Live Node",
  platform: "linux",
  caps: [],
  commands: ["system.run"],
  connectedAtMs: 123,
};

function workerRecord(
  overrides: Partial<WorkerEnvironmentServiceRecord> = {},
): WorkerEnvironmentServiceRecord {
  return {
    environmentId: "worker-1",
    providerId: "static-ssh",
    leaseId: "lease-1",
    sharedHost: false,
    state: "ready",
    ownerEpoch: 1,
    createdAtMs: 1_000,
    idleSinceAtMs: null,
    attachedSessionIds: [],
    desktopAvailable: false,
    desktopApps: [],
    tunnelStatus: "stopped",
    ...overrides,
  };
}

function workerService(overrides: Partial<TestWorkerService> = {}): TestWorkerService {
  return {
    list: vi.fn(() => []),
    get: vi.fn(() => undefined),
    ...overrides,
  };
}

async function callEnvironmentMethod(
  method: "environments.list" | "environments.status",
  params: unknown,
  service: TestWorkerService,
) {
  const respond = vi.fn();
  await environmentsHandlers[method]?.({
    params: params as Record<string, unknown>,
    respond,
    context: {
      logGateway: { warn: vi.fn() },
      nodeRegistry: {
        listConnectedForPairingStates: () => [CONNECTED_NODE],
      },
      workerEnvironmentService: service,
      getRuntimeConfig: () => ({}),
    },
  } as never);
  const call = respond.mock.calls.at(0);
  if (!call) {
    throw new Error("expected environments handler to respond");
  }
  return call;
}

beforeEach(() => {
  vi.mocked(collectNodeCatalogRuntimeState).mockReturnValue({
    sessionHostNodeIds: new Set(),
    issuesByNodeId: new Map(),
    workerSlotsByNodeId: new Map(),
    workerBundleByNodeId: new Map(),
  });
  vi.mocked(listDevicePairing).mockResolvedValue({ paired: [] } as never);
  vi.mocked(listNodePairing).mockResolvedValue({ paired: [] } as never);
});

afterEach(() => vi.restoreAllMocks());

describe("environment node ownership", () => {
  it.each([
    {
      name: "requested worker without a node binding",
      state: "requested",
      status: "starting",
      visible: true,
      providerId: "static-ssh",
      nodeDeviceId: undefined,
    },
    {
      name: "ready cloud worker",
      state: "ready",
      status: "available",
      visible: false,
      providerId: "static-ssh",
      nodeDeviceId: "node-live",
    },
    {
      name: "draining cloud worker",
      state: "draining",
      status: "stopping",
      visible: false,
      providerId: "static-ssh",
      nodeDeviceId: "node-live",
    },
    {
      name: "destroyed cloud worker",
      state: "destroyed",
      status: "unavailable",
      visible: true,
      providerId: "static-ssh",
      nodeDeviceId: "node-live",
    },
    {
      name: "failed cloud worker retaining its node binding",
      state: "failed",
      status: "error",
      visible: false,
      providerId: "static-ssh",
      nodeDeviceId: "node-live",
    },
    {
      name: "failed cloud worker after enrollment retirement",
      state: "failed",
      status: "error",
      visible: true,
      providerId: "static-ssh",
      nodeDeviceId: undefined,
    },
    {
      name: "orphaned cloud worker",
      state: "orphaned",
      status: "error",
      visible: false,
      providerId: "static-ssh",
      nodeDeviceId: "node-live",
    },
    {
      name: "paired-device provider worker",
      state: "ready",
      status: "available",
      visible: true,
      providerId: "device",
      nodeDeviceId: "node-live",
    },
  ] as const)("projects $name without losing pairing ownership", async (scenario) => {
    const error =
      scenario.state === "orphaned" ? "provider no longer recognizes the lease" : undefined;
    const service = workerService({
      list: vi.fn(() => [
        workerRecord({
          state: scenario.state,
          providerId: scenario.providerId,
          nodeDeviceId: scenario.nodeDeviceId,
          ...(error ? { error } : {}),
        }),
      ]),
    });

    const [ok, payload] = await callEnvironmentMethod("environments.list", {}, service);
    const environments = (payload as { environments: Array<Record<string, unknown>> }).environments;

    expect(ok).toBe(true);
    expect(environments.some((entry) => entry.id === "node:node-live")).toBe(scenario.visible);
    expect(environments.find((entry) => entry.id === "worker-1")).toMatchObject({
      type: "worker",
      status: scenario.status,
      worker: {
        providerId: scenario.providerId,
        state: scenario.state,
        ...(error ? { error } : {}),
      },
    });
  });

  it("fails closed and redacts worker inventory read failures", async () => {
    const secret = "private SecretRef and database path";
    const listFailure = workerService({
      list: vi.fn(() => {
        throw new Error(secret);
      }),
    });
    const statusFailure = workerService({
      get: vi.fn(() => {
        throw new Error(secret);
      }),
    });

    const listResult = await callEnvironmentMethod("environments.list", {}, listFailure);
    const nodeStatusResult = await callEnvironmentMethod(
      "environments.status",
      { environmentId: "node:node-live" },
      listFailure,
    );
    const workerStatusResult = await callEnvironmentMethod(
      "environments.status",
      { environmentId: "worker-missing" },
      statusFailure,
    );

    const inventoryFailure = {
      code: ErrorCodes.UNAVAILABLE,
      message: "Error: environment inventory unavailable",
    };
    expect(listResult).toEqual([false, undefined, inventoryFailure]);
    expect(nodeStatusResult).toEqual([false, undefined, inventoryFailure]);
    expect(workerStatusResult[2]).toEqual({
      code: ErrorCodes.UNAVAILABLE,
      message: "environment status unavailable",
    });
    expect(JSON.stringify([listResult, nodeStatusResult, workerStatusResult])).not.toContain(
      secret,
    );
  });
});
