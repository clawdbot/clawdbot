/**
 * Tests for environment gateway methods and configured environment discovery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { listNodePairing } from "../../infra/node-pairing.js";
import type { WorkerEnvironmentRecord } from "../worker-environments/store.js";
import type { WorkerTunnelStatus } from "../worker-environments/tunnel-contract.js";
import { environmentsHandlers, summarizeWorkerEnvironment } from "./environments.js";

vi.mock("../../infra/device-pairing.js", () => ({
  listDevicePairing: vi.fn(),
  resolveNodePairingState: vi.fn(),
}));

vi.mock("../../infra/node-pairing.js", () => ({
  listNodePairing: vi.fn(),
}));

const NOW = 10_000;

type TestWorkerRecord = WorkerEnvironmentRecord & { tunnelStatus: WorkerTunnelStatus };

type TestWorkerService = {
  list: () => TestWorkerRecord[];
  get: (environmentId: string) => TestWorkerRecord | undefined;
  create: (profileId: string, idempotencyKey: string) => Promise<TestWorkerRecord>;
  destroy: (environmentId: string) => Promise<TestWorkerRecord>;
  destroyUnattached: (environmentId: string) => Promise<TestWorkerRecord>;
};

function mockContext(
  workerEnvironmentService?: TestWorkerService,
  reconcileActive: (environmentId?: string) => Promise<void> = vi.fn(async () => {}),
  forceDestroyEnvironment: (environmentId: string) => Promise<TestWorkerRecord> = vi.fn(async () =>
    workerRecord({ state: "destroyed" }),
  ),
) {
  return {
    logGateway: {
      warn: vi.fn(),
    },
    nodeRegistry: {
      listConnectedForPairingStates: () => [
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
    workerEnvironmentService,
    ...(workerEnvironmentService
      ? {
          workerPlacementDispatchService: {
            dispatch: vi.fn(),
            forceDestroyEnvironment,
            reconcileActive,
          },
          getRuntimeConfig: () => ({
            cloudWorkers: {
              profiles: {
                zeta: { provider: "static-ssh", settings: {} },
                aws: { provider: "crabbox", settings: {} },
              },
            },
          }),
        }
      : {}),
  };
}

function workerRecord(overrides: Partial<TestWorkerRecord> = {}): TestWorkerRecord {
  return {
    environmentId: "worker-1",
    providerId: "static-ssh",
    profileId: "development",
    profileSnapshot: { settings: {} },
    provisionOperationId: "provision:worker-1",
    leaseId: "lease-1",
    sshEndpoint: {
      host: "worker.example.test",
      port: 22,
      user: "openclaw",
      hostKey: ["ssh-ed25519", "AAAA"].join(" "),
      keyRef: { source: "file", provider: "default", id: "/worker/private-key" },
    },
    state: "ready",
    attachedSessionIds: [],
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    stateChangedAtMs: 1_000,
    idleSinceAtMs: null,
    lastError: null,
    tunnelStatus: "stopped",
    ...overrides,
  } as TestWorkerRecord;
}

function workerService(overrides: Partial<TestWorkerService> = {}) {
  return {
    list: vi.fn(() => []),
    get: vi.fn(() => undefined),
    create: vi.fn(async () => workerRecord()),
    destroy: vi.fn(async () => workerRecord({ state: "destroyed" })),
    destroyUnattached: vi.fn(async () => workerRecord({ state: "destroyed" })),
    ...overrides,
  };
}

async function callEnvironmentMethod(
  method:
    | "environments.list"
    | "environments.status"
    | "environments.create"
    | "environments.destroy",
  params: unknown,
  options: {
    service?: TestWorkerService;
    reconcileActive?: (environmentId?: string) => Promise<void>;
    forceDestroyEnvironment?: (environmentId: string) => Promise<TestWorkerRecord>;
  } = {},
) {
  const respond = vi.fn();
  await environmentsHandlers[method]?.({
    params: params as Record<string, unknown>,
    respond,
    context: mockContext(options.service, options.reconcileActive, options.forceDestroyEnvironment),
  } as never);
  const call = respond.mock.calls.at(0);
  if (call === undefined) {
    throw new Error("expected environments handler to respond");
  }
  return call;
}

class FakeWorkerServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
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

afterEach(() => vi.restoreAllMocks());

describe("environment gateway methods", () => {
  it("keeps the existing gateway and node projection unchanged without a worker service", async () => {
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

  it("appends worker metadata with stable sessions and elapsed times", async () => {
    const service = workerService({
      list: vi.fn(() => [
        workerRecord({
          state: "idle",
          attachedSessionIds: ["session-z", "session-a", "session-z", " "],
          idleSinceAtMs: 6_000,
        }),
      ]),
    });
    const [ok, payload] = await callEnvironmentMethod("environments.list", {}, { service });

    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      profiles: [
        { id: "aws", providerId: "crabbox" },
        { id: "zeta", providerId: "static-ssh" },
      ],
      environments: [
        { id: "gateway", type: "local" },
        { id: "node:node-live", type: "node" },
        { id: "node:node-offline", type: "node" },
        {
          id: "worker-1",
          type: "worker",
          status: "available",
          worker: {
            providerId: "static-ssh",
            leaseId: "lease-1",
            state: "idle",
            ageMs: 9_000,
            idleMs: 4_000,
            attachedSessionIds: ["session-a", "session-z"],
            tunnelStatus: "stopped",
          },
        },
      ],
    });
    const worker = (payload as { environments: Array<Record<string, unknown>> }).environments.at(
      -1,
    );
    expect(worker).not.toHaveProperty("sshEndpoint");
    expect(worker?.worker).not.toHaveProperty("sshEndpoint");
    expect(worker?.worker).not.toHaveProperty("keyRef");
  });

  it.each([
    ["requested", "starting"],
    ["ready", "available"],
    ["draining", "stopping"],
    ["destroyed", "unavailable"],
    ["failed", "error"],
    ["orphaned", "error"],
  ] as const)("maps worker state %s to %s", (state, status) => {
    expect(summarizeWorkerEnvironment(workerRecord({ state }), NOW).status).toBe(status);
  });

  it("returns status for one node environment", async () => {
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

  it("returns status for one worker without listing providers", async () => {
    const get = vi.fn(() => workerRecord({ state: "attached" }));
    const service = workerService({ get });
    const [ok, payload] = await callEnvironmentMethod(
      "environments.status",
      { environmentId: "worker-1" },
      { service },
    );

    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      id: "worker-1",
      status: "available",
      worker: { state: "attached", ageMs: 9_000 },
    });
    expect(get).toHaveBeenCalledWith("worker-1");
    expect(service.list).not.toHaveBeenCalled();
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

  it("preserves gateway listing and hides durable-store details when worker reads fail", async () => {
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

    const listResult = await callEnvironmentMethod(
      "environments.list",
      {},
      {
        service: listFailure,
      },
    );
    const statusResult = await callEnvironmentMethod(
      "environments.status",
      { environmentId: "worker-missing" },
      { service: statusFailure },
    );

    expect(listResult[0]).toBe(true);
    const listed = (listResult[1] as { environments: Array<{ id: string; type: string }> })
      .environments;
    // Gateway/node inventory survives a damaged worker store; worker rows are omitted.
    expect(listed.map((entry) => entry.id)).toEqual([
      "gateway",
      "node:node-live",
      "node:node-offline",
    ]);
    expect(listed.every((entry) => entry.type !== "worker")).toBe(true);
    expect(statusResult[2]).toEqual({
      code: ErrorCodes.UNAVAILABLE,
      message: "environment status unavailable",
    });
    expect(JSON.stringify([listResult, statusResult])).not.toContain(secret);
  });

  it("keeps worker creation unavailable until a provider profile is configured", async () => {
    const [ok, , error] = await callEnvironmentMethod("environments.create", {
      profileId: "development",
      idempotencyKey: "request-1",
    });

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: "cloud worker environments are not configured",
    });
  });

  it("creates a worker from a configured profile", async () => {
    const create = vi.fn(async () => workerRecord());
    const service = workerService({ create });
    const [ok, payload] = await callEnvironmentMethod(
      "environments.create",
      { profileId: "development", idempotencyKey: "request-1" },
      { service },
    );

    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledWith("development", "request-1");
    expect(payload).toMatchObject({
      id: "worker-1",
      type: "worker",
      worker: { providerId: "static-ssh", state: "ready" },
    });
  });

  it("rejects an unknown worker profile", async () => {
    const service = workerService({
      create: vi.fn(async () => {
        throw new FakeWorkerServiceError("profile_not_found", "unknown worker profile: missing");
      }),
    });
    const [ok, , error] = await callEnvironmentMethod(
      "environments.create",
      { profileId: "missing", idempotencyKey: "request-1" },
      { service },
    );

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: "unknown worker profile: missing",
    });
  });

  it("hides provider failure details when worker creation fails", async () => {
    const service = workerService({
      create: vi.fn(async () => {
        throw new FakeWorkerServiceError("provider_failure", "private endpoint details");
      }),
    });
    const [ok, , error] = await callEnvironmentMethod(
      "environments.create",
      { profileId: "development", idempotencyKey: "request-1" },
      { service },
    );

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.UNAVAILABLE,
      message: "worker environment creation failed",
    });
  });

  it("destroys an environment idempotently", async () => {
    const destroyed = workerRecord({ state: "destroyed" });
    const destroyUnattached = vi.fn(async () => destroyed);
    const service = workerService({ destroyUnattached });
    const first = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1" },
      { service },
    );
    const second = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1" },
      { service },
    );

    expect(first).toEqual(second);
    expect(first[0]).toBe(true);
    expect(first[1]).toMatchObject({
      id: "worker-1",
      status: "unavailable",
      worker: { state: "destroyed" },
    });
    expect(destroyUnattached).toHaveBeenCalledTimes(2);
  });

  it("rejects raw destruction of a session-attached worker", async () => {
    const service = workerService({
      destroyUnattached: vi.fn(async () => {
        throw new FakeWorkerServiceError(
          "invalid_state",
          "Attached cloud workers must be stopped through sessions.reclaim",
        );
      }),
    });

    const [ok, , error] = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1" },
      { service },
    );

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: "Attached cloud workers must be stopped through sessions.reclaim",
    });
  });

  it("durably abandons placement ownership before forced destruction", async () => {
    const service = workerService();
    const forceDestroyEnvironment = vi.fn(
      async (environmentId: string) => await service.destroy(environmentId),
    );

    const [ok, payload] = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1", force: true },
      { service, forceDestroyEnvironment },
    );

    expect(ok).toBe(true);
    expect(payload).toMatchObject({ worker: { state: "destroyed" } });
    expect(forceDestroyEnvironment).toHaveBeenCalledExactlyOnceWith("worker-1");
    expect(service.destroy).toHaveBeenCalledExactlyOnceWith("worker-1");
    expect(service.destroyUnattached).not.toHaveBeenCalled();
  });

  it("reconciles active placements before returning destroyed worker state", async () => {
    const service = workerService();
    const reconcileActive = vi.fn(async () => {});

    const [ok, payload] = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1" },
      { service, reconcileActive },
    );

    expect(ok).toBe(true);
    expect(payload).toMatchObject({ worker: { state: "destroyed" } });
    expect(reconcileActive).toHaveBeenCalledExactlyOnceWith("worker-1");
    expect(service.destroyUnattached).toHaveBeenCalledBefore(reconcileActive);
  });

  it("preserves destroyed worker success when placement reconciliation fails", async () => {
    const service = workerService();
    const reconcileActive = vi.fn(async () => {
      throw new Error("temporary reconciliation failure");
    });

    const [ok, payload] = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1" },
      { service, reconcileActive },
    );

    expect(ok).toBe(true);
    expect(payload).toMatchObject({ worker: { state: "destroyed" } });
    expect(reconcileActive).toHaveBeenCalledExactlyOnceWith("worker-1");
  });

  it("rejects an unknown worker environment on destroy", async () => {
    const service = workerService({
      destroyUnattached: vi.fn(async () => {
        throw new FakeWorkerServiceError("environment_not_found", "unknown environmentId");
      }),
    });
    const [ok, , error] = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "missing" },
      { service },
    );

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: "unknown environmentId",
    });
  });

  it("returns unavailable without provider details when destroy fails", async () => {
    const service = workerService({
      destroyUnattached: vi.fn(async () => {
        throw new FakeWorkerServiceError("provider_not_found", "private provider details");
      }),
    });
    const [ok, , error] = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1" },
      { service },
    );

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.UNAVAILABLE,
      message: "worker environment destruction failed",
    });
  });
});
