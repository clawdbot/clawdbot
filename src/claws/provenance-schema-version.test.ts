import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { persistClawInstallRecord, readClawInstallRecord } from "./provenance.js";
import { makeProvenancePlan, stateEnv } from "./provenance.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function makePlan() {
  const root = tempDirs.make("openclaw-claw-provenance-schema-");
  return await makeProvenancePlan(root, { schemaVersion: 1, agent: { id: "worker" } });
}

function downgradeInstallRecord(root: string): void {
  const env = stateEnv(root);
  openOpenClawStateDatabase({ env })
    .db /* sqlite-allow-raw: test-only downgrade simulates pre-v2 provenance. */
    .prepare("UPDATE claw_installs SET schema_version = ? WHERE agent_id = ?")
    .run("openclaw.clawInstallRecord.v1", "worker");
}

describe("Claw install provenance schema migration", () => {
  it("upgrades matching incomplete v1 provenance from an exact resume handoff", async () => {
    const { root, plan } = await makePlan();
    const env = stateEnv(root);
    persistClawInstallRecord(plan, { env, status: "pending", nowMs: 1 });
    downgradeInstallRecord(root);
    const legacyRecord = readClawInstallRecord("worker", { env });
    if (!legacyRecord) {
      throw new Error("expected legacy install record");
    }

    const resumed = persistClawInstallRecord(plan, {
      env,
      status: "pending",
      nowMs: 2,
      expectedExistingRecord: legacyRecord,
    });

    expect(resumed).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v2",
      status: "pending",
      addedAtMs: 1,
      updatedAtMs: 1,
    });
  });

  it("atomically replaces legacy plan identity with the bounded resume plan", async () => {
    const { root, plan: legacyPlan } = await makePlan();
    const env = stateEnv(root);
    persistClawInstallRecord(legacyPlan, { env, status: "pending", nowMs: 1 });
    downgradeInstallRecord(root);
    const legacyRecord = readClawInstallRecord("worker", { env });
    if (!legacyRecord) {
      throw new Error("expected legacy install record");
    }
    const boundedPlan = {
      ...legacyPlan,
      planIntegrity: "sha256:bounded-plan",
      agent: {
        ...legacyPlan.agent,
        config: {
          ...legacyPlan.agent.config,
          tools: { profile: "full" as const, allow: ["read"] },
        },
      },
    };

    const resumed = persistClawInstallRecord(boundedPlan, {
      env,
      status: "pending",
      nowMs: 2,
      expectedExistingRecord: legacyRecord,
      expectedExistingPlan: legacyPlan,
    });

    expect(resumed).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v2",
      planIntegrity: boundedPlan.planIntegrity,
      status: "pending",
      addedAtMs: 1,
      updatedAtMs: 1,
    });
    expect(resumed.agentConfigDigest).not.toBe(legacyRecord.agentConfigDigest);
    expect(readClawInstallRecord("worker", { env })).toEqual(resumed);
  });

  it("can defer the legacy identity replacement until config migration succeeds", async () => {
    const { root, plan: legacyPlan } = await makePlan();
    const env = stateEnv(root);
    persistClawInstallRecord(legacyPlan, { env, status: "workspace_ready", nowMs: 1 });
    downgradeInstallRecord(root);
    const legacyRecord = readClawInstallRecord("worker", { env });
    if (!legacyRecord) {
      throw new Error("expected legacy install record");
    }
    const boundedPlan = {
      ...legacyPlan,
      planIntegrity: "sha256:bounded-plan",
    };

    const deferred = persistClawInstallRecord(boundedPlan, {
      env,
      status: "pending",
      expectedExistingRecord: legacyRecord,
      expectedExistingPlan: legacyPlan,
      deferLegacyPlanUpgrade: true,
    });

    expect(deferred).toEqual(legacyRecord);
    expect(readClawInstallRecord("worker", { env })).toEqual(legacyRecord);
  });

  it("does not upgrade a v1 record outside an exact resume handoff", async () => {
    const { root, plan } = await makePlan();
    const env = stateEnv(root);
    persistClawInstallRecord(plan, { env, status: "partial", nowMs: 1 });
    downgradeInstallRecord(root);

    expect(() => persistClawInstallRecord(plan, { env, status: "pending", nowMs: 2 })).toThrow(
      "not an exact resumable attempt",
    );
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v1",
      status: "partial",
    });
  });
});
