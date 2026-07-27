import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("Agentic OS allow lease release persistence", () => {
  let runtimeStateDir: string | undefined;

  beforeEach(() => {
    runtimeStateDir = mkdtempSync(path.join(tmpdir(), "openclaw-agentic-os-release-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", runtimeStateDir);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (runtimeStateDir) {
      rmSync(runtimeStateDir, { recursive: true, force: true });
      runtimeStateDir = undefined;
    }
  });

  it("rolls back failed acquisition persistence so retry is durable across restart", async () => {
    const contract = await import("./agentic-os-runtime-contract.js");
    const store = await import("./agentic-os-runtime-contract-store.js");
    vi.spyOn(store, "saveAgenticOsRuntimeSnapshot").mockImplementationOnce(() => {
      throw new Error("synthetic acquire snapshot failure");
    });

    expect(() => contract.acquireAgenticOsAllowLease(acquireParams)).toThrow(
      "synthetic acquire snapshot failure",
    );
    expect(contract.listAgenticOsAllowLeases().leases).toEqual([]);

    const acquired = contract.acquireAgenticOsAllowLease(acquireParams);
    expect(acquired).toEqual(expect.objectContaining({ status: "active" }));

    vi.resetModules();
    const restarted = await import("./agentic-os-runtime-contract.js");
    expect(restarted.listAgenticOsAllowLeases().leases).toEqual([
      expect.objectContaining({
        status: "active",
        gateway_lease_id: acquired.gateway_lease_id,
      }),
    ]);
  });

  it("rolls back failed persistence so retry is durable across restart", async () => {
    const contract = await import("./agentic-os-runtime-contract.js");
    const acquired = contract.acquireAgenticOsAllowLease(acquireParams);
    const gatewayLeaseId = acquired.gateway_lease_id as string;
    const releaseParams = {
      ...releaseOwnerParams,
      release_idempotency_key: "lease-release-idem-a",
      gateway_lease_id: gatewayLeaseId,
    };
    const store = await import("./agentic-os-runtime-contract-store.js");
    vi.spyOn(store, "saveAgenticOsRuntimeSnapshot").mockImplementationOnce(() => {
      throw new Error("synthetic release snapshot failure");
    });

    expect(() => contract.releaseAgenticOsAllowLease(releaseParams)).toThrow(
      "synthetic release snapshot failure",
    );
    expect(contract.listAgenticOsAllowLeases().leases).toEqual([
      expect.objectContaining({ status: "active", gateway_lease_id: gatewayLeaseId }),
    ]);

    const released = contract.releaseAgenticOsAllowLease(releaseParams);
    expect(contract.releaseAgenticOsAllowLease(releaseParams)).toEqual(released);

    vi.resetModules();
    const restarted = await import("./agentic-os-runtime-contract.js");
    expect(restarted.listAgenticOsAllowLeases().leases).toEqual([]);
    expect(restarted.releaseAgenticOsAllowLease(releaseParams)).toEqual(released);
  });

  it("reconciles an orphaned durable spawn reservation into exact session replay", async () => {
    const contract = await import("./agentic-os-runtime-contract.js");
    const shared = await import("./agentic-os-runtime-contract-shared.js");
    const acquired = contract.acquireAgenticOsAllowLease(acquireParams);
    const gatewayLeaseId = acquired.gateway_lease_id as string;
    const store = await import("./agentic-os-runtime-contract-store.js");
    const snapshot = store.loadAgenticOsRuntimeSnapshot() as {
      leases: Array<Record<string, unknown>>;
      releaseReplays: unknown[];
      sessions: unknown[];
    };
    const reservedAt = Date.now();
    const task = "restart must not duplicate an uncertain child";
    const metadata = {
      run_id: acquireParams.run_id,
      transition_id: acquireParams.transition_id,
      client_request_id: "spawn-restart",
      idempotency_key: "spawn-restart-idem",
      phase: acquireParams.phase,
      agent_id: acquireParams.agent_id,
      task_digest: createHash("sha256").update(task).digest("hex"),
    };
    const spawnParams = {
      task,
      runtime: "subagent",
      agentId: "ai-engineer",
      gateway_lease_id: gatewayLeaseId,
      client_request_id: "spawn-restart",
      idempotency_key: "spawn-restart-idem",
      metadata,
    };
    const fingerprint = shared.stableJson({
      client_request_id: spawnParams.client_request_id,
      idempotency_key: spawnParams.idempotency_key,
      gateway_lease_id: spawnParams.gateway_lease_id,
      task,
      taskName: undefined,
      runtime: "subagent",
      mode: "run",
      cleanup: undefined,
      context: undefined,
      lightContext: false,
      agentId: "ai-engineer",
      metadata,
    });
    const reservedSession = {
      sessionKey: "agent:ai-engineer:subagent:reserved-after-restart",
      fingerprint,
      clientRequestId: spawnParams.client_request_id,
      idempotencyKey: spawnParams.idempotency_key,
      gatewayLeaseId,
      metadata: {
        metadata_contract_version: "v1",
        normalized: metadata,
        raw_json: shared.stableJson(metadata),
      },
      agentId: "ai-engineer",
      authenticatedPrincipalId: "internal",
      runId: "reserved-run-after-restart",
      created_at_ms: reservedAt,
    };
    Object.assign(snapshot.leases[0]!, {
      spawn_reserved_at_ms: reservedAt,
      spawn_reservation_fingerprint: fingerprint,
      spawn_reservation: reservedSession,
    });
    store.saveAgenticOsRuntimeSnapshot(snapshot);

    vi.resetModules();
    const restarted = await import("./agentic-os-runtime-contract.js");
    expect(restarted.listAgenticOsAllowLeases().leases).toEqual([]);
    expect(restarted.acquireAgenticOsAllowLease(acquireParams)).toMatchObject({
      status: "consumed",
      gateway_lease_id: gatewayLeaseId,
    });
    await expect(restarted.spawnAgenticOsSession(spawnParams)).resolves.toMatchObject({
      status: "accepted",
      childSessionKey: reservedSession.sessionKey,
      runId: reservedSession.runId,
    });
  });
});
