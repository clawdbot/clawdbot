// Provenance compatibility coverage for created and adopted agent ownership.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  clawInstallRecordMatchesPlan,
  persistClawInstallRecord,
  readClawInstallRecord,
  updateClawInstallRecord,
} from "./provenance.js";
import { makeProvenancePlan, stateEnv } from "./provenance.test-helpers.js";
import type { ClawAddPlan } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

function adoptedPlan(plan: ClawAddPlan): ClawAddPlan {
  return {
    ...plan,
    actions: plan.actions.map((action) =>
      action.kind === "agent" ? { ...action, action: "adopt" as const } : action,
    ),
  };
}

function rawOriginPayload(root: string): {
  schema_version: string;
  agent_owned_paths_json: string;
} {
  return openOpenClawStateDatabase({ env: stateEnv(root) })
    .db.prepare(
      "SELECT schema_version, agent_owned_paths_json FROM claw_installs WHERE agent_id = ?",
    )
    .get("worker") as { schema_version: string; agent_owned_paths_json: string };
}

describe("Claw agent-origin provenance", () => {
  it("keeps newly created agents on v2 array records", async () => {
    const root = tempDirs.make("openclaw-claw-origin-created-");
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });

    const record = persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 1 });

    expect(record).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v2",
      agentOrigin: "created",
    });
    expect(JSON.parse(rawOriginPayload(root).agent_owned_paths_json)).toEqual(
      record.agentOwnedPaths,
    );
  });

  it("round-trips adopted agents through the v3 origin envelope", async () => {
    const root = tempDirs.make("openclaw-claw-origin-adopted-");
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });

    persistClawInstallRecord(adoptedPlan(plan), { env: stateEnv(root), nowMs: 1 });
    const row = rawOriginPayload(root);

    expect(row.schema_version).toBe("openclaw.clawInstallRecord.v3");
    expect(JSON.parse(row.agent_owned_paths_json)).toEqual({
      origin: "adopted",
      paths: ['agents.entries["worker"]'],
    });
    expect(readClawInstallRecord("worker", { env: stateEnv(root) })).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v3",
      agentOrigin: "adopted",
      agentOwnedPaths: ['agents.entries["worker"]'],
    });
  });

  it("preserves adopted v3 origin through update", async () => {
    const root = tempDirs.make("openclaw-claw-origin-update-");
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    const adopted = adoptedPlan(plan);
    persistClawInstallRecord(adopted, { env: stateEnv(root), nowMs: 1 });

    const record = updateClawInstallRecord(adopted, { env: stateEnv(root), nowMs: 2 });

    expect(record).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v3",
      agentOrigin: "adopted",
    });
    expect(JSON.parse(rawOriginPayload(root).agent_owned_paths_json)).toEqual({
      origin: "adopted",
      paths: record.agentOwnedPaths,
    });
  });

  it("binds adopted resume to origin, agent digest, workspace, package identity, and plan", async () => {
    const root = tempDirs.make("openclaw-claw-origin-resume-");
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    const adopted = adoptedPlan(plan);
    const record = persistClawInstallRecord(adopted, {
      env: stateEnv(root),
      status: "partial",
      nowMs: 1,
    });

    expect(clawInstallRecordMatchesPlan(record, adopted)).toBe(true);
    const mismatches: ClawAddPlan[] = [
      plan,
      { ...adopted, planIntegrity: "sha256:different" },
      { ...adopted, claw: { ...adopted.claw, version: "9.9.9" } },
      {
        ...adopted,
        agent: { ...adopted.agent, workspace: `${adopted.agent.workspace}-other` },
      },
      {
        ...adopted,
        agent: {
          ...adopted.agent,
          config: { ...adopted.agent.config, default: true },
        },
      },
    ];
    for (const mismatch of mismatches) {
      expect(clawInstallRecordMatchesPlan(record, mismatch)).toBe(false);
    }
  });

  it("makes a pre-v3 reader reject adopted provenance before lifecycle mutation", async () => {
    const root = tempDirs.make("openclaw-claw-origin-downgrade-");
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    persistClawInstallRecord(adoptedPlan(plan), { env: stateEnv(root), nowMs: 1 });
    const row = rawOriginPayload(root);
    const mutateStatusUpdateOrRemove = vi.fn();

    const readWithPreV3Contract = () => {
      if (
        row.schema_version !== "openclaw.clawInstallRecord.v1" &&
        row.schema_version !== "openclaw.clawInstallRecord.v2"
      ) {
        throw new Error(
          `Unsupported Claw install record schema ${JSON.stringify(row.schema_version)}.`,
        );
      }
      const paths = JSON.parse(row.agent_owned_paths_json);
      if (!Array.isArray(paths)) {
        throw new Error("Unsupported Claw agent-owned paths payload.");
      }
      mutateStatusUpdateOrRemove();
    };

    expect(readWithPreV3Contract).toThrow(
      'Unsupported Claw install record schema "openclaw.clawInstallRecord.v3".',
    );
    expect(mutateStatusUpdateOrRemove).not.toHaveBeenCalled();
  });
});
