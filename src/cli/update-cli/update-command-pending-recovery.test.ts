import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { inspectCheckpointFile } from "../../infra/update-checkpoint-files.js";
import { reopenUpdateCheckpointRestorePlan } from "../../infra/update-checkpoint-restore.js";
import { buildCheckpointReaderRuntime } from "../../infra/update-checkpoint-runtime.test-support.js";
import { captureUpdateCheckpoint, reopenUpdateCheckpoint } from "../../infra/update-checkpoint.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { createUpdateRecoveryCheckpointAdapter } from "../../infra/update-run-recovery-checkpoint.js";
import {
  beginUpdateRecovery,
  bindUpdateRecoveryCheckpoint,
  bindUpdateRecoveryAfterImage,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryObservation,
  recordUpdateRecoveryFailure,
} from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "../../state/openclaw-state-db-cache.js";
import { assertCurrentStateRuntimeSchema } from "../../state/openclaw-state-db-fast-path.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import * as updateShared from "./shared.js";
import type { UpdateCommandOptions } from "./shared.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import {
  finishSuccessfulPackageSwitch,
  taskRecovery,
} from "./update-command-post-update.test-support.js";
import type { UpdateCommandRecovery } from "./update-command-recovery.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = fs.realpathSync(dirs.make("pending-finalizer-"));
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const options = { env };
  const file = path.join(root, "state", "openclaw.sqlite");
  const configPath = path.join(root, "openclaw.json");
  const runtime = { ...(await buildCheckpointReaderRuntime(root)).runtime, buildId: null };
  const run = { runId: createUpdateRun({ trigger: "cli" }, options).runId, env };
  let released = false;
  const prepared = await withOpenClawStateLease(
    {
      scope: "core:test-pending-finalizer",
      key: run.runId,
      database: { scope: "shared", options },
      leaseMs: 60_000,
      waitMs: 0,
      heartbeat: "worker",
    },
    async (lease) => {
      const fence = {
        assertCurrent() {
          if (released) {
            throw new Error("fixture owner released; replay remains pending");
          }
          lease.assertOwned();
        },
      };
      let record = beginUpdateRecovery(
        { runId: run.runId, from: runtime, to: runtime },
        fence,
        options,
      );
      const access = {
        artifactRoot: path.join(root, "artifacts"),
        binding: {
          runId: run.runId,
          stateDir: root,
          configPath,
          fromRuntime: { root: runtime.root, nodePath: runtime.nodePath, version: runtime.version },
        },
      };
      const capture = async (content: string) => {
        fs.writeFileSync(configPath, content);
        const state = await inspectCheckpointFile(configPath);
        if (!lease.withDatabaseFileExclusion) {
          throw new Error("capture owner unavailable");
        }
        const ref = await lease.withDatabaseFileExclusion((assertCurrent) =>
          captureUpdateCheckpoint({
            ...access,
            assertQuiescent: assertCurrent,
            exclusions: [],
            expectedSources: [{ sourcePath: configPath, state }],
            resources: [
              { sourcePath: file, kind: "sqlite", restore: "replace" },
              { sourcePath: configPath, kind: "config", restore: "replace" },
            ],
          }),
        );
        return { ref, binding: (await reopenUpdateCheckpoint(ref, access)).manifest.binding };
      };
      const before = await capture("original");
      record = bindUpdateRecoveryCheckpoint(record, before, fence, options);
      const effectId = randomUUID();
      record = recordUpdateRecoveryIntent(
        record,
        { effectId, kind: "package-activation", resourceId: "fixture", runtime: "candidate" },
        fence,
        options,
      );
      record = recordUpdateRecoveryObservation(
        record,
        { effectId, observedIdentity: "candidate" },
        fence,
        options,
      );
      const after = await capture("candidate");
      record = bindUpdateRecoveryAfterImage(
        record,
        { checkpointRef: before.ref, afterUpdate: after, effectIds: [effectId] },
        fence,
        options,
      );
      record = recordUpdateRecoveryFailure(
        record,
        { code: "candidate-failed", effectId: null },
        fence,
        options,
      );
      record = recordUpdateRecoveryIntent(
        record,
        {
          effectId: randomUUID(),
          kind: "checkpoint-restore",
          resourceId: before.ref.checkpointId,
          runtime: "previous",
        },
        fence,
        options,
      );
      const publish = lease.withDatabaseFilePublication;
      if (!publish) {
        throw new Error("fixture publication capability absent");
      }
      return { record, access, fence, publish };
    },
  );
  released = true;
  closeOpenClawStateDatabaseForTest();
  const validateStagedDatabase = (
    db: Parameters<typeof assertCurrentStateRuntimeSchema>[0],
  ): undefined => {
    assertCurrentStateRuntimeSchema(db, file);
  };
  const assertMatchingRuntime = (): undefined => {
    throw new Error("prior-runtime reopen is not authorized by this refusal fixture");
  };
  const physical = acquireOpenClawStateDatabaseFileExclusion(file);
  let displaced: string;
  try {
    displaced = await physical.runWithSourceReads(async () => {
      const adapter = createUpdateRecoveryCheckpointAdapter({
        expected: prepared.record,
        ...prepared.access,
        database: options,
        fence: { assertCurrent: physical.assertCurrent },
        validateStagedDatabase,
        assertMatchingRuntime,
      });
      const plan = await adapter.prepare();
      if (plan.status !== "ready") {
        throw new Error("fixture plan unavailable");
      }
      await adapter.seal(plan.planRef);
      prepared.record = adapter.record;
      const reopened = await reopenUpdateCheckpointRestorePlan(plan.planRef, prepared.access);
      const shared = reopened.plan.resources.find((resource) => resource.sourcePath === file);
      if (!shared) {
        throw new Error("shared resource absent");
      }
      const target = path.join(shared.stageDirectory, "displaced");
      // Simulate interruption at the actual sealed resource's displacement boundary.
      fs.renameSync(file, target);
      return target;
    });
  } finally {
    physical.release();
  }
  let entries = 0;
  const recovery: UpdateCommandRecovery = {
    options,
    fence: prepared.fence,
    getRecord: () => prepared.record,
    onRecord: (record) => {
      prepared.record = record;
    },
    assertReady: () => {
      throw new Error("serving proof unavailable");
    },
    checkpointReplay: {
      // This is the actual lease capability, intentionally expired when invoked
      // by the refusal test. It must not reopen the missing canonical path.
      withDatabaseFilePublication(operation) {
        entries++;
        return prepared.publish(operation);
      },
      access: {
        artifactRoot: prepared.access.artifactRoot,
        validateStagedDatabase,
        assertMatchingRuntime,
        prepareCanonicalWrite: async () => {
          throw new Error("canonical writer unavailable");
        },
        closeCanonicalDatabase: async () => {
          closeOpenClawStateDatabaseForTest();
        },
      },
    },
  };
  const opts: UpdateCommandOptions = { run, recovery };
  const windows = taskRecovery();
  const rollback = vi.fn(async () => {
    throw new Error("legacy rollback must not run");
  });
  const complete = vi.fn();
  return {
    root,
    env,
    file,
    displaced,
    opts,
    windows,
    rollback,
    complete,
    entries: () => entries,
    invoke: (previousInstallRoot = runtime.root) =>
      finishSuccessfulPackageSwitch(
        { packageRoot: runtime.root, run },
        {
          root: runtime.root,
          previousInstallRoot,
          opts,
          result: {
            status: "error",
            mode: "npm",
            root: runtime.root,
            runId: run.runId,
            reason: "candidate-failed",
            steps: [],
            durationMs: 1,
          },
          preManagedServiceStop: {
            inspected: true,
            runtimeInspected: true,
            running: false,
            stopped: true,
            serviceEnv: env,
            windowsTaskAutoStartRecovery: windows,
          },
          packageTransaction: { rollback, complete, backupRoot: path.join(root, "retained") },
        },
      ),
  };
}

describe("pending recovery finalizer", () => {
  it("refuses standalone finalization before recreating a displaced canonical database", async () => {
    const f = await fixture();
    const before = fs.readFileSync(f.displaced);
    const config = path.join(f.root, "openclaw.json");
    const originalConfig = fs.readFileSync(config);
    const resolveRoot = vi
      .spyOn(updateShared, "resolveUpdateRoot")
      .mockRejectedValue(new Error("ordinary finalization reached root discovery"));
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    await expect(
      withOwnedManagedUpdateEnv({ ...process.env, ...f.env, OPENCLAW_CONFIG_PATH: config }, () =>
        updateFinalizeCommand({ json: true, yes: true, deferCompletionCache: true }),
      ),
    ).rejects.toThrow("publication requires reconciliation");
    expect(resolveRoot).not.toHaveBeenCalled();
    expect(fs.existsSync(f.file)).toBe(false);
    expect(fs.readFileSync(f.displaced)).toEqual(before);
    expect(fs.readFileSync(config)).toEqual(originalConfig);
  });

  it.each([true, false])(
    "preserves a missing canonical database with live-context=%s",
    async (context) => {
      const f = await fixture();
      if (!context) {
        f.opts.recovery = undefined;
      }
      const before = fs.readFileSync(f.displaced);
      const failure = await f.invoke().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        name: "UpdateCommandPendingRecoveryFailure",
        result: {
          reason: "candidate-failed",
          runId: f.opts.run!.runId,
          recovery: { serviceRestartSafe: false },
        },
      });
      expect(f.entries()).toBe(context ? 1 : 0);
      expect(fs.existsSync(f.file)).toBe(false);
      expect(fs.readFileSync(f.displaced)).toEqual(before);
      expect(f.rollback).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.windows.restore).not.toHaveBeenCalled();
      expect(f.windows.complete).not.toHaveBeenCalled();
    },
  );
  it("replays the admitted managed root rather than the original caller root", async () => {
    const f = await fixture();
    const failure = await f.invoke(path.join(f.root, "caller-install")).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      name: "UpdateCommandPendingRecoveryFailure",
      result: { reason: "candidate-failed" },
    });
    expect(f.entries()).toBe(1);
    expect(fs.existsSync(f.file)).toBe(false);
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.windows.restore).not.toHaveBeenCalled();
  });

  it.each(["finalizer", "reported", "unexpected", "completed"] as const)(
    "keeps %s unwind away from autostart, history and managed triage",
    async (kind) => {
      const f = await fixture();
      const run = f.opts.run;
      if (!run) {
        throw new Error("fixture run absent");
      }
      if (kind === "unexpected" || kind === "completed") {
        f.opts.recovery = undefined;
      }
      const before = fs.readFileSync(f.displaced);
      const context = path.join(f.root, "triage.json");
      const meta = path.join(f.root, "sentinel.json");
      fs.writeFileSync(context, "unchanged");
      fs.writeFileSync(meta, JSON.stringify({ meta: { triageContextPath: context } }));
      const primary = {
        status: "error" as const,
        mode: "npm" as const,
        runId: run.runId,
        reason: "candidate-failed",
        steps: [],
        durationMs: 1,
      };
      const target = {
        root: f.root,
        env: {
          ...f.env,
          OPENCLAW_UPDATE_RUN_HANDOFF: "1",
          [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: meta,
        },
        failureResult: primary,
      };
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
      const result = withUpdateFailureTriage({ ...f.opts, json: true }, target, () =>
        withUpdateCommandRecoveryUnwind(
          { ...f.opts, run },
          { triageTarget: target, windowsTaskAutoStartRecovery: f.windows },
          async () => {
            if (kind === "unexpected") {
              throw new Error("lost executor context");
            }
            if (kind === "reported") {
              throw new UpdateCommandFailure(primary);
            }
            if (kind === "finalizer") {
              await f.invoke();
            }
          },
        ),
      );
      await expect(result).rejects.toMatchObject({ code: 1 });
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "candidate-failed",
          runId: run.runId,
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        }),
      );
      expect(fs.existsSync(f.file)).toBe(false);
      expect(fs.readFileSync(f.displaced)).toEqual(before);
      expect(fs.readFileSync(context, "utf8")).toBe("unchanged");
      expect(f.windows.restore).not.toHaveBeenCalled();
      expect(f.windows.complete).not.toHaveBeenCalled();
      expect(f.rollback).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    },
  );
});

describe("migrated-runtime unwind", () => {
  it.each([false, true])(
    "preserves newer canonical state after handoff (failure=%s)",
    async (failed) => {
      const root = fs.realpathSync(dirs.make("migrated-unwind-"));
      const env = { HOME: root, OPENCLAW_STATE_DIR: root };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      closeOpenClawStateDatabaseForTest();
      const file = path.join(root, "state", "openclaw.sqlite");
      const db = new DatabaseSync(file);
      try {
        const row = db.prepare("PRAGMA user_version").get();
        db.exec(`PRAGMA user_version=${Number(row?.user_version) + 1}`);
      } finally {
        db.close();
      }
      const before = fs.readFileSync(file);
      const windows = taskRecovery();
      const failure = new UpdateCommandFailure({
        status: "error",
        mode: "npm",
        runId: run.runId,
        reason: "new-runtime-failed",
        steps: [],
        durationMs: 1,
      });
      const completion = withUpdateCommandRecoveryUnwind(
        { run },
        {
          ledgerHandoffOwned: true,
          ledgerHandoffCompleted: true,
          triageTarget: { env },
          windowsTaskAutoStartRecovery: windows,
        },
        async () => {
          if (failed) {
            throw failure;
          }
        },
      );
      if (failed) {
        await expect(completion).rejects.toBe(failure);
      } else {
        await expect(completion).resolves.toBeUndefined();
      }
      expect(windows.restore).toHaveBeenCalledOnce();
      expect(windows.complete).toHaveBeenCalledOnce();
      expect(fs.readFileSync(file)).toEqual(before);
    },
  );
});

it.each([false, true])(
  "leaves an unconfirmed migrated handoff pending (failure=%s)",
  async (failed) => {
    const root = fs.realpathSync(dirs.make("unconfirmed-handoff-"));
    const env = { HOME: root, OPENCLAW_STATE_DIR: root };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    closeOpenClawStateDatabaseForTest();
    const file = path.join(root, "state", "openclaw.sqlite");
    const before = fs.readFileSync(file);
    const windows = taskRecovery();
    const cause = new Error("candidate finalizer unavailable");
    const primary = {
      status: "error" as const,
      mode: "npm" as const,
      runId: run.runId,
      reason: "candidate-failed",
      steps: [],
      durationMs: 1,
    };
    await expect(
      withUpdateCommandRecoveryUnwind(
        { run },
        {
          ledgerHandoffOwned: true,
          triageTarget: { env, failureResult: primary },
          windowsTaskAutoStartRecovery: windows,
        },
        async () => {
          if (failed) {
            throw cause;
          }
        },
      ),
    ).rejects.toMatchObject({
      name: "UpdateCommandPendingRecoveryFailure",
      result: { reason: "candidate-failed", recovery: { serviceRestartSafe: false } },
      ...(failed ? { cause } : {}),
    });
    expect(windows.restore).not.toHaveBeenCalled();
    expect(windows.complete).toHaveBeenCalledExactlyOnceWith(false);
    expect(fs.readFileSync(file)).toEqual(before);
  },
);
