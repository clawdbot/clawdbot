import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { inspectCheckpointFile } from "../../infra/update-checkpoint-files.js";
import { buildCheckpointReaderRuntime } from "../../infra/update-checkpoint-runtime.test-support.js";
import { captureUpdateCheckpoint, reopenUpdateCheckpoint } from "../../infra/update-checkpoint.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { createUpdateRecoveryCheckpointAdapter } from "../../infra/update-run-recovery-checkpoint.js";
import {
  beginUpdateRecovery,
  bindUpdateRecoveryCheckpoint,
  bindUpdateRecoveryAfterImage,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryObservation,
  recordUpdateRecoveryFailure,
  loadUpdateRecovery,
} from "../../infra/update-run-recovery.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "../../state/openclaw-state-db-cache.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { UpdateCommandRecovery } from "./update-command-recovery.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(sealed = true) {
  const root = fs.realpathSync(dirs.make("rollback-replay-consumer-"));
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const options = { env };
  const file = path.join(root, "state", "openclaw.sqlite");
  const configPath = path.join(root, "openclaw.json");
  const runtime = { ...(await buildCheckpointReaderRuntime(root)).runtime, buildId: null };
  const run = { runId: createUpdateRun({ trigger: "cli" }, options).runId, env };
  // Isolated fixture setup only; the actual consumer interval below acquires
  // the real physical owner. No live-lease publication capability is claimed.
  let held = true;
  const fence = {
    assertCurrent() {
      if (!held) {
        throw new Error("lost current owner");
      }
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
    assertQuiescent: () => fence.assertCurrent(),
  };
  const capture = async (content: string) => {
    fs.writeFileSync(configPath, content);
    const source = { sourcePath: configPath, state: await inspectCheckpointFile(configPath) };
    closeOpenClawStateDatabaseForTest();
    const ref = await captureUpdateCheckpoint({
      ...access,
      exclusions: [],
      expectedSources: [source],
      resources: [
        { sourcePath: file, kind: "sqlite", restore: "replace" },
        { sourcePath: configPath, kind: "config", restore: "replace" },
      ],
    });
    return { ref, binding: (await reopenUpdateCheckpoint(ref, access)).manifest.binding };
  };
  const initial = await capture("original");
  record = bindUpdateRecoveryCheckpoint(record, initial, fence, options);
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
    { checkpointRef: initial.ref, afterUpdate: after, effectIds: [effectId] },
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
      resourceId: initial.ref.checkpointId,
      runtime: "previous",
    },
    fence,
    options,
  );
  closeOpenClawStateDatabaseForTest();
  const adapter = createUpdateRecoveryCheckpointAdapter({
    expected: record,
    artifactRoot: access.artifactRoot,
    database: options,
    fence,
    validateStagedDatabase: () => undefined,
    assertMatchingRuntime: () => {
      throw new Error("runtime owner not established");
    },
  });
  const prepared = await adapter.prepare();
  if (prepared.status !== "ready") {
    throw new Error("fixture preparation refused");
  }
  if (sealed) {
    await adapter.seal(prepared.planRef);
  }
  record = adapter.record;
  const recovery: UpdateCommandRecovery = {
    getRecord: () => record,
    onRecord: (next) => {
      record = next;
    },
    fence,
    options,
    assertReady: () => {
      throw new Error("serving proof not established");
    },
  };
  const opts: UpdateCommandOptions = { run, recovery };
  const rollback = vi.fn(async () => {
    throw new Error("legacy package rollback must not run");
  });
  const complete = vi.fn();
  const invoke = (
    preManagedServiceStop?: Parameters<typeof rollbackFailedUpdate>[0]["preManagedServiceStop"],
  ) =>
    rollbackFailedUpdate({
      result: {
        status: "error",
        mode: "npm",
        root,
        reason: "candidate-failed",
        steps: [],
        durationMs: 1,
      },
      previousRoot: root,
      config: {},
      opts,
      timeoutMs: 1000,
      packageTransaction: { rollback, complete, backupRoot: path.join(root, "retained") },
      preManagedServiceStop,
    });
  let intervals = 0;
  const installPhysicalInterval = (runtimeFailure = "canonical lease rebinding unavailable") => {
    recovery.checkpointReplay = {
      async withPublication(operation) {
        intervals++;
        const physical = acquireOpenClawStateDatabaseFileExclusion(file);
        try {
          return await physical.runWithSourceReads(() =>
            operation({
              artifactRoot: access.artifactRoot,
              fence: { assertCurrent: physical.assertCurrent },
              validateStagedDatabase: () => undefined,
              assertMatchingRuntime: () => {
                throw new Error("runtime not established");
              },
              prepareCanonicalWrite: async () => {
                throw new Error(runtimeFailure);
              },
              closeCanonicalDatabase: async () => {
                closeOpenClawStateDatabaseForTest();
              },
            }),
          );
        } finally {
          physical.release();
        }
      },
    };
  };
  return {
    root,
    file,
    configPath,
    opts,
    recovery,
    options,
    run,
    invoke,
    rollback,
    complete,
    prepared,
    installPhysicalInterval,
    intervals: () => intervals,
    revoke: () => {
      held = false;
    },
    get record() {
      return record;
    },
  };
}

describe("durable failure checkpoint replay consumer", () => {
  it("refuses missing publication authority before legacy work and preserves the primary failure", async () => {
    const f = await fixture();
    const before = fs.readFileSync(f.file);
    const result = await f.invoke();
    expect(result).toMatchObject({
      rolledBack: false,
      result: { reason: "candidate-failed", recovery: { serviceRestartSafe: false } },
      pendingRecoveryReason: expect.stringContaining("lease rebinding"),
    });
    expect(fs.readFileSync(f.file)).toEqual(before);
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.record);
    expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("running");
  });

  it("leaves unsealed preparing intent untouched without entering publication", async () => {
    const f = await fixture(false);
    f.installPhysicalInterval();
    const before = fs.readFileSync(f.file);
    expect(await f.invoke()).toMatchObject({
      checkpointReplay: "preparing",
      rolledBack: false,
      result: { reason: "candidate-failed" },
    });
    expect(f.intervals()).toBe(0);
    expect(fs.readFileSync(f.file)).toEqual(before);
    expect(f.rollback).not.toHaveBeenCalled();
  });

  it("publishes through the actual checkpoint owner, but never claims on missing runtime/rebind authority", async () => {
    const f = await fixture();
    f.installPhysicalInterval();
    const sealed = f.record;
    const result = await f.invoke();
    expect(result).toMatchObject({
      rolledBack: false,
      pendingRecoveryReason: "canonical lease rebinding unavailable",
      result: { reason: "candidate-failed" },
    });
    expect(f.intervals()).toBe(1);
    const { reopenUpdateCheckpointRestorePlan } =
      await import("../../infra/update-checkpoint-restore.js");
    const reopened = await reopenUpdateCheckpointRestorePlan(f.prepared.planRef, {
      artifactRoot: path.join(f.root, "artifacts"),
      binding: sealed.checkpoint!.binding,
    });
    const displaced = path.join(reopened.plan.resources[0]!.stageDirectory, "displaced");
    expect(fs.existsSync(displaced)).toBe(true);
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(sealed);
    expect(fs.readFileSync(f.configPath, "utf8")).toBe("candidate");
    expect(f.record.effects.at(-1)?.state).toBe("intent");
    expect(f.record.terminal).toBeUndefined();
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("refuses changed operator data before publication or history updates", async () => {
    const f = await fixture();
    f.installPhysicalInterval();
    fs.writeFileSync(f.configPath, "operator-newer");
    const before = fs.readFileSync(f.file);
    expect(await f.invoke()).toMatchObject({ checkpointReplay: "conflict", rolledBack: false });
    expect(fs.readFileSync(f.file)).toEqual(before);
    expect(fs.readFileSync(f.configPath, "utf8")).toBe("operator-newer");
    expect(f.rollback).not.toHaveBeenCalled();
  });

  it("rejects wrong admitted state and current fence loss before entering an effect", async () => {
    const f = await fixture();
    f.installPhysicalInterval();
    const before = fs.readFileSync(f.file);
    f.opts.run = { ...f.run, env: { OPENCLAW_STATE_DIR: path.join(f.root, "foreign") } };
    expect(await f.invoke()).toMatchObject({
      rolledBack: false,
      pendingRecoveryReason: expect.stringContaining("state root"),
    });
    expect(fs.existsSync(path.join(f.root, "foreign"))).toBe(false);
    f.opts.run = f.run;
    f.revoke();
    expect(await f.invoke()).toMatchObject({
      rolledBack: false,
      pendingRecoveryReason: "lost current owner",
    });
    expect(fs.readFileSync(f.file)).toEqual(before);
  });
  it("keeps a real interrupted displacement pending across a missing canonical retry", async () => {
    const f = await fixture();
    f.installPhysicalInterval();
    const sealed = f.record;
    const rename = fs.renameSync;
    const crash = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(from) === f.file) {
        throw new Error("interrupted after displacement");
      }
    });
    expect(await f.invoke()).toMatchObject({
      rolledBack: false,
      pendingRecoveryReason: "interrupted after displacement",
    });
    crash.mockRestore();
    expect(fs.existsSync(f.file)).toBe(false);
    expect(f.record).toEqual(sealed);
    const replay = await f.invoke();
    expect(replay).toMatchObject({
      rolledBack: false,
      pendingRecoveryReason: "canonical lease rebinding unavailable",
      result: { reason: "candidate-failed" },
    });
    expect(fs.existsSync(f.file)).toBe(true);
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(sealed);
    expect(f.rollback).not.toHaveBeenCalled();
  });

  it("never treats loss of the live context as same-run permission for legacy rollback", async () => {
    const f = await fixture();
    const before = fs.readFileSync(f.file);
    f.opts.recovery = undefined;
    expect(await f.invoke()).toMatchObject({
      rolledBack: false,
      result: { reason: "candidate-failed" },
      pendingRecoveryReason: expect.any(String),
    });
    expect(fs.readFileSync(f.file)).toEqual(before);
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });
  it("accepts an admitted relative spelling of the same bound state root", async () => {
    const f = await fixture();
    f.opts.run = {
      ...f.run,
      env: { ...f.run.env, OPENCLAW_STATE_DIR: path.relative(process.cwd(), f.root) },
    };
    const before = fs.readFileSync(f.file);
    expect(await f.invoke()).toMatchObject({
      rolledBack: false,
      pendingRecoveryReason: expect.stringContaining("lease rebinding"),
    });
    expect(fs.readFileSync(f.file)).toEqual(before);
  });
  it("refuses pending recovery after both executor and admitted run handles are lost", async () => {
    const f = await fixture();
    f.opts.recovery = undefined;
    f.opts.run = undefined;
    vi.stubEnv("OPENCLAW_STATE_DIR", f.root);
    const before = fs.readFileSync(f.file);
    expect(await f.invoke()).toMatchObject({
      rolledBack: false,
      result: { reason: "candidate-failed", recovery: { serviceRestartSafe: false } },
      pendingRecoveryReason: expect.any(String),
    });
    expect(fs.readFileSync(f.file)).toEqual(before);
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });
  it.each(["service", "admitted"] as const)(
    "checks pending recovery in the %s root when live service and admitted history roots differ",
    async (pendingRoot) => {
      const f = await fixture();
      f.opts.recovery = undefined;
      const cleanEnv = { OPENCLAW_STATE_DIR: dirs.make("rollback-other-root-") };
      f.opts.run = { ...f.run, env: pendingRoot === "admitted" ? f.run.env : cleanEnv };
      const before = fs.readFileSync(f.file);
      expect(
        await f.invoke({
          stopped: false,
          inspected: true,
          runtimeInspected: true,
          running: false,
          serviceEnv: pendingRoot === "service" ? f.run.env : cleanEnv,
        }),
      ).toMatchObject({
        rolledBack: false,
        result: { reason: "candidate-failed" },
        pendingRecoveryReason: expect.any(String),
      });
      expect(fs.readFileSync(f.file)).toEqual(before);
      expect(f.rollback).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    },
  );
  it("refuses missing publication capability even for preparing records", async () => {
    const f = await fixture(false);
    const before = fs.readFileSync(f.file);
    expect(await f.invoke()).toMatchObject({
      rolledBack: false,
      result: { status: "error", reason: "candidate-failed" },
      pendingRecoveryReason: expect.stringContaining("lease rebinding"),
    });
    expect(f.intervals()).toBe(0);
    expect(fs.readFileSync(f.file)).toEqual(before);
    expect(f.rollback).not.toHaveBeenCalled();
  });
});
