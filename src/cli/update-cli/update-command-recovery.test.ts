import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createPackageIntegrityReader } from "../../infra/package-update-integrity.js";
import { createPackageRecoveryTransaction } from "../../infra/package-update-recovery.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { legacyRecord } from "../../infra/update-run-recovery-legacy.test-support.js";
import { createUpdateRecoveryPackageHooks } from "../../infra/update-run-recovery-package.js";
import {
  beginUpdateRecovery,
  bindUpdateRecoveryCheckpoint,
  bindUpdateRecoveryAfterImage,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryObservation,
  recordUpdateRecoveryFailure,
  loadUpdateRecovery,
} from "../../infra/update-run-recovery.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { UpdateCommandOptions } from "./shared.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";
import {
  finishSuccessfulPackageSwitch,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import {
  finalizeUpdateCommandRecovery,
  persistUpdateCommandServingReceipt,
} from "./update-command-recovery.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

async function fixture(rollback = false) {
  const root = dirs.make("terminal-consumer-");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const options = { env };
  const live = path.join(root, "node_modules", "openclaw");
  const stage = path.join(root, "stage");
  const backup = path.join(root, "node_modules", ".openclaw.package-backup-test");
  for (const [directory, version] of [
    [live, "1.0.0"],
    [stage, "2.0.0"],
  ] as const) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
    );
  }
  const reader = createPackageIntegrityReader();
  const run = createUpdateRun({ trigger: "cli" }, options);
  const from = { root: live, nodePath: process.execPath, version: "1.0.0", buildId: null };
  const to = { ...from, version: "2.0.0" };
  let current = true;
  const fence = {
    assertCurrent() {
      if (!current) {
        throw new Error("authority lost");
      }
    },
  };
  let record = beginUpdateRecovery({ runId: run.runId, from, to }, fence, options);
  const recovery = {
    getRecord: () => record,
    onRecord: (next: typeof record) => {
      record = next;
    },
    fence,
    options,
    assertReady: () => fence.assertCurrent(),
  };
  const opts: UpdateCommandOptions = { json: true, run: { runId: run.runId, env }, recovery };
  const owner = createPackageRecoveryTransaction(
    {
      version: 1,
      transactionId: record.transactionId,
      packageName: "openclaw",
      liveRoot: live,
      stageRoot: stage,
      backupRoot: backup,
      binDir: path.join(root, "bin"),
      shimBackupRoot: null,
      shimBackupIdentity: null,
      previous: await reader.tree(live),
      candidate: await reader.tree(stage, live),
      launchers: [],
      interruptedLaunchers: [],
      retention: null,
    },
    createUpdateRecoveryPackageHooks(recovery),
  );
  await owner.prepare();
  // Checkpoint owner facts are supplied at its persistence seam. These tests
  // exercise real package roles and SQLite consumers, not artifact capture or exclusion.
  const checkpoint = {
    ref: {
      checkpointId: randomUUID(),
      manifestPath: path.join(root, "before", "manifest.json"),
      manifestSha256: "a".repeat(64),
    },
    binding: {
      runId: run.runId,
      stateDir: root,
      configPath: path.join(root, "openclaw.json"),
      fromRuntime: { root: from.root, nodePath: from.nodePath, version: from.version },
    },
  };
  record = bindUpdateRecoveryCheckpoint(record, checkpoint, fence, options);
  const activation = await owner.beforeActivation();
  await fs.rename(live, backup);
  await fs.rename(stage, live);
  await owner.afterActivation(activation);
  record = bindUpdateRecoveryAfterImage(
    record,
    {
      checkpointRef: checkpoint.ref,
      afterUpdate: {
        binding: checkpoint.binding,
        ref: {
          checkpointId: randomUUID(),
          manifestPath: path.join(root, "after", "manifest.json"),
          manifestSha256: "b".repeat(64),
        },
      },
      effectIds: record.effects.map((effect) => effect.effectId),
    },
    fence,
    options,
  );
  if (rollback) {
    record = recordUpdateRecoveryFailure(
      record,
      { code: "candidate-failed", effectId: null },
      fence,
      options,
    );
    const restoreId = randomUUID();
    record = recordUpdateRecoveryIntent(
      record,
      {
        effectId: restoreId,
        kind: "checkpoint-restore",
        resourceId: checkpoint.ref.checkpointId,
        runtime: "previous",
      },
      fence,
      options,
    );
    record = recordUpdateRecoveryObservation(
      record,
      { effectId: restoreId, observedIdentity: "checkpoint-owner-restored" },
      fence,
      options,
    );
    expect((await owner.rollback()).status).toBe("verified");
  }
  const runtime = rollback ? "previous" : "candidate";
  const restartId = randomUUID();
  record = recordUpdateRecoveryIntent(
    record,
    { effectId: restartId, kind: "service-restart", resourceId: "gateway", runtime },
    fence,
    options,
  );
  record = recordUpdateRecoveryObservation(
    record,
    { effectId: restartId, observedIdentity: "boot" },
    fence,
    options,
  );
  persistUpdateCommandServingReceipt(opts, {
    runId: run.runId,
    gateway: { bootId: "boot", version: rollback ? from.version : to.version, buildId: null },
    kind: "readiness",
    transactionId: record.transactionId,
    claimId: record.claimId,
    revision: record.revision,
    effectId: restartId,
    runtime,
    checks: {
      serviceRunning: true,
      pluginsReady: true,
      channelsReady: true,
      settled: true,
      readyz: true,
    },
    verifiedAtMs: Date.now(),
  });
  return {
    opts,
    recovery,
    options,
    run,
    live,
    backup,
    root,
    get record() {
      return record;
    },
    revoke() {
      current = false;
    },
    reload() {
      closeOpenClawStateDatabaseForTest();
      return loadUpdateRecovery(run.runId, options);
    },
  };
}

describe("durable terminal finalizer consumer", () => {
  it("refuses to serialize live authority into a legacy migrated worker", async () => {
    const f = await fixture();
    await expect(
      continueMigratedUpdateInFreshProcess(
        {
          opts: f.opts,
          mutationStarted: true,
          root: f.live,
          result: { status: "ok", mode: "npm", root: f.live, steps: [], durationMs: 0 },
          configSnapshot: {
            ...validConfigSnapshot,
            path: path.join(f.root, "openclaw.json"),
            exists: true,
            raw: "{}",
            resolved: {},
          },
          installKindChanged: false,
          requestedChannel: null,
          storedChannel: null,
          channel: "stable",
          downgradeRisk: false,
          shouldRestart: true,
          controlPlaneUpdateSentinelMeta: null,
          preUpdatePluginInstallRecords: {},
          startedAt: Date.now(),
          updateStepTimeoutMs: 1000,
        },
        [],
      ),
    ).rejects.toMatchObject({ name: "UpdateCommandRecoveryPendingError" });
    expect(f.reload()?.terminal).toBeUndefined();
  });

  it("commits history and selection, then retains the previous package without deletion", async () => {
    const f = await fixture();
    const complete = () => {
      throw new Error("legacy cleanup must not run");
    };
    await finishSuccessfulPackageSwitch(
      { packageRoot: f.live, run: f.opts.run },
      {
        opts: f.opts,
        packageTransaction: {
          backupRoot: f.backup,
          complete,
          rollback: async () => {
            throw new Error("legacy rollback must not run");
          },
        },
      },
    );
    const committed = f.reload();
    expect(committed?.retainedPair?.state).toBe("selected");
    expect(committed?.package?.descriptor.retention?.state).toBe("selected");
    expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("succeeded");
    expect(await fs.readFile(path.join(f.backup, "package.json"), "utf8")).toContain("1.0.0");
    expect(JSON.stringify(getUpdateRun(f.run.runId, f.options))).not.toContain("pluginsReady");
  });

  it("leaves rolled-back material for explicit retirement without selecting a replacement", async () => {
    const f = await fixture(true);
    await expect(
      finishSuccessfulPackageSwitch(
        { packageRoot: f.live, run: f.opts.run },
        {
          opts: f.opts,
          result: {
            status: "error",
            mode: "npm",
            root: f.live,
            steps: [],
            durationMs: 0,
            reason: "candidate-failed",
          },
        },
      ),
    ).rejects.toMatchObject({ name: "UpdateCommandFailure" });
    expect(f.reload()?.terminal?.status).toBe("rolled-back");
    expect(f.record.retainedPair).toBeUndefined();
    expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("rolled-back");
    expect(await fs.readFile(path.join(f.live, "package.json"), "utf8")).toContain("1.0.0");
    expect(await fs.stat(f.backup + ".candidate")).toBeDefined();
  });

  it("rolls back the terminal transaction when readiness is lost at its final check", async () => {
    const f = await fixture();
    let checks = 0;
    f.recovery.assertReady = () => {
      if (++checks === 2) {
        throw new Error("readiness lost");
      }
    };
    const before = f.record;
    await expect(finalizeUpdateCommandRecovery(f.opts, "succeeded")).rejects.toMatchObject({
      name: "UpdateCommandRecoveryPendingError",
    });
    expect(f.reload()).toEqual(before);
    expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("running");
    expect(await fs.stat(f.backup)).toBeDefined();
  });

  it("keeps a committed selection after a lost acknowledgement and resumes retention once", async () => {
    const f = await fixture();
    const accept = f.recovery.onRecord;
    let loseAck = true;
    f.recovery.onRecord = (next) => {
      accept(next);
      if (next.terminal && loseAck) {
        loseAck = false;
        throw new Error("ack lost");
      }
    };
    await expect(finalizeUpdateCommandRecovery(f.opts, "succeeded")).rejects.toMatchObject({
      name: "UpdateCommandRecoveryPendingError",
    });
    const pairId = f.reload()?.retainedPair?.pairId;
    expect(pairId).toBeTruthy();
    await finalizeUpdateCommandRecovery(f.opts, "succeeded");
    expect(f.reload()?.retainedPair?.pairId).toBe(pairId);
    expect(await fs.stat(f.backup)).toBeDefined();
  });

  it("does not commit or clean when fresh package inspection is unavailable", async () => {
    const f = await fixture();
    await fs.rename(f.backup, f.backup + "-unavailable");
    const before = f.record;
    await expect(finalizeUpdateCommandRecovery(f.opts, "succeeded")).rejects.toMatchObject({
      name: "UpdateCommandRecoveryPendingError",
    });
    expect(f.reload()).toEqual(before);
    expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("running");
    expect(await fs.stat(f.live)).toBeDefined();
  });
});

describe("historical terminal completion diagnostics", () => {
  async function historical(rollback: boolean, terminal = true) {
    const f = await fixture(rollback);
    if (terminal) {
      await finalizeUpdateCommandRecovery(f.opts, rollback ? "rolled-back" : "succeeded");
    }
    const saved = JSON.stringify(legacyRecord(f.record), null, 2);
    const source = openOpenClawStateDatabase(f.options);
    source.db
      .prepare("UPDATE config_machine_state SET value_json=? WHERE state_key=?")
      .run(saved, "update.recovery." + f.run.runId);
    closeOpenClawStateDatabaseForTest();
    const family = async () =>
      Promise.all(
        (await fs.readdir(path.dirname(source.path)))
          .filter(
            (name) =>
              name === path.basename(source.path) ||
              name.startsWith(path.basename(source.path) + "-"),
          )
          .toSorted()
          .map(async (name) => {
            const file = path.join(path.dirname(source.path), name);
            const stat = await fs.stat(file);
            return {
              name,
              bytes: await fs.readFile(file),
              ino: stat.ino,
              size: stat.size,
              mtime: stat.mtimeMs,
              ctime: stat.ctimeMs,
            };
          }),
      );
    return { ...f, family, saved };
  }

  it.each([false, true])(
    "reports historical terminal outcome without rewriting legacy artifacts (rollback=%s)",
    async (rollback) => {
      const f = await historical(rollback);
      const before = await f.family();
      const result = completeUpdateCommandRun(
        {
          status: rollback ? "ok" : "error",
          reason: "stale-process-result",
          mode: "npm",
          root: f.live,
          steps: [],
          durationMs: 1,
        },
        f.opts.run,
      );
      expect(result).toMatchObject({
        status: rollback ? "error" : "ok",
        reason: rollback ? "candidate-failed" : undefined,
        runId: f.run.runId,
      });
      expect(await f.family()).toEqual(before);
    },
  );

  it("keeps unfinished legacy evidence pending without completing history", async () => {
    const f = await historical(false, false);
    const before = await f.family();
    const result = completeUpdateCommandRun(
      { status: "ok", mode: "npm", root: f.live, steps: [], durationMs: 1 },
      f.opts.run,
    );
    expect(result).toMatchObject({ status: "error", reason: "update-recovery-pending" });
    expect(await f.family()).toEqual(before);
    expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("running");
  });

  it("does not turn unrelated legacy inspection into permission for the writing fallback", async () => {
    const f = await historical(false);
    const other = createUpdateRun({ trigger: "cli" }, f.options);
    closeOpenClawStateDatabaseForTest();
    const before = await f.family();
    expect(() =>
      completeUpdateCommandRun(
        { status: "ok", mode: "npm", steps: [], durationMs: 1 },
        { runId: other.runId, env: f.opts.run!.env },
      ),
    ).toThrow();
    expect(await f.family()).toEqual(before);
    expect(getUpdateRun(other.runId, f.options)?.status).toBe("running");
  });
});
