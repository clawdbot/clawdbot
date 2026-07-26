import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import type { GatewayRequestHandlers } from "./types.js";

const spawnSubagentDirectMock = vi.hoisted(() =>
  vi.fn<typeof spawnSubagentDirect>(async () => ({
    status: "accepted",
    childSessionKey: "agent:ai-engineer:subagent:real-child",
    runId: "run-real-child",
    mode: "run",
  })),
);

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: spawnSubagentDirectMock,
}));
vi.mock("./agent-job.js", () => ({ waitForAgentJob: vi.fn(async () => null) }));
vi.mock("../../tasks/task-status-access.js", () => ({
  findTaskByRunIdForStatus: vi.fn(() => ({ status: "running", startedAt: 5 })),
}));

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

let agenticOsRuntimeContractHandlers: GatewayRequestHandlers;
let runtimeStateDir: string | undefined;

const acquireParams = {
  client_lease_id: "lease-a",
  idempotency_key: "lease-idem-a",
  run_id: "run-a",
  phase: "phase-b",
  transition_id: "transition-a",
  agent_id: "ai-engineer",
  requester_agent_id: "main",
  ttl_ms: 60_000,
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const sessionMetadata = {
  run_id: "run-a",
  transition_id: "transition-a",
  client_request_id: "spawn-a",
  idempotency_key: "spawn-idem-a",
  phase: "phase-b",
  agent_id: "ai-engineer",
  task_digest: sha256Hex("verify metadata contract"),
};

async function invoke(method: string, params: Record<string, unknown> = {}, deviceId?: string) {
  const respond = vi.fn();
  const handler = agenticOsRuntimeContractHandlers[method];
  if (!handler) {
    throw new Error(`missing handler: ${method}`);
  }
  await handler({
    params,
    respond: respond as never,
    context: {
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main" }, { id: "ai-engineer" }] },
      }),
      loadGatewayModelCatalog: async () => [],
      loadGatewayModelCatalogSnapshot: async () => ({ entries: [] }),
      logGateway: { debug: () => {}, error: () => {}, warn: () => {} },
    } as never,
    client: deviceId
      ? ({
          connect: {
            device: { id: deviceId },
            scopes: ["operator.admin", "operator.read", "operator.write"],
          },
        } as never)
      : null,
    req: { type: "req", id: "req-1", method },
    isWebchatConnect: () => false,
  });
  const call = respond.mock.calls[0] as RespondCall | undefined;
  if (!call) {
    throw new Error(`missing response for ${method}`);
  }
  return call;
}

function payload(call: RespondCall): Record<string, unknown> {
  expect(call[0], call[2]?.message).toBe(true);
  return call[1] as Record<string, unknown>;
}

function expectInvalid(call: RespondCall, message: string) {
  expect(call[0]).toBe(false);
  expect(call[2]?.message).toContain(message);
}

function spawnParamsFor(
  gatewayLeaseId: string,
  overrides: Partial<typeof sessionMetadata> & { task?: string } = {},
) {
  const { task, ...metadataOverrides } = overrides;
  const resolvedTask = task ?? "verify metadata contract";
  const metadata = {
    ...sessionMetadata,
    task_digest: sha256Hex(resolvedTask),
    ...metadataOverrides,
  };
  return {
    task: resolvedTask,
    taskName: "verify-contract",
    runtime: "subagent",
    mode: "run",
    agentId: "ai-engineer",
    gateway_lease_id: gatewayLeaseId,
    client_request_id: metadata.client_request_id,
    idempotency_key: metadata.idempotency_key,
    metadata,
  };
}

async function acquireLease(params: Record<string, unknown> = acquireParams, deviceId?: string) {
  return payload(await invoke("subagents.allowLease.acquire", params, deviceId))
    .gateway_lease_id as string;
}

describe("Agentic OS runtime contract claim 9 regressions", () => {
  beforeEach(async () => {
    runtimeStateDir = mkdtempSync(path.join(tmpdir(), "openclaw-agentic-os-runtime-claim9-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", runtimeStateDir);
    vi.resetModules();
    const contract = await import("./agentic-os-runtime-contract.js");
    ({ agenticOsRuntimeContractHandlers } = contract);
    spawnSubagentDirectMock.mockClear();
    spawnSubagentDirectMock.mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:ai-engineer:subagent:real-child",
      runId: "run-real-child",
      mode: "run",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (runtimeStateDir) {
      rmSync(runtimeStateDir, { recursive: true, force: true });
      runtimeStateDir = undefined;
    }
  });

  it("preserves accepted sessions_spawn results when the final snapshot write fails", async () => {
    const gatewayLeaseId = await acquireLease();
    const store = await import("../agentic-os-runtime-contract-store.js");
    const originalSave = store.saveAgenticOsRuntimeSnapshot;
    let saveCalls = 0;
    vi.spyOn(store, "saveAgenticOsRuntimeSnapshot").mockImplementation((snapshot) => {
      saveCalls += 1;
      if (saveCalls === 2) {
        throw new Error("synthetic final snapshot failure");
      }
      originalSave(snapshot);
    });

    const accepted = payload(await invoke("sessions_spawn", spawnParamsFor(gatewayLeaseId)));

    expect(accepted.status).toBe("accepted");
    expect(accepted.session_key).toBe("agent:ai-engineer:subagent:real-child");
    expect(spawnSubagentDirectMock.mock.calls[0]?.[1]).toMatchObject({
      agentSessionKey: "agent:main:main",
      requesterAgentIdOverride: "main",
    });
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(
      payload(await invoke("sessions_spawn", spawnParamsFor(gatewayLeaseId))).session_key,
    ).toBe(accepted.session_key);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);

    expect(saveCalls).toBe(3);
    vi.resetModules();
    const contract = await import("./agentic-os-runtime-contract.js");
    ({ agenticOsRuntimeContractHandlers } = contract);
    expect(
      payload(await invoke("sessions_spawn", spawnParamsFor(gatewayLeaseId))).session_key,
    ).toBe(accepted.session_key);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed sessions_spawn cleanup and context values before spawning", async () => {
    for (const [field, value, message] of [
      ["cleanup", "delete ", "invalid enum: cleanup"],
      ["cleanup", null, "invalid enum: cleanup"],
      ["context", "fork ", "invalid enum: context"],
      ["context", {}, "invalid enum: context"],
    ] as const) {
      const gatewayLeaseId = await acquireLease();
      expectInvalid(
        await invoke("sessions_spawn", {
          task: `malformed ${field}`,
          runtime: "subagent",
          [field]: value,
          agentId: "ai-engineer",
          gateway_lease_id: gatewayLeaseId,
          client_request_id: `spawn-${field}-${typeof value}`,
          idempotency_key: `spawn-${field}-idem-${typeof value}`,
          metadata: {
            ...sessionMetadata,
            client_request_id: `spawn-${field}-${typeof value}`,
            idempotency_key: `spawn-${field}-idem-${typeof value}`,
            task_digest: sha256Hex(`malformed ${field}`),
          },
        }),
        message,
      );
    }
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("scopes completed and hydrated sessions_spawn replay identities by principal", async () => {
    const firstLease = await acquireLease(acquireParams, "device-a");
    const secondAcquire = {
      ...acquireParams,
      client_lease_id: "lease-b",
      idempotency_key: "lease-idem-b",
      run_id: "run-b",
      transition_id: "transition-b",
    };
    const secondLease = await acquireLease(secondAcquire, "device-b");
    const sharedSpawnIds = {
      client_request_id: "spawn-shared",
      idempotency_key: "spawn-idem-shared",
    };
    const firstParams = spawnParamsFor(firstLease, {
      ...sharedSpawnIds,
      task: "principal scoped spawn",
    });
    const first = payload(await invoke("sessions_spawn", firstParams, "device-a"));
    spawnSubagentDirectMock.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:ai-engineer:subagent:device-b-child",
      runId: "run-device-b-child",
      mode: "run",
    });
    const secondParams = spawnParamsFor(secondLease, {
      ...sharedSpawnIds,
      run_id: "run-b",
      transition_id: "transition-b",
      task: "principal scoped spawn",
    });
    const second = payload(await invoke("sessions_spawn", secondParams, "device-b"));

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(2);
    vi.resetModules();
    const contract = await import("./agentic-os-runtime-contract.js");
    ({ agenticOsRuntimeContractHandlers } = contract);
    expect(payload(await invoke("sessions_spawn", firstParams, "device-a")).session_key).toBe(
      first.session_key,
    );
    expect(payload(await invoke("sessions_spawn", secondParams, "device-b")).session_key).toBe(
      second.session_key,
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(2);
  });

  it("expires consumed allow lease replay records after the replay window", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const gatewayLeaseId = await acquireLease();
    const accepted = payload(await invoke("sessions_spawn", spawnParamsFor(gatewayLeaseId)));
    expect(accepted.session_key).toBe("agent:ai-engineer:subagent:real-child");
    expect(payload(await invoke("subagents.allowLease.status")).leases).toEqual([]);

    vi.mocked(Date.now).mockReturnValue(now + 5 * 60 * 1000 + 1);
    const reacquired = await acquireLease();

    expect(reacquired).not.toBe(gatewayLeaseId);
    expect(payload(await invoke("subagents.allowLease.status")).leases).toEqual([
      expect.objectContaining({ gateway_lease_id: reacquired, status: "active" }),
    ]);
  });

  it("scopes pending sessions_spawn replay identifiers by principal", async () => {
    const firstLease = await acquireLease(acquireParams, "device-a");
    const secondLease = await acquireLease(
      {
        ...acquireParams,
        client_lease_id: "lease-pending-b",
        idempotency_key: "lease-pending-idem-b",
        run_id: "run-pending-b",
        transition_id: "transition-pending-b",
      },
      "device-b",
    );
    let releasePending!: () => void;
    const pendingGate = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    spawnSubagentDirectMock.mockImplementation(async (request) => {
      await pendingGate;
      return {
        status: "accepted",
        childSessionKey: `agent:ai-engineer:subagent:${request.taskName}`,
        runId: `run-${request.taskName}`,
        mode: "run",
      };
    });
    const sharedIds = {
      client_request_id: "spawn-pending-shared",
      idempotency_key: "spawn-pending-idem-shared",
      task: "principal scoped pending spawn",
    };
    const first = invoke(
      "sessions_spawn",
      { ...spawnParamsFor(firstLease, sharedIds), taskName: "device-a-pending" },
      "device-a",
    );
    await vi.waitFor(() => expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1));
    const second = invoke(
      "sessions_spawn",
      {
        ...spawnParamsFor(secondLease, {
          ...sharedIds,
          run_id: "run-pending-b",
          transition_id: "transition-pending-b",
        }),
        taskName: "device-b-pending",
      },
      "device-b",
    );
    await vi.waitFor(() => expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(2));

    releasePending();
    expect(payload(await first).session_key).toBe("agent:ai-engineer:subagent:device-a-pending");
    expect(payload(await second).session_key).toBe("agent:ai-engineer:subagent:device-b-pending");
  });
});
