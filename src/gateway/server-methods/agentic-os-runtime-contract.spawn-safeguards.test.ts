import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import type { waitForAgentJob } from "./agent-job.js";
import type { GatewayRequestHandlers } from "./types.js";

const spawnSubagentDirectMock = vi.hoisted(() =>
  vi.fn<typeof spawnSubagentDirect>(async () => ({
    status: "accepted",
    childSessionKey: "agent:ai-engineer:subagent:real-child",
    runId: "run-real-child",
    mode: "run",
  })),
);
const waitForAgentJobMock = vi.hoisted(() => vi.fn<typeof waitForAgentJob>(async () => null));
const findTaskByRunIdForStatusMock = vi.hoisted(() =>
  vi.fn((): { status: string; startedAt?: number; endedAt?: number } | undefined => ({
    status: "running",
    startedAt: 5,
  })),
);

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: spawnSubagentDirectMock,
}));
vi.mock("./agent-job.js", () => ({ waitForAgentJob: waitForAgentJobMock }));
vi.mock("../../tasks/task-status-access.js", () => ({
  findTaskByRunIdForStatus: findTaskByRunIdForStatusMock,
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

async function invoke(method: string, params: Record<string, unknown> = {}) {
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
    client: null,
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

async function acquireLease(params: Record<string, unknown> = acquireParams) {
  const response = payload(await invoke("subagents.allowLease.acquire", params));
  expect(response.gateway_lease_id).toEqual(expect.stringContaining("gateway-lease:"));
  return response.gateway_lease_id as string;
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

describe("Agentic OS runtime contract spawn safeguards", () => {
  beforeEach(async () => {
    runtimeStateDir = mkdtempSync(path.join(tmpdir(), "openclaw-agentic-os-runtime-contract-"));
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
    waitForAgentJobMock.mockReset();
    waitForAgentJobMock.mockResolvedValue(null);
    findTaskByRunIdForStatusMock.mockReset();
    findTaskByRunIdForStatusMock.mockReturnValue({ status: "running", startedAt: 5 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (runtimeStateDir) {
      rmSync(runtimeStateDir, { recursive: true, force: true });
      runtimeStateDir = undefined;
    }
  });

  it("rejects mismatched task_digest before reserving the lease or spawning", async () => {
    const gatewayLeaseId = await acquireLease();
    expectInvalid(
      await invoke(
        "sessions_spawn",
        spawnParamsFor(gatewayLeaseId, {
          task_digest: sha256Hex("different task"),
        }),
      ),
      "session metadata task_digest does not match spawn task",
    );
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();

    const accepted = payload(await invoke("sessions_spawn", spawnParamsFor(gatewayLeaseId)));
    expect(accepted.session_key).toBe("agent:ai-engineer:subagent:real-child");
  });

  it("caps distinct slow pending spawns atomically and fails the overflow request closed", async () => {
    vi.resetModules();
    const now = Date.now();
    const leases = Array.from({ length: 1_025 }, (_, index) => {
      const owner = {
        ...acquireParams,
        client_lease_id: `lease-pending-${index}`,
        idempotency_key: `lease-pending-idem-${index}`,
      };
      const spawnOwner = {
        client_lease_id: owner.client_lease_id,
        run_id: owner.run_id,
        phase: owner.phase,
        transition_id: owner.transition_id,
        agent_id: owner.agent_id,
        requester_agent_id: owner.requester_agent_id,
      };
      const gatewayLeaseId = `gateway-lease:pending-${index}`;
      return {
        gatewayLeaseId,
        fingerprint: `pending-acquire-fingerprint-${index}`,
        acquireIdempotencyKey: owner.idempotency_key,
        clientLeaseId: owner.client_lease_id,
        owner,
        spawnOwner,
        authenticatedPrincipalId: "internal",
        acquireMetadata: {
          metadata_contract_version: "v1",
          normalized: { ...owner, ttl_ms: 60_000, gateway_lease_id: gatewayLeaseId },
          raw_json: "{}",
        },
        created_at_ms: now,
        expires_at_ms: now + 60_000,
      };
    });
    const store = await import("../agentic-os-runtime-contract-store.js");
    store.saveAgenticOsRuntimeSnapshot({ leases, releaseReplays: [], sessions: [] });
    const contract = await import("./agentic-os-runtime-contract.js");
    ({ agenticOsRuntimeContractHandlers } = contract);
    let releasePending!: () => void;
    const pendingGate = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    spawnSubagentDirectMock.mockImplementation(async (request) => {
      await pendingGate;
      const suffix = request?.task?.replace(/\D/g, "") || "unknown";
      return {
        status: "accepted",
        childSessionKey: `agent:ai-engineer:subagent:bounded-${suffix}`,
        runId: `run-bounded-${suffix}`,
        mode: "run",
      };
    });
    const makeSpawnParams = (index: number) => ({
      task: `bounded pending ${index}`,
      runtime: "subagent",
      agentId: "ai-engineer",
      gateway_lease_id: `gateway-lease:pending-${index}`,
      client_request_id: `spawn-pending-${index}`,
      idempotency_key: `spawn-pending-idem-${index}`,
      metadata: {
        ...sessionMetadata,
        client_request_id: `spawn-pending-${index}`,
        idempotency_key: `spawn-pending-idem-${index}`,
        task_digest: sha256Hex(`bounded pending ${index}`),
      },
    });

    const pending = Array.from({ length: 1_024 }, (_, index) =>
      invoke("sessions_spawn", makeSpawnParams(index)),
    );
    await vi.waitFor(() => expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1_024), {
      timeout: 60_000,
    });
    expectInvalid(
      await invoke("sessions_spawn", makeSpawnParams(1_024)),
      "pending session spawn capacity reached",
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1_024);

    releasePending();
    const completed = await Promise.all(pending);
    expect(completed.every(([ok]) => ok)).toBe(true);
  }, 240_000);

  it("retains aged session projections while the child run is active", async () => {
    const gatewayLeaseId = await acquireLease();
    const accepted = payload(
      await invoke("sessions_spawn", {
        task: "verify active child retention",
        runtime: "subagent",
        agentId: "ai-engineer",
        gateway_lease_id: gatewayLeaseId,
        client_request_id: "spawn-active-retention",
        idempotency_key: "spawn-active-retention-idem",
        metadata: {
          ...sessionMetadata,
          client_request_id: "spawn-active-retention",
          idempotency_key: "spawn-active-retention-idem",
          task_digest: sha256Hex("verify active child retention"),
        },
      }),
    );
    const sessionKey = accepted.session_key as string;

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    try {
      expect(payload(await invoke("sessions_list")).sessions).toEqual(
        expect.arrayContaining([expect.objectContaining({ session_key: sessionKey })]),
      );
      expect(payload(await invoke("sessions_status", { session_key: sessionKey }))).toMatchObject({
        session_key: sessionKey,
      });
    } finally {
      vi.restoreAllMocks();
    }
  });
});
