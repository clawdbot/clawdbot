import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sha256File, sha256Hex } from "../infra/crypto-digest.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  readRecoveryJournalRecord,
  resolveRecoveryJournalPath,
  writeRecoveryJournalRecord,
} from "../snapshot/recovery-journal.js";
import {
  RESTORED_ADMISSION_DESCRIPTOR_VERSION,
  RESTORED_RECOVERY_POINT_REQUEST_VERSION,
  RESTORED_RECOVERY_POINT_RESULT_VERSION,
  type RestoredRecoveryPointResult,
} from "../snapshot/restored-recovery-point.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  completeRestoredAdmission,
  createRestoredAdmissionStatus,
  prepareRestoredAdmission,
} from "./restored-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Gateway restored admission", () => {
  it("persists generation-bound readiness and replays only after owners reconcile again", async () => {
    const fixture = await createFixture();
    const startScheduler = vi.fn(async () => {});

    const first = await completeRestoredAdmission({
      descriptorPath: fixture.descriptorPath,
      env: fixture.env,
      startScheduler,
      getOwnerReadiness: () => ({ ready: true, failing: [] }),
    });
    const replay = await completeRestoredAdmission({
      descriptorPath: fixture.descriptorPath,
      env: fixture.env,
      startScheduler,
      getOwnerReadiness: () => ({ ready: true, failing: [] }),
    });

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ record: first.record, replayed: true });
    expect(startScheduler).toHaveBeenCalledTimes(2);
    await expect(readRecoveryJournalRecord(fixture.journalPath, "ready")).resolves.toEqual(
      first.record,
    );
  });

  it("projects held phases and becomes ready only from committed evidence", async () => {
    const fixture = await createFixture();
    const descriptor = await prepareRestoredAdmission(fixture.descriptorPath, fixture.env);
    const status = createRestoredAdmissionStatus(descriptor);
    const heldReasons: string[] = [];

    expect(status.get()).toMatchObject({
      status: "held",
      reason: "scheduler-reconciliation",
      restoreOperationId: "restore-8",
    });
    const completed = await completeRestoredAdmission({
      descriptor,
      env: fixture.env,
      startScheduler: async () => {},
      getOwnerReadiness: () => ({ ready: true, failing: [] }),
      setHeldReason: (reason) => {
        heldReasons.push(reason);
        status.setHeldReason(reason);
      },
    });
    expect(heldReasons).toEqual(["owner-readiness", "ready-commit"]);
    expect(status.get()).toMatchObject({ status: "held", reason: "ready-commit" });

    status.markReady(completed.record);
    expect(status.get()).toMatchObject({
      status: "ready",
      restoreOperationId: "restore-8",
      readinessIdentity: completed.record.readinessIdentity,
    });
  });

  it("quarantines changed restored bytes before scheduler start", async () => {
    const fixture = await createFixture();
    await fs.appendFile(resolveOpenClawStateSqlitePath(fixture.env), "changed");
    const startScheduler = vi.fn(async () => {});

    await expect(
      completeRestoredAdmission({
        descriptorPath: fixture.descriptorPath,
        env: fixture.env,
        startScheduler,
        getOwnerReadiness: () => ({ ready: true, failing: [] }),
      }),
    ).rejects.toMatchObject({
      code: "restored-admission.target-conflict",
      disposition: "quarantine",
    });
    expect(startScheduler).not.toHaveBeenCalled();
  });

  it("holds admission when an owner is not ready", async () => {
    const fixture = await createFixture();

    await expect(
      completeRestoredAdmission({
        descriptorPath: fixture.descriptorPath,
        env: fixture.env,
        startScheduler: async () => {},
        getOwnerReadiness: () => ({ ready: false, failing: ["discord"] }),
      }),
    ).rejects.toMatchObject({
      code: "restored-admission.owner-readiness-hold",
      disposition: "hold",
    });
    await expect(readRecoveryJournalRecord(fixture.journalPath, "ready")).resolves.toBeUndefined();
  });

  it("quarantines malformed ready evidence instead of throwing raw JSON errors", async () => {
    const fixture = await createFixture();
    const startScheduler = vi.fn(async () => {});
    await completeRestoredAdmission({
      descriptorPath: fixture.descriptorPath,
      env: fixture.env,
      startScheduler,
      getOwnerReadiness: () => ({ ready: true, failing: [] }),
    });
    replaceJournalPayload(fixture.journalPath, "ready", "{");

    await expect(
      completeRestoredAdmission({
        descriptorPath: fixture.descriptorPath,
        env: fixture.env,
        startScheduler,
        getOwnerReadiness: () => ({ ready: true, failing: [] }),
      }),
    ).rejects.toMatchObject({
      code: "restored-admission.target-conflict",
      disposition: "quarantine",
    });
  });
});

async function createFixture() {
  const tempDir = tempDirs.make("openclaw-gateway-restored-admission-");
  const env = { OPENCLAW_STATE_DIR: path.join(tempDir, "state") };
  const globalPath = resolveOpenClawStateSqlitePath(env);
  const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  await fs.writeFile(globalPath, "global-state");
  await fs.writeFile(agentPath, "agent-state");
  const journalDirectory = path.join(tempDir, "journal");
  await fs.mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  const descriptorPath = resolveRecoveryJournalPath(journalDirectory);
  const resultWithoutReceipt: Omit<
    Extract<RestoredRecoveryPointResult, { ok: true }>,
    "restoreReceiptIdentity"
  > = {
    version: RESTORED_RECOVERY_POINT_RESULT_VERSION,
    ok: true as const,
    runtimeLineage: "runtime/tenant-7",
    lifecycleOwnerGeneration: "owner-generation-8",
    destinationRuntimeGeneration: "generation-8",
    restoreOperationId: "restore-8",
    destinationOwner: "lobster/tenant-7",
    admissionIdentity: "admission-8",
    recoveryPointId: "a".repeat(64),
    acceptanceSetId: "b".repeat(64),
    startupDescriptorPath: descriptorPath,
    components: await Promise.all(
      [
        { componentId: "sqlite/global", targetPath: globalPath },
        { componentId: "sqlite/agent/main", targetPath: agentPath },
      ].map(async ({ componentId, targetPath }) => {
        const artifactSha256 = await sha256File(targetPath);
        return {
          componentId,
          artifactSha256,
          targetIdentity: sha256Hex(
            stableStringify({
              componentId,
              destinationRuntimeGeneration: "generation-8",
              artifactSha256,
            }),
          ),
        };
      }),
    ),
  };
  const result: RestoredRecoveryPointResult = {
    ...resultWithoutReceipt,
    restoreReceiptIdentity: sha256Hex(stableStringify(resultWithoutReceipt)),
  };
  await writeRecoveryJournalRecord(descriptorPath, "intent", {
    version: RESTORED_RECOVERY_POINT_REQUEST_VERSION,
    runtimeLineage: result.runtimeLineage,
    lifecycleOwnerGeneration: result.lifecycleOwnerGeneration,
    destinationRuntimeGeneration: result.destinationRuntimeGeneration,
    restoreOperationId: result.restoreOperationId,
    destinationOwner: result.destinationOwner,
    admissionIdentity: result.admissionIdentity,
    recoveryPointPath: path.join(tempDir, "recovery-point"),
    recoveryPointId: result.recoveryPointId,
    acceptanceSetId: result.acceptanceSetId,
    ownerInventory: {
      version: "openclaw-runtime-sqlite-inventory/v1",
      owner: "openclaw-state",
      sourceRuntimeGeneration: "source-generation-7",
      revision: "revision-1",
      agentIds: ["main"],
    },
    journalRoot: journalDirectory,
  });
  await writeRecoveryJournalRecord(descriptorPath, "result", result);
  await writeRecoveryJournalRecord(descriptorPath, "startup", {
    version: RESTORED_ADMISSION_DESCRIPTOR_VERSION,
    journalPath: descriptorPath,
    result,
  });
  return { descriptorPath, env, journalPath: descriptorPath };
}

function replaceJournalPayload(databasePath: string, recordType: string, payload: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database
      .prepare("UPDATE recovery_journal_records SET payload_json = ? WHERE record_type = ?")
      .run(payload, recordType);
  } finally {
    database.close();
  }
}
