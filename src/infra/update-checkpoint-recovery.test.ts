import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { inspectCheckpointFile } from "./update-checkpoint-files.js";
import {
  discoverUpdateCheckpointRestoreFamilies,
  inspectUpdateCheckpointRestoreResource,
  prepareUpdateCheckpointRestore,
  reopenUpdateCheckpointRestorePlan,
  restoreUpdateCheckpointResource,
  sealUpdateCheckpointRestoreSharedDatabase,
  verifyUpdateCheckpointRestore,
} from "./update-checkpoint-restore.js";
import { buildCheckpointReaderRuntime } from "./update-checkpoint-runtime.test-support.js";
import { captureUpdateCheckpoint, type UpdateCheckpointAccess } from "./update-checkpoint.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import {
  beginUpdateRecovery,
  claimUpdateRecovery,
  loadUpdateRecovery,
  prepareUpdateRecoveryCarryForward,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryRestoreProgress,
} from "./update-run-recovery.js";

const roots: string[] = [];
const fence = { assertCurrent: () => {} }; // All writers are owned by this disposable fixture.
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
function mutate(file: string, sql: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
async function fixture(
  failure?: "late-unavailable" | "preparation-interrupted" | "prepared-return-lost",
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-recovery-")));
  roots.push(root);
  const stateDir = path.join(root, "live"),
    configPath = path.join(stateDir, "openclaw.json");
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: stateDir } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const file = path.join(stateDir, "state", "openclaw.sqlite");
  const { runtime: fixtureRuntime } = await buildCheckpointReaderRuntime(
    path.join(root, "package"),
  );
  const runtime = { ...fixtureRuntime, buildId: null };
  let record = beginUpdateRecovery(
    { runId: run.runId, from: runtime, to: runtime },
    fence,
    options,
  );
  closeOpenClawStateDatabaseForTest();
  await fs.writeFile(configPath, "old config");
  const access: UpdateCheckpointAccess = {
    artifactRoot: path.join(root, "artifacts"),
    binding: {
      runId: run.runId,
      stateDir,
      configPath,
      fromRuntime: {
        root: runtime.root,
        nodePath: runtime.nodePath,
        version: runtime.version,
      },
    },
    assertQuiescent: fence.assertCurrent,
  };
  const capture = async () =>
    captureUpdateCheckpoint({
      ...access,
      exclusions: [],
      expectedSources: [
        { sourcePath: configPath, state: await inspectCheckpointFile(configPath) },
        ...(failure === "late-unavailable"
          ? [{ sourcePath: path.join(stateDir, "service.env"), state: null }]
          : []),
      ],
      resources: [
        { sourcePath: configPath, kind: "config", restore: "replace" },
        { sourcePath: file, kind: "sqlite", restore: "replace" },
        ...(failure === "late-unavailable"
          ? [
              {
                sourcePath: path.join(stateDir, "service.env"),
                kind: "service" as const,
                restore: "replace" as const,
              },
            ]
          : []),
      ],
    });
  const checkpointRef = await capture();
  await fs.writeFile(configPath, "candidate config");
  const afterUpdateRef = await capture();
  // Work and history created after the checkpoint must survive both renames.
  const later = createUpdateRun({ trigger: "cli" }, options);
  finishUpdateRun(later.runId, { status: "failed", reason: "retained history" }, options);
  record = recordUpdateRecoveryIntent(
    record,
    {
      effectId: randomUUID(),
      kind: "checkpoint-restore",
      resourceId: checkpointRef.checkpointId,
      runtime: "previous",
    },
    fence,
    options,
  );
  closeOpenClawStateDatabaseForTest();
  mutate(
    file,
    "INSERT INTO config_machine_state VALUES('operator.new-work','\"online verification work\"',42)",
  );
  const preparing = {
    ...access,
    checkpointRef,
    afterUpdateRef,
    prepareSharedDatabase({
      sourceDb,
      stagedDb,
      planIdentity,
    }: Parameters<
      Parameters<typeof prepareUpdateCheckpointRestore>[0]["prepareSharedDatabase"]
    >[0]) {
      const result = prepareUpdateRecoveryCarryForward({
        sourceDb,
        stagedDb,
        expected: record,
        nextProgress: { ...planIdentity, planSha256: null, resourceCursor: 0, phase: "preparing" },
        fence,
        validateStagedDatabase() {},
      });
      record = result.record;
      return result;
    },
  };
  if (failure === "late-unavailable") {
    const conflict = path.join(stateDir, "service.env");
    await fs.writeFile(conflict, "new operator edit");
    expect(await prepareUpdateCheckpointRestore(preparing)).toEqual({
      status: "unavailable",
      resource: conflict,
    });
    expect(loadUpdateRecovery(record.runId, options)?.restore).toBeNull();
    // The operator removes its newly created file: the original bound absence
    // is restored. Rewriting candidate bytes would not restore file identity.
    await fs.unlink(conflict);
  }
  let resumeIdentity;
  let priorPlanRef;
  if (failure === "prepared-return-lost") {
    const prior = await prepareUpdateCheckpointRestore(preparing);
    if (prior.status !== "ready") {
      throw new Error("preparation unavailable");
    }
    priorPlanRef = prior.planRef;
    resumeIdentity = {
      restoreId: prior.planRef.restoreId,
      checkpointId: prior.planRef.checkpointId,
      planPath: prior.planRef.planPath,
    };
  }
  if (failure === "preparation-interrupted") {
    await expect(
      prepareUpdateCheckpointRestore({
        ...preparing,
        prepareSharedDatabase(args) {
          preparing.prepareSharedDatabase(args);
          throw new Error("preparation interrupted");
        },
      }),
    ).rejects.toThrow("preparation interrupted");
    resumeIdentity = record.restore && {
      restoreId: record.restore.restoreId,
      checkpointId: record.restore.checkpointId,
      planPath: record.restore.planPath,
    };
    expect(resumeIdentity).toBeTruthy();
  }
  const prepared = await prepareUpdateCheckpointRestore({
    ...preparing,
    ...(resumeIdentity ? { preparingPlan: resumeIdentity } : {}),
  });
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") {
    throw new Error("fixture preparation unavailable");
  }
  if (priorPlanRef) {
    expect(prepared.planRef).toEqual(priorPlanRef);
  }
  const request = {
    ...access,
    planRef: prepared.planRef,
    resourceCursor: 0,
    // Synthetic reader contract for this fixture only, not a live older-runtime proof.
    validateStagedDatabase(db: DatabaseSync): undefined {
      expect(db.isTransaction).toBe(true);
      expect(
        db
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get("operator.new-work"),
      ).toEqual({ value_json: '"online verification work"' });
      expect(
        db.prepare("SELECT reason FROM update_runs WHERE run_id = ?").get(later.runId),
      ).toEqual({ reason: "retained history" });
    },
  };
  const reopened = await reopenUpdateCheckpointRestorePlan(prepared.planRef, access);
  const shared = reopened.plan.resources[0]!;
  expect(shared.sourcePath).toBe(file);
  const stage = path.join(shared.stageDirectory, "replacement");
  return { access, options, file, stage, shared, request, record, later, configPath };
}

describe("checkpoint publication with the actual recovery owner", () => {
  it("does not seal successfully without the actual retained reader even when the in-transaction callback approves", async () => {
    const f = await fixture();
    await fs.rename(
      path.join(f.access.binding.fromRuntime.root, "dist", "index.js"),
      path.join(f.access.binding.fromRuntime.root, "dist", "unavailable.js"),
    );
    await expect(
      sealUpdateCheckpointRestoreSharedDatabase({
        ...f.request,
        recoveryRecord: f.record,
        fence,
      }),
    ).rejects.toThrow("Previous runtime database validation unavailable");
    // Both local commits may have completed; that fact alone must not enable replay.
    const current = loadUpdateRecovery(f.record.runId, f.options)!;
    expect(current.restore?.phase).toBe("intent");
    expect(
      await restoreUpdateCheckpointResource({
        ...f.request,
        recoveryRecord: current,
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: "previous-runtime-unavailable",
      observed: "before",
    });
    expect(
      await inspectUpdateCheckpointRestoreResource({
        ...f.request,
        recoveryRecord: current,
      }),
    ).toMatchObject({ observed: "before" });
  });

  it("revalidates the real runtime on replay instead of trusting an earlier successful seal", async () => {
    const f = await fixture();
    const sealed = await sealUpdateCheckpointRestoreSharedDatabase({
      ...f.request,
      recoveryRecord: f.record,
      fence,
    });
    await fs.rename(
      path.join(f.access.binding.fromRuntime.root, "dist", "index.js"),
      path.join(f.access.binding.fromRuntime.root, "dist", "unavailable.js"),
    );
    const before = await Promise.all([f.file, f.stage].map(inspectCheckpointFile));
    expect(
      await restoreUpdateCheckpointResource({
        ...f.request,
        recoveryRecord: sealed,
      }),
    ).toMatchObject({ status: "unavailable", reason: "previous-runtime-unavailable" });
    expect(await Promise.all([f.file, f.stage].map(inspectCheckpointFile))).toEqual(before);
  });

  it.each(["rejection", "asynchronous result"])(
    "does not seal or publish after executor validation %s",
    async (failure) => {
      const f = await fixture();
      const sourceBefore = await inspectCheckpointFile(f.file);
      const stageBefore = await inspectCheckpointFile(f.stage);
      const planBefore = await fs.readFile(f.request.planRef.planPath);
      const request = {
        ...f.request,
        recoveryRecord: f.record,
        fence,
        validateStagedDatabase() {
          throw new Error("previous runtime refuses staged database");
        },
      };
      if (failure === "asynchronous result") {
        // Exercise an untyped caller without weakening the synchronous TypeScript contract.
        Reflect.set(request, "validateStagedDatabase", () => Promise.resolve());
      }
      await expect(sealUpdateCheckpointRestoreSharedDatabase(request)).rejects.toThrow(
        failure === "rejection"
          ? "previous runtime refuses staged database"
          : "validateStagedDatabase must be synchronous",
      );
      expect(loadUpdateRecovery(f.record.runId, f.options)).toEqual(f.record);
      expect(loadUpdateRecovery(f.record.runId, { path: f.stage })).toEqual(f.record);
      expect((await inspectCheckpointFile(f.file))?.sha256).toBe(sourceBefore?.sha256);
      expect((await inspectCheckpointFile(f.stage))?.sha256).toBe(stageBefore?.sha256);
      expect(await fs.readFile(f.request.planRef.planPath)).toEqual(planBefore);
      expect((await restoreUpdateCheckpointResource(request)).status).toBe("conflict");
      expect(await fs.readFile(f.configPath, "utf8")).toBe("candidate config");
    },
  );

  it.each(["late-unavailable", "preparation-interrupted", "prepared-return-lost"] as const)(
    "retries %s without pinning recovery to a dead plan",
    async (failure) => {
      const f = await fixture(failure);
      const sealed = await sealUpdateCheckpointRestoreSharedDatabase({
        ...f.request,
        recoveryRecord: f.record,
        fence,
      });
      expect(
        (await restoreUpdateCheckpointResource({ ...f.request, recoveryRecord: sealed })).status,
      ).toBe("applied");
    },
  );

  it("retries an interrupted staged seal using only source authority and preserves other staged data", async () => {
    const f = await fixture();
    const source = new DatabaseSync(f.file),
      stage = new DatabaseSync(f.stage);
    try {
      expect(() =>
        prepareUpdateRecoveryCarryForward({
          sourceDb: source,
          stagedDb: stage,
          expected: f.record,
          nextProgress: { ...f.request.planRef, resourceCursor: 0, phase: "intent" },
          fence: {
            assertCurrent() {
              if (source.isTransaction && !stage.isTransaction) {
                throw new Error("interrupted staged commit");
              }
            },
          },
          validateStagedDatabase() {},
        }),
      ).toThrow("interrupted staged commit");
    } finally {
      source.close();
      stage.close();
    }
    expect(loadUpdateRecovery(f.record.runId, f.options)).toEqual(f.record);
    expect(loadUpdateRecovery(f.record.runId, { path: f.stage })?.revision).toBe(
      f.record.revision + 1,
    );
    const sealed = await sealUpdateCheckpointRestoreSharedDatabase({
      ...f.request,
      recoveryRecord: f.record,
      fence,
    });
    expect(
      (await restoreUpdateCheckpointResource({ ...f.request, recoveryRecord: sealed })).status,
    ).toBe("applied");
  });

  it("seals a non-circular plan, publishes current history and work, then advances only the restored copy", async () => {
    const f = await fixture();
    const planBytes = await fs.readFile(f.request.planRef.planPath);
    expect(
      (await inspectUpdateCheckpointRestoreResource({ ...f.request, recoveryRecord: f.record }))
        .observed,
    ).toBe("conflict");
    const sealed = await sealUpdateCheckpointRestoreSharedDatabase({
      ...f.request,
      recoveryRecord: f.record,
      fence,
    });
    expect(sealed.restore?.planSha256).toBe(f.request.planRef.planSha256);
    expect(await fs.readFile(f.request.planRef.planPath)).toEqual(planBytes);
    const family = await Promise.all([
      inspectCheckpointFile(f.file),
      inspectCheckpointFile(f.stage),
    ]);
    const request = { ...f.request, recoveryRecord: sealed };
    expect((await inspectUpdateCheckpointRestoreResource(request)).observed).toBe("before");
    expect(
      await Promise.all([inspectCheckpointFile(f.file), inspectCheckpointFile(f.stage)]),
    ).toEqual(family);
    expect((await restoreUpdateCheckpointResource(request)).status).toBe("applied");
    const recorded = recordUpdateRecoveryRestoreProgress(
      sealed,
      { ...sealed.restore!, phase: "observed" },
      fence,
      f.options,
    );
    const observed = claimUpdateRecovery(recorded, fence, f.options);
    closeOpenClawStateDatabaseForTest();
    expect(
      (await restoreUpdateCheckpointResource({ ...request, recoveryRecord: observed })).status,
    ).toBe("already-applied");
    expect(
      loadUpdateRecovery(observed.runId, { path: path.join(f.shared.stageDirectory, "displaced") }),
    ).toEqual(sealed);
    expect(getUpdateRun(f.later.runId, f.options)?.reason).toBe("retained history");
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
      expect(
        db
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key='operator.new-work'",
          )
          .get()?.value_json,
      ).toBe('"online verification work"');
    }, f.options);
    expect(
      (
        await restoreUpdateCheckpointResource({
          ...request,
          recoveryRecord: observed,
          resourceCursor: 1,
        })
      ).status,
    ).toBe("applied");
    expect(
      (await verifyUpdateCheckpointRestore({ ...request, recoveryRecord: observed })).status,
    ).toBe("verified");
    expect(await fs.readFile(f.configPath, "utf8")).toBe("old config");
  });

  it.each(["failure", "claim", "timestamp"])(
    "rejects a displaced %s rewrite after canonical progress without mutating either family",
    async (change) => {
      const f = await fixture();
      const sealed = await sealUpdateCheckpointRestoreSharedDatabase({
        ...f.request,
        recoveryRecord: f.record,
        fence,
      });
      expect(
        (await restoreUpdateCheckpointResource({ ...f.request, recoveryRecord: sealed })).status,
      ).toBe("applied");
      const current = recordUpdateRecoveryRestoreProgress(
        sealed,
        { ...sealed.restore!, phase: "observed" },
        fence,
        f.options,
      );
      closeOpenClawStateDatabaseForTest();
      const displaced = path.join(f.shared.stageDirectory, "displaced");
      const rewritten = { ...sealed };
      if (change === "failure") {
        rewritten.primaryFailure = { code: "rewritten", effectId: null };
      } else if (change === "claim") {
        rewritten.claimId = randomUUID();
      } else {
        rewritten.updatedAtMs += 1;
      }
      const db = new DatabaseSync(displaced);
      try {
        db.prepare(
          "UPDATE config_machine_state SET value_json = ?, updated_at_ms = ? WHERE state_key = ?",
        ).run(JSON.stringify(rewritten), rewritten.updatedAtMs, "update.recovery." + current.runId);
      } finally {
        db.close();
      }
      const request = { ...f.request, recoveryRecord: current };
      const families = async () =>
        Promise.all(
          [f.file, displaced].flatMap((file) =>
            ["", "-wal", "-shm", "-journal"].map((suffix) => inspectCheckpointFile(file + suffix)),
          ),
        );
      const before = await families();
      expect((await inspectUpdateCheckpointRestoreResource(request)).observed).toBe("conflict");
      expect((await restoreUpdateCheckpointResource(request)).status).toBe("conflict");
      expect(await families()).toEqual(before);
      expect(await fs.readFile(f.configPath, "utf8")).toBe("candidate config");
    },
  );

  it.each(["operator data", "history", "stale claim", "same-content inode"])(
    "refuses %s changed after sealing",
    async (change) => {
      const f = await fixture();
      const sealed = await sealUpdateCheckpointRestoreSharedDatabase({
        ...f.request,
        recoveryRecord: f.record,
        fence,
      });
      if (change === "operator data") {
        mutate(
          f.stage,
          "UPDATE config_machine_state SET value_json='\"changed\"' WHERE state_key='operator.new-work'",
        );
      }
      if (change === "history") {
        mutate(f.stage, "UPDATE update_runs SET reason='changed'");
      }
      if (change === "same-content inode") {
        await fs.rename(f.stage, `${f.stage}.saved`);
        await fs.copyFile(`${f.stage}.saved`, f.stage);
      }
      const before = await inspectCheckpointFile(f.file);
      expect(
        (
          await restoreUpdateCheckpointResource({
            ...f.request,
            recoveryRecord: change === "stale claim" ? f.record : sealed,
          })
        ).status,
      ).toBe("conflict");
      expect(await inspectCheckpointFile(f.file)).toEqual(before);
    },
  );

  it.each(["displaced", "published"])(
    "reconciles shared-DB interruption after %s without opening a writer",
    async (phase) => {
      const f = await fixture();
      const sealed = await sealUpdateCheckpointRestoreSharedDatabase({
        ...f.request,
        recoveryRecord: f.record,
        fence,
      });
      await fs.rename(f.file, path.join(f.shared.stageDirectory, "displaced"));
      if (phase === "published") {
        await fs.rename(f.stage, f.file);
      }
      const discovered = await discoverUpdateCheckpointRestoreFamilies(f.file);
      expect(discovered).toEqual([
        {
          restoreId: f.request.planRef.restoreId,
          sourcePath: f.file,
          stageDirectory: f.shared.stageDirectory,
          replacementPath: f.stage,
          displacedPath: path.join(f.shared.stageDirectory, "displaced"),
        },
      ]);
      const before = await fs.readdir(f.shared.stageDirectory);
      const request = { ...f.request, recoveryRecord: sealed };
      expect((await inspectUpdateCheckpointRestoreResource(request)).observed).toBe(
        phase === "published" ? "after" : "before",
      );
      expect(await fs.readdir(f.shared.stageDirectory)).toEqual(before);
      expect((await restoreUpdateCheckpointResource(request)).status).toBe(
        phase === "published" ? "already-applied" : "applied",
      );
      expect(loadUpdateRecovery(sealed.runId, f.options)).toEqual(sealed);
    },
  );
});
