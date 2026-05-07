import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAcpxProcessLeaseStore, type AcpxProcessLease } from "./process-lease.js";

function makeLease(index: number): AcpxProcessLease {
  return {
    leaseId: `lease-${index}`,
    gatewayInstanceId: "gateway-test",
    sessionKey: `agent:codex:acp:${index}`,
    wrapperRoot: "/tmp/openclaw/acpx",
    wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
    rootPid: 1000 + index,
    commandHash: `hash-${index}`,
    startedAt: index,
    state: "open",
  };
}

describe("createAcpxProcessLeaseStore", () => {
  it("serializes concurrent lease saves without dropping records", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-acpx-leases-"));
    try {
      const store = createAcpxProcessLeaseStore({ stateDir });
      await Promise.all(Array.from({ length: 25 }, (_, index) => store.save(makeLease(index))));

      const leases = await store.listOpen("gateway-test");
      expect(leases.map((lease) => lease.leaseId).toSorted()).toEqual(
        Array.from({ length: 25 }, (_, index) => `lease-${index}`).toSorted(),
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
