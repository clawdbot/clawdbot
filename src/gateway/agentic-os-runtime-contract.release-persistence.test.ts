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
    if (runtimeStateDir) {
      rmSync(runtimeStateDir, { recursive: true, force: true });
      runtimeStateDir = undefined;
    }
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
});
