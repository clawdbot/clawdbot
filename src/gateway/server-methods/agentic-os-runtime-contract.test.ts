import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
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
type RuntimeSnapshotDatabase = Pick<OpenClawStateKyselyDatabase, "agentic_os_runtime_snapshots">;

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

const releaseOwnerParams = {
  client_lease_id: acquireParams.client_lease_id,
  run_id: acquireParams.run_id,
  phase: acquireParams.phase,
  transition_id: acquireParams.transition_id,
  agent_id: acquireParams.agent_id,
  requester_agent_id: acquireParams.requester_agent_id,
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

async function invoke(
  method: string,
  params: Record<string, unknown> = {},
  deviceId?: string,
  scopes?: string[],
  pairedClientId?: string,
) {
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
    client:
      deviceId || scopes
        ? ({
            connect: {
              device: { id: deviceId },
              scopes: scopes ?? ["operator.admin", "operator.read", "operator.write"],
            },
            pairedClientId,
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

describe("Agentic OS runtime contract v1", () => {
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

  it("replays duplicate allow lease acquire and rejects conflicting reuse", async () => {
    const gatewayLeaseId = await acquireLease();
    const duplicate = payload(await invoke("subagents.allowLease.acquire", acquireParams));
    expect(duplicate.gateway_lease_id).toBe(gatewayLeaseId);

    expectInvalid(
      await invoke("subagents.allowLease.acquire", { ...acquireParams, ttl_ms: 30_000 }),
      "conflicting allow lease acquire idempotency_key",
    );
    expectInvalid(
      await invoke("subagents.allowLease.acquire", {
        ...acquireParams,
        idempotency_key: "lease-idem-b",
      }),
      "conflicting allow lease client_lease_id",
    );
  });

  it("scopes allow lease client_lease_id replay by authenticated principal", async () => {
    const first = payload(await invoke("subagents.allowLease.acquire", acquireParams, "device-a"));
    const secondParams = {
      ...acquireParams,
      idempotency_key: "lease-idem-device-b",
      run_id: "run-device-b",
      transition_id: "transition-device-b",
    };
    const second = payload(await invoke("subagents.allowLease.acquire", secondParams, "device-b"));

    expect(second.gateway_lease_id).not.toBe(first.gateway_lease_id);
    expect(
      payload(await invoke("subagents.allowLease.acquire", secondParams, "device-b"))
        .gateway_lease_id,
    ).toBe(second.gateway_lease_id);
    expect(
      payload(await invoke("subagents.allowLease.status", {}, "device-a")).leases,
    ).toHaveLength(1);
    expect(
      payload(await invoke("subagents.allowLease.status", {}, "device-b")).leases,
    ).toHaveLength(1);
  });

  it("keys Browser Copilot leases by signed device before shared paired client identity", async () => {
    const sharedBrowserCopilotClientId = "openclaw-browser-copilot";
    const first = payload(
      await invoke(
        "subagents.allowLease.acquire",
        acquireParams,
        "device-a",
        undefined,
        sharedBrowserCopilotClientId,
      ),
    );
    const secondParams = {
      ...acquireParams,
      idempotency_key: "lease-idem-device-b",
      run_id: "run-device-b",
      transition_id: "transition-device-b",
    };
    const second = payload(
      await invoke(
        "subagents.allowLease.acquire",
        secondParams,
        "device-b",
        undefined,
        sharedBrowserCopilotClientId,
      ),
    );

    expect(second.gateway_lease_id).not.toBe(first.gateway_lease_id);
    expect(
      payload(
        await invoke(
          "subagents.allowLease.status",
          {},
          "device-a",
          undefined,
          sharedBrowserCopilotClientId,
        ),
      ).leases,
    ).toHaveLength(1);
    expect(
      payload(
        await invoke(
          "subagents.allowLease.status",
          {},
          "device-b",
          undefined,
          sharedBrowserCopilotClientId,
        ),
      ).leases,
    ).toHaveLength(1);
  });

  it("requires operator.admin for connected allow lease acquire callers", async () => {
    expectInvalid(
      await invoke("subagents.allowLease.acquire", acquireParams, "device-write", [
        "operator.write",
        "operator.read",
      ]),
      "missing scope: operator.admin",
    );
    const response = payload(
      await invoke("subagents.allowLease.acquire", acquireParams, "device-admin", [
        "operator.admin",
      ]),
    );
    expect(response.status).toBe("active");
  });

  it("isolates lease and session projections by authenticated principal", async () => {
    const gatewayLeaseId = payload(
      await invoke("subagents.allowLease.acquire", acquireParams, "device-a"),
    ).gateway_lease_id as string;
    expect(payload(await invoke("subagents.allowLease.status", {}, "device-b")).leases).toEqual([]);
    expectInvalid(
      await invoke(
        "sessions_spawn",
        {
          task: "principal isolation",
          runtime: "subagent",
          agentId: "ai-engineer",
          gateway_lease_id: gatewayLeaseId,
          client_request_id: "spawn-a",
          idempotency_key: "spawn-idem-a",
          metadata: { ...sessionMetadata, task_digest: sha256Hex("principal isolation") },
        },
        "device-b",
      ),
      "different authenticated principal",
    );
  });

  it("prunes expired lease replay identities after bounded retention", async () => {
    await acquireLease({ ...acquireParams, ttl_ms: 1 });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60 * 1000);
    try {
      const reacquired = payload(
        await invoke("subagents.allowLease.acquire", { ...acquireParams, ttl_ms: 60_000 }),
      );
      expect(reacquired.status).toBe("active");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejects owner-mismatched release and replays exact release with a release idempotency key", async () => {
    const gatewayLeaseId = await acquireLease();
    expectInvalid(
      await invoke("subagents.allowLease.release", {
        ...releaseOwnerParams,
        release_idempotency_key: "lease-release-idem-a",
        requester_agent_id: "other",
        gateway_lease_id: gatewayLeaseId,
      }),
      "requester_agent_id does not match authenticated requester",
    );

    const releaseParams = {
      ...releaseOwnerParams,
      release_idempotency_key: "lease-release-idem-a",
      gateway_lease_id: gatewayLeaseId,
    };
    expectInvalid(
      await invoke("subagents.allowLease.release", {
        ...releaseOwnerParams,
        idempotency_key: "legacy-release-idem",
        gateway_lease_id: gatewayLeaseId,
      }),
      "conflicting alias is not accepted: idempotency_key",
    );
    const released = payload(await invoke("subagents.allowLease.release", releaseParams));
    expect(released.gateway_lease_id).toBe(gatewayLeaseId);
    expect(released.released).toBe(true);
    expect(released.metadata).toMatchObject({
      metadata_contract_version: "v1",
      normalized: {
        release_idempotency_key: "lease-release-idem-a",
        gateway_lease_id: gatewayLeaseId,
      },
    });
    expect(
      (released.metadata as { normalized?: Record<string, unknown> }).normalized,
    ).not.toHaveProperty("idempotency_key");
    const replayed = payload(await invoke("subagents.allowLease.release", releaseParams));
    expect(replayed).toEqual(released);
  });

  it("replays duplicate sessions_spawn and rejects conflicting reuse", async () => {
    const gatewayLeaseId = await acquireLease();
    const spawnParams = spawnParamsFor(gatewayLeaseId);
    const accepted = payload(await invoke("sessions_spawn", spawnParams));
    expect(accepted.status).toBe("accepted");
    expect(accepted.session_key).toBe("agent:ai-engineer:subagent:real-child");
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(spawnSubagentDirectMock).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({ agentSessionKey: "agent:main:main" }),
    );
    const replayed = payload(await invoke("sessions_spawn", spawnParams));
    expect(replayed.session_key).toBe(accepted.session_key);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);

    expectInvalid(
      await invoke("sessions_spawn", {
        ...spawnParams,
        task: "different task",
        metadata: {
          ...sessionMetadata,
          task_digest: sha256Hex("different task"),
        },
      }),
      "conflicting sessions_spawn idempotency_key",
    );
    expectInvalid(
      await invoke(
        "sessions_spawn",
        spawnParamsFor(gatewayLeaseId, {
          client_request_id: "spawn-b",
          idempotency_key: "spawn-idem-b",
          task: "second spawn must not reuse consumed lease",
        }),
      ),
      "gateway_lease_id is not active",
    );
  });

  it("reserves a one-shot allow lease against concurrent double spawn attempts", async () => {
    const gatewayLeaseId = await acquireLease();
    let acceptFirstSpawn: (() => void) | undefined;
    spawnSubagentDirectMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acceptFirstSpawn = () =>
            resolve({
              status: "accepted",
              childSessionKey: "agent:ai-engineer:subagent:concurrent-child",
              runId: "run-concurrent-child",
              mode: "run",
            });
        }),
    );

    const firstSpawn = invoke("sessions_spawn", spawnParamsFor(gatewayLeaseId));
    await Promise.resolve();
    const secondSpawn = await invoke(
      "sessions_spawn",
      spawnParamsFor(gatewayLeaseId, {
        client_request_id: "spawn-b",
        idempotency_key: "spawn-idem-b",
        task: "racing second spawn",
      }),
    );
    expectInvalid(secondSpawn, "gateway_lease_id is already reserved or consumed");

    acceptFirstSpawn?.();
    const accepted = payload(await firstSpawn);
    expect(accepted.session_key).toBe("agent:ai-engineer:subagent:concurrent-child");
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
  });

  it("rolls back a reserved allow lease when the child spawn is rejected", async () => {
    const gatewayLeaseId = await acquireLease();
    spawnSubagentDirectMock.mockResolvedValueOnce({
      status: "rejected",
      error: "synthetic spawn rejection",
    } as never);
    expectInvalid(await invoke("sessions_spawn", spawnParamsFor(gatewayLeaseId)), "synthetic");

    spawnSubagentDirectMock.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:ai-engineer:subagent:retry-child",
      runId: "run-retry-child",
      mode: "run",
    });
    const accepted = payload(
      await invoke(
        "sessions_spawn",
        spawnParamsFor(gatewayLeaseId, {
          client_request_id: "spawn-retry",
          idempotency_key: "spawn-retry-idem",
          task: "retry after rejected spawn",
        }),
      ),
    );
    expect(accepted.session_key).toBe("agent:ai-engineer:subagent:retry-child");
  });

  it("rolls back allow lease reservation when snapshot persistence fails", async () => {
    const gatewayLeaseId = await acquireLease();
    const store = await import("../agentic-os-runtime-contract-store.js");
    vi.spyOn(store, "saveAgenticOsRuntimeSnapshot").mockImplementationOnce(() => {
      throw new Error("synthetic snapshot failure");
    });

    expectInvalid(
      await invoke("sessions_spawn", spawnParamsFor(gatewayLeaseId)),
      "Agentic OS runtime contract failure",
    );

    const accepted = payload(
      await invoke(
        "sessions_spawn",
        spawnParamsFor(gatewayLeaseId, {
          client_request_id: "spawn-retry",
          idempotency_key: "spawn-retry-idem",
          task: "retry after failed snapshot write",
        }),
      ),
    );
    expect(accepted.session_key).toBe("agent:ai-engineer:subagent:real-child");
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
  });

  it("persists lease, session, and idempotency authority in the canonical state database", async () => {
    const gatewayLeaseId = await acquireLease();
    const spawnParams = {
      task: "persist across restart",
      taskName: "restart-safe",
      runtime: "subagent",
      mode: "run",
      agentId: "ai-engineer",
      gateway_lease_id: gatewayLeaseId,
      client_request_id: "spawn-a",
      idempotency_key: "spawn-idem-a",
      metadata: { ...sessionMetadata, task_digest: sha256Hex("persist across restart") },
    };
    const accepted = payload(await invoke("sessions_spawn", spawnParams));
    expect(accepted.session_key).toBe("agent:ai-engineer:subagent:real-child");
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);

    const database = openOpenClawStateDatabase();
    const row = executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<RuntimeSnapshotDatabase>(database.db)
        .selectFrom("agentic_os_runtime_snapshots")
        .select("payload_json")
        .where("key", "=", "agentic-os-runtime-contract-v1"),
    ).rows[0];
    expect(row?.payload_json).toEqual(expect.stringContaining(gatewayLeaseId));
    expect(row?.payload_json).toEqual(expect.stringContaining("spawn-idem-a"));
    const status = payload(
      await invoke("sessions_status", { session_key: accepted.session_key as string }),
    );
    expect(status.session_key).toBe(accepted.session_key);

    const releaseParams = {
      ...releaseOwnerParams,
      release_idempotency_key: "lease-release-idem-a",
      gateway_lease_id: gatewayLeaseId,
    };
    const released = payload(await invoke("subagents.allowLease.release", releaseParams));
    expect(payload(await invoke("subagents.allowLease.release", releaseParams))).toEqual(released);
  });

  it("rejects release replay capacity failures before mutating the lease", async () => {
    vi.resetModules();
    const now = Date.now();
    const gatewayLeaseId = "gateway-lease:capacity";
    const owner = {
      client_lease_id: "lease-capacity",
      idempotency_key: "lease-capacity-idem",
      run_id: "run-capacity",
      phase: "phase-b",
      transition_id: "transition-capacity",
      agent_id: "ai-engineer",
      requester_agent_id: "main",
    };
    const spawnOwner = {
      client_lease_id: owner.client_lease_id,
      run_id: owner.run_id,
      phase: owner.phase,
      transition_id: owner.transition_id,
      agent_id: owner.agent_id,
      requester_agent_id: owner.requester_agent_id,
    };
    const store = await import("../agentic-os-runtime-contract-store.js");
    store.saveAgenticOsRuntimeSnapshot({
      leases: [
        {
          gatewayLeaseId,
          fingerprint: "capacity-acquire-fingerprint",
          acquireIdempotencyKey: owner.idempotency_key,
          clientLeaseId: owner.client_lease_id,
          owner,
          spawnOwner,
          authenticatedPrincipalId: "device-capacity",
          acquireMetadata: {
            metadata_contract_version: "v1",
            normalized: { ...owner, ttl_ms: 60_000, gateway_lease_id: gatewayLeaseId },
            raw_json: "{}",
          },
          created_at_ms: now,
          expires_at_ms: now + 60_000,
        },
      ],
      releaseReplays: Array.from({ length: 1_024 }, (_, index) => ({
        releaseIdempotencyKey: `filled-release-${index}`,
        fingerprint: `filled-fingerprint-${index}`,
        response: { status: "released", gateway_lease_id: `gateway-lease:filled-${index}` },
        createdAtMs: now,
        authenticatedPrincipalId: "device-capacity",
      })),
      sessions: [],
    });
    const contract = await import("./agentic-os-runtime-contract.js");
    ({ agenticOsRuntimeContractHandlers } = contract);

    expectInvalid(
      await invoke(
        "subagents.allowLease.release",
        {
          ...spawnOwner,
          release_idempotency_key: "release-capacity-new",
          gateway_lease_id: gatewayLeaseId,
        },
        "device-capacity",
      ),
      "allow lease release replay capacity reached",
    );
    const status = payload(await invoke("subagents.allowLease.status", {}, "device-capacity"));
    expect(status.leases).toEqual([
      expect.objectContaining({
        status: "active",
        gateway_lease_id: gatewayLeaseId,
      }),
    ]);
  });

  it("includes launch controls in sessions_spawn replay fingerprints", async () => {
    const gatewayLeaseId = await acquireLease();
    const spawnParams = {
      task: "fingerprint all launch controls",
      taskName: "fingerprint-controls",
      runtime: "subagent",
      mode: "run",
      cleanup: "keep",
      context: "fork",
      lightContext: true,
      agentId: "ai-engineer",
      gateway_lease_id: gatewayLeaseId,
      client_request_id: "spawn-a",
      idempotency_key: "spawn-idem-a",
      metadata: { ...sessionMetadata, task_digest: sha256Hex("fingerprint all launch controls") },
    };
    payload(await invoke("sessions_spawn", spawnParams));
    for (const changed of [
      { cleanup: "delete" },
      { context: "isolated" },
      { lightContext: false },
    ]) {
      expectInvalid(
        await invoke("sessions_spawn", { ...spawnParams, ...changed }),
        "conflicting sessions_spawn idempotency_key",
      );
    }
  });

  it("rejects malformed sessions_spawn lightContext values before spawning", async () => {
    for (const lightContext of ["true", 1, null, {}, []]) {
      const gatewayLeaseId = await acquireLease();
      expectInvalid(
        await invoke("sessions_spawn", {
          task: "malformed light context",
          runtime: "subagent",
          lightContext,
          agentId: "ai-engineer",
          gateway_lease_id: gatewayLeaseId,
          client_request_id: `spawn-light-${typeof lightContext}-${Array.isArray(lightContext)}`,
          idempotency_key: `spawn-light-idem-${typeof lightContext}-${Array.isArray(lightContext)}`,
          metadata: {
            ...sessionMetadata,
            client_request_id: `spawn-light-${typeof lightContext}-${Array.isArray(lightContext)}`,
            idempotency_key: `spawn-light-idem-${typeof lightContext}-${Array.isArray(
              lightContext,
            )}`,
            task_digest: sha256Hex("malformed light context"),
          },
        }),
        "invalid boolean: lightContext",
      );
    }
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("rejects malformed sessions_spawn mode values before spawning", async () => {
    for (const mode of ["session", "bogus", null, 1, {}]) {
      const gatewayLeaseId = await acquireLease();
      expectInvalid(
        await invoke("sessions_spawn", {
          task: "unsupported session mode",
          runtime: "subagent",
          mode,
          agentId: "ai-engineer",
          gateway_lease_id: gatewayLeaseId,
          client_request_id: `spawn-mode-${typeof mode}`,
          idempotency_key: `spawn-mode-idem-${typeof mode}`,
          metadata: {
            ...sessionMetadata,
            client_request_id: `spawn-mode-${typeof mode}`,
            idempotency_key: `spawn-mode-idem-${typeof mode}`,
            task_digest: sha256Hex("unsupported session mode"),
          },
        }),
        "invalid enum: mode",
      );
    }
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported sessions_spawn runtime before the runner", async () => {
    const gatewayLeaseId = await acquireLease();
    expectInvalid(
      await invoke("sessions_spawn", {
        task: "unsupported runtime",
        runtime: "other-runtime",
        agentId: "ai-engineer",
        gateway_lease_id: gatewayLeaseId,
        client_request_id: "spawn-a",
        idempotency_key: "spawn-idem-a",
        metadata: { ...sessionMetadata, task_digest: sha256Hex("unsupported runtime") },
      }),
      "unsupported sessions_spawn runtime",
    );
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("rejects unleased legacy sessions_spawn callers before the runner", async () => {
    expectInvalid(
      await invoke("sessions_spawn", {
        task: "legacy spawn",
        runtime: "subagent",
        agentId: "ai-engineer",
        mode: "run",
      }),
      "missing required string: client_request_id",
    );
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent duplicate sessions_spawn calls onto one child runner", async () => {
    const gatewayLeaseId = await acquireLease();
    let resolveSpawn!: (value: Awaited<ReturnType<typeof spawnSubagentDirect>>) => void;
    spawnSubagentDirectMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve;
      }),
    );
    const spawnParams = {
      task: "concurrent duplicate",
      runtime: "subagent",
      agentId: "ai-engineer",
      gateway_lease_id: gatewayLeaseId,
      client_request_id: "spawn-a",
      idempotency_key: "spawn-idem-a",
      metadata: { ...sessionMetadata, task_digest: sha256Hex("concurrent duplicate") },
    };
    const first = invoke("sessions_spawn", spawnParams);
    const second = invoke("sessions_spawn", spawnParams);
    await vi.waitFor(() => expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1));
    resolveSpawn({
      status: "accepted",
      childSessionKey: "agent:ai-engineer:subagent:real-child",
      runId: "run-real-child",
    });
    expect(payload(await first).session_key).toBe(payload(await second).session_key);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
  });

  it("replays a same-principal pending sessions_spawn before lease liveness rejection", async () => {
    const gatewayLeaseId = await acquireLease();
    let resolveSpawn!: (value: Awaited<ReturnType<typeof spawnSubagentDirect>>) => void;
    spawnSubagentDirectMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve;
      }),
    );
    const spawnParams = {
      task: "pending duplicate survives released lease",
      runtime: "subagent",
      agentId: "ai-engineer",
      gateway_lease_id: gatewayLeaseId,
      client_request_id: "spawn-a",
      idempotency_key: "spawn-idem-a",
      metadata: {
        ...sessionMetadata,
        task_digest: sha256Hex("pending duplicate survives released lease"),
      },
    };
    const first = invoke("sessions_spawn", spawnParams);
    await vi.waitFor(() => expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1));
    payload(
      await invoke("subagents.allowLease.release", {
        ...releaseOwnerParams,
        release_idempotency_key: "lease-release-idem-a",
        gateway_lease_id: gatewayLeaseId,
      }),
    );
    const second = invoke("sessions_spawn", spawnParams);
    resolveSpawn({
      status: "accepted",
      childSessionKey: "agent:ai-engineer:subagent:real-child",
      runId: "run-real-child",
    });
    expect(payload(await first).session_key).toBe(payload(await second).session_key);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
  });

  it("rejects released, expired, and wrong-owner leases before spawning", async () => {
    const gatewayLeaseId = await acquireLease();
    await invoke("subagents.allowLease.release", {
      ...releaseOwnerParams,
      release_idempotency_key: "lease-release-idem-a",
      gateway_lease_id: gatewayLeaseId,
    });
    const spawnParams = {
      task: "verify metadata contract",
      runtime: "subagent",
      agentId: "ai-engineer",
      gateway_lease_id: gatewayLeaseId,
      client_request_id: "spawn-a",
      idempotency_key: "spawn-idem-a",
      metadata: sessionMetadata,
    };
    expectInvalid(await invoke("sessions_spawn", spawnParams), "gateway_lease_id is not active");

    const shortLeaseId = await acquireLease({
      ...acquireParams,
      client_lease_id: "lease-expiring",
      idempotency_key: "lease-expiring-idem",
      ttl_ms: 1,
    });
    const future = Date.now() + 10_000;
    vi.spyOn(Date, "now").mockReturnValue(future);
    try {
      expectInvalid(
        await invoke("sessions_spawn", { ...spawnParams, gateway_lease_id: shortLeaseId }),
        "gateway_lease_id is not active",
      );
    } finally {
      vi.restoreAllMocks();
    }

    const otherOwnerLeaseId = await acquireLease({
      ...acquireParams,
      client_lease_id: "lease-other-owner",
      idempotency_key: "lease-other-owner-idem",
      agent_id: "other-agent",
    });
    expectInvalid(
      await invoke("sessions_spawn", { ...spawnParams, gateway_lease_id: otherOwnerLeaseId }),
      "gateway_lease_id owner does not authorize spawn: agent_id",
    );
  });

  it("projects accepted session identity and metadata through list, status, and history", async () => {
    const gatewayLeaseId = await acquireLease();
    const accepted = payload(
      await invoke("sessions_spawn", {
        task: "verify metadata contract",
        runtime: "subagent",
        agentId: "ai-engineer",
        gateway_lease_id: gatewayLeaseId,
        client_request_id: "spawn-a",
        idempotency_key: "spawn-idem-a",
        metadata: sessionMetadata,
      }),
    );
    const sessionKey = accepted.session_key as string;

    const listed = payload(await invoke("sessions_list"));
    expect(listed.sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ session_key: sessionKey })]),
    );

    const status = payload(await invoke("sessions_status", { session_key: sessionKey }));
    const history = payload(
      await invoke("sessions_history", { sessionKey, limit: 5, includeTools: true }),
    );
    for (const projection of [accepted, status, history]) {
      expect(projection.external_id).toBe(sessionKey);
      expect(projection.spawn_request_session_key).toBe(sessionKey);
      expect(projection.metadata).toMatchObject({
        metadata_contract_version: "v1",
        normalized: sessionMetadata,
      });
      expect(projection.session).toMatchObject({
        session_key: sessionKey,
        metadata: expect.objectContaining({ normalized: sessionMetadata }),
      });
    }
    if (status.runtime_session !== null) {
      expect(status.runtime_session).toMatchObject({
        key: sessionKey,
        observed: expect.any(Boolean),
        message_count: expect.any(Number),
        lifecycle_status: "running",
        runtime_status: "running",
        terminal: false,
      });
    }
    expect(history.messages).toEqual([]);
    expect(history).not.toHaveProperty("task");
  });

  it("honors includeTools=false on sessions_history while preserving explicit tool history", async () => {
    const { chatHistoryHandlers } = await import("./chat-history-handler.js");
    const original = chatHistoryHandlers["chat.history"];
    if (!original) {
      throw new Error("missing chat.history handler");
    }
    chatHistoryHandlers["chat.history"] = async ({ respond }) => {
      respond(true, {
        messages: [
          { role: "user", content: "hello" },
          { role: "tool", content: "private tool input" },
          { role: "toolResult", content: "private tool result" },
          { role: "assistant", content: "done" },
        ],
      });
    };
    try {
      const gatewayLeaseId = await acquireLease();
      const accepted = payload(
        await invoke("sessions_spawn", {
          task: "verify history filtering",
          runtime: "subagent",
          agentId: "ai-engineer",
          gateway_lease_id: gatewayLeaseId,
          client_request_id: "spawn-a",
          idempotency_key: "spawn-idem-a",
          metadata: { ...sessionMetadata, task_digest: sha256Hex("verify history filtering") },
        }),
      );
      const sessionKey = accepted.session_key as string;
      const defaultHistory = payload(await invoke("sessions_history", { sessionKey, limit: 5 }));
      expect(defaultHistory.messages).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "done" },
      ]);
      const explicitFiltered = payload(
        await invoke("sessions_history", { sessionKey, limit: 5, includeTools: false }),
      );
      expect(explicitFiltered.messages).toEqual(defaultHistory.messages);
      const withTools = payload(
        await invoke("sessions_history", { sessionKey, limit: 5, includeTools: true }),
      );
      expect(withTools.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "tool" }),
          expect.objectContaining({ role: "toolResult" }),
        ]),
      );
    } finally {
      chatHistoryHandlers["chat.history"] = original;
    }
  });

  it("projects canonical failed child lifecycle without exposing raw failure text", async () => {
    const gatewayLeaseId = await acquireLease();
    const accepted = payload(
      await invoke("sessions_spawn", {
        task: "verify failure lifecycle",
        runtime: "subagent",
        agentId: "ai-engineer",
        gateway_lease_id: gatewayLeaseId,
        client_request_id: "spawn-failure",
        idempotency_key: "spawn-failure-idem",
        metadata: {
          ...sessionMetadata,
          client_request_id: "spawn-failure",
          idempotency_key: "spawn-failure-idem",
          task_digest: sha256Hex("verify failure lifecycle"),
        },
      }),
    );
    waitForAgentJobMock.mockResolvedValue({
      status: "error",
      startedAt: 10,
      endedAt: 20,
      error: "private provider failure",
    });
    const status = payload(
      await invoke("sessions_status", { session_key: accepted.session_key as string }),
    );
    expect(status.runtime_session).toMatchObject({
      lifecycle_status: "failed",
      runtime_status: "error",
      terminal: true,
      started_at_ms: 10,
      ended_at_ms: 20,
    });
    expect(JSON.stringify(status.runtime_session)).not.toContain("private provider failure");
  });

  it("prunes aged session projections after bounded retention", async () => {
    const gatewayLeaseId = await acquireLease();
    const accepted = payload(
      await invoke("sessions_spawn", {
        task: "verify bounded session retention",
        runtime: "subagent",
        agentId: "ai-engineer",
        gateway_lease_id: gatewayLeaseId,
        client_request_id: "spawn-retention",
        idempotency_key: "spawn-retention-idem",
        metadata: {
          ...sessionMetadata,
          client_request_id: "spawn-retention",
          idempotency_key: "spawn-retention-idem",
          task_digest: sha256Hex("verify bounded session retention"),
        },
      }),
    );
    const sessionKey = accepted.session_key as string;
    const initial = payload(await invoke("sessions_list"));
    expect(initial.sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ session_key: sessionKey })]),
    );
    findTaskByRunIdForStatusMock.mockReturnValue({ status: "succeeded", startedAt: 5, endedAt: 6 });

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    try {
      expect(payload(await invoke("sessions_list")).sessions).toEqual([]);
      expectInvalid(
        await invoke("sessions_status", { session_key: sessionKey }),
        "unknown session_key",
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
