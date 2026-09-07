import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { inspectCheckpointFile } from "./update-checkpoint-files.js";
import {
  reopenUpdateCheckpointRestorePlan,
  restoreUpdateCheckpointResource,
} from "./update-checkpoint-restore.js";
import { buildCheckpointReaderRuntime } from "./update-checkpoint-runtime.test-support.js";
import { captureUpdateCheckpoint, reopenUpdateCheckpoint } from "./update-checkpoint.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import { createUpdateRecoveryCheckpointAdapter } from "./update-run-recovery-checkpoint.js";
import {
  bindUpdateRecoveryNativeManager,
  inspectUpdateRecoveryNativeManager,
  recordUpdateRecoveryNativeIntent,
  recordUpdateRecoveryNativeObservation,
  type UpdateRecoveryNativeIdentity,
  type UpdateRecoveryNativeFacts,
} from "./update-run-recovery-native.js";
import { setupNativeManagerFixture } from "./update-run-recovery-native.test-support.js";
import {
  beginUpdateRecovery,
  prepareUpdateRecoveryHandoff,
  acceptUpdateRecoveryHandoff,
  recordUpdateRecoveryFailure,
  bindUpdateRecoveryCheckpoint,
  bindUpdateRecoveryAfterImage,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryObservation,
  recordUpdateRecoveryRestoreProgress,
  loadUpdateRecovery,
  claimUpdateRecovery,
  type UpdateRecoveryRecord,
} from "./update-run-recovery.js";

const dirs = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});
function fileHash(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function family(file: string) {
  return [file, `${file}-wal`, `${file}-shm`, `${file}-journal`].map((entry) =>
    fs.existsSync(entry) ? fileHash(entry) : null,
  );
}
async function fixture(withService = false) {
  const root = fs.realpathSync(dirs.make("recovery-checkpoint-adapter-"));
  await buildCheckpointReaderRuntime(root);
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root } };
  let held = true;
  const fence = {
    assertCurrent() {
      if (!held) {
        throw new Error("lost exclusion");
      }
    },
  };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const runtime = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
  let record = beginUpdateRecovery(
    { runId: run.runId, from: runtime, to: runtime },
    fence,
    options,
  );
  const configPath = path.join(root, "openclaw.json");
  const file = path.join(root, "state", "openclaw.sqlite");
  const servicePath = path.join(root, "service.env");
  const access = {
    artifactRoot: path.join(root, "artifacts"),
    binding: {
      runId: run.runId,
      stateDir: root,
      configPath,
      fromRuntime: { root, nodePath: process.execPath, version: runtime.version },
    },
    assertQuiescent: () => fence.assertCurrent(),
  };
  const capture = async (content: string) => {
    fs.writeFileSync(configPath, content);
    const output = { sourcePath: configPath, state: await inspectCheckpointFile(configPath) };
    if (withService) {
      fs.writeFileSync(servicePath, content);
    }
    closeOpenClawStateDatabaseForTest();
    const ref = await captureUpdateCheckpoint({
      ...access,
      exclusions: [],
      expectedSources: [
        output,
        ...(withService
          ? [{ sourcePath: servicePath, state: await inspectCheckpointFile(servicePath) }]
          : []),
      ],
      resources: [
        { sourcePath: configPath, kind: "config", restore: "replace" },
        { sourcePath: file, kind: "sqlite", restore: "replace" },
        ...(withService
          ? [{ sourcePath: servicePath, kind: "service" as const, restore: "replace" as const }]
          : []),
      ],
    });
    const reopened = await reopenUpdateCheckpoint(ref, access);
    return { ref, binding: reopened.manifest.binding };
  };
  const initial = await capture("original");
  record = bindUpdateRecoveryCheckpoint(record, initial, fence, options);
  const effectId = randomUUID();
  record = recordUpdateRecoveryIntent(
    record,
    { effectId, kind: "package-activation", resourceId: "owned-generation", runtime: "candidate" },
    fence,
    options,
  );
  record = recordUpdateRecoveryObservation(
    record,
    { effectId, observedIdentity: "candidate-generation" },
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
  const version = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => db.prepare("PRAGMA user_version").get(),
    { path: file },
  );
  let runtimeChecks = 0;
  let runtimeHook = () => {};
  const adapterParams = {
    artifactRoot: access.artifactRoot,
    database: options,
    fence,
    validateStagedDatabase(db: ReturnType<typeof openNodeSqliteDatabase>): undefined {
      expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
      return undefined;
    },
    assertMatchingRuntime(expected: UpdateRecoveryRecord["from"]): undefined {
      // Same-runtime fixture: assert the actual executing binary, not just schema.
      expect(expected).toEqual(runtime);
      expect(fs.realpathSync(expected.nodePath)).toBe(fs.realpathSync(process.execPath));
      runtimeChecks++;
      runtimeHook();
      return undefined;
    },
  };
  const adapter = createUpdateRecoveryCheckpointAdapter({ ...adapterParams, expected: record });
  const prepared = await adapter.prepare();
  if (prepared.status !== "ready") {
    throw new Error("fixture could not prepare");
  }
  await adapter.seal(prepared.planRef);
  const plan = await reopenUpdateCheckpointRestorePlan(prepared.planRef, access);
  const shared = plan.plan.resources[0];
  if (!shared) {
    throw new Error("missing shared resource");
  }
  const displacedPath = path.join(shared.stageDirectory, "displaced");
  const apply = (expected: UpdateRecoveryRecord, cursor = 0) =>
    restoreUpdateCheckpointResource({
      ...access,
      planRef: prepared.planRef,
      recoveryRecord: expected,
      resourceCursor: cursor,
    });
  return {
    root,
    options,
    file,
    configPath,
    adapter,
    adapterParams,
    prepared,
    apply,
    displacedPath,
    loseFence() {
      held = false;
    },
    runtimeChecks: () => runtimeChecks,
    setRuntimeHook(hook: () => void) {
      runtimeHook = hook;
    },
  };
}

describe("checkpoint to recovery claim/progress adapter", () => {
  it("reconciles publication before reclaim and advances only the canonical copy from owner observations", async () => {
    const f = await fixture();
    const sealed = f.adapter.record;
    const before = family(f.file);
    expect((await f.adapter.inspect()).status).toBe("incomplete");
    expect(family(f.file)).toEqual(before);
    expect(f.runtimeChecks()).toBe(0);
    await expect(f.adapter.claimPublished()).rejects.toThrow();
    expect(family(f.file)).toEqual(before);
    expect((await f.apply(sealed)).status).toBe("applied");
    const displaced = family(f.displacedPath);
    // A fresh executor reconstructs from canonical evidence, not staged authority.
    const reopened = createUpdateRecoveryCheckpointAdapter({
      ...f.adapterParams,
      expected: loadUpdateRecovery(sealed.runId, f.options)!,
    });
    const claimed = await reopened.claimPublished();
    expect(claimed.claimId).not.toBe(sealed.claimId);
    expect(claimed.afterImages).toEqual(sealed.afterImages);
    closeOpenClawStateDatabaseForTest();
    const observed = await reopened.observe();
    expect(observed.restore?.phase).toBe("observed");
    closeOpenClawStateDatabaseForTest();
    const next = await reopened.next();
    expect(next.restore).toMatchObject({ resourceCursor: 1, phase: "intent" });
    closeOpenClawStateDatabaseForTest();
    const beforeUnapplied = family(f.file);
    await expect(reopened.observe()).rejects.toThrow();
    expect(family(f.file)).toEqual(beforeUnapplied);
    expect((await f.apply(next, 1)).status).toBe("applied");
    expect(fs.readFileSync(f.configPath, "utf8")).toBe("original");
    expect((await reopened.observe()).restore).toMatchObject({
      resourceCursor: 1,
      phase: "observed",
    });
    closeOpenClawStateDatabaseForTest();
    expect((await reopened.inspect()).status).toBe("verified");
    expect(family(f.displacedPath)).toEqual(displaced);
    await expect(reopened.next()).rejects.toThrow();
  });

  it("refuses to skip an unrestored resource based on persisted observed progress", async () => {
    const f = await fixture(true);
    expect((await f.apply(f.adapter.record)).status).toBe("applied");
    await f.adapter.observe();
    closeOpenClawStateDatabaseForTest();
    const pending = await f.adapter.next();
    expect(pending.restore).toMatchObject({ resourceCursor: 1, phase: "intent" });
    // A prior executor's persisted observation is evidence, not proof that the
    // resource remains restored. Reconcile it through the checkpoint owner.
    const observed = recordUpdateRecoveryRestoreProgress(
      pending,
      { ...pending.restore!, phase: "observed" },
      f.adapterParams.fence,
      f.options,
    );
    closeOpenClawStateDatabaseForTest();
    const resumed = createUpdateRecoveryCheckpointAdapter({
      ...f.adapterParams,
      expected: loadUpdateRecovery(observed.runId, f.options)!,
    });
    const inspection = await resumed.inspect();
    expect(inspection.status).toBe("incomplete");
    expect(inspection.observations[1]?.observed).toBe("before");
    expect(inspection.observations).toHaveLength(3);
    const before = family(f.file);
    await expect(resumed.next()).rejects.toThrow();
    expect(family(f.file)).toEqual(before);
    expect(loadUpdateRecovery(observed.runId, f.options)).toEqual(observed);
    expect(fs.readFileSync(f.configPath, "utf8")).toBe("candidate");
    expect((await f.apply(observed, 1)).status).toBe("applied");
    expect((await resumed.next()).restore).toMatchObject({
      resourceCursor: 2,
      phase: "intent",
    });
  });

  it.each([
    "unpublished",
    "missing canonical",
    "displaced rewrite",
    "operator change",
    "stale claim",
    "lost exclusion",
    "wrong runtime",
  ])("refuses %s before a canonical claim write", async (failure) => {
    const f = await fixture();
    if (failure !== "unpublished" && failure !== "missing canonical") {
      await f.apply(f.adapter.record);
    }
    if (failure === "stale claim") {
      claimUpdateRecovery(f.adapter.record, f.adapterParams.fence, f.options);
      closeOpenClawStateDatabaseForTest();
    }
    if (failure === "displaced rewrite" || failure === "operator change") {
      const db = openNodeSqliteDatabase(failure === "displaced rewrite" ? f.displacedPath : f.file);
      if (failure === "displaced rewrite") {
        db.prepare(
          "UPDATE config_machine_state SET updated_at_ms = updated_at_ms + 1 WHERE state_key LIKE 'update.recovery.%'",
        ).run();
      } else {
        db.prepare("INSERT INTO config_machine_state VALUES('operator.changed','42',2)").run();
      }
      db.close();
    }
    if (failure === "lost exclusion") {
      f.loseFence();
    }
    if (failure === "wrong runtime") {
      f.setRuntimeHook(() => {
        throw new Error("wrong runtime");
      });
    }
    const before = family(f.file);
    await expect(f.adapter.claimPublished()).rejects.toThrow();
    expect(family(f.file)).toEqual(before);
  });

  it("rejects overlapping executor operations rather than reusing an earlier observation", async () => {
    const f = await fixture();
    await f.apply(f.adapter.record);
    const revision = f.adapter.record.revision;
    const first = f.adapter.claimPublished();
    await expect(f.adapter.claimPublished()).rejects.toThrow();
    expect((await first).revision).toBe(revision + 1);
  });

  it("rechecks exact active payload after runtime assertion before claim CAS", async () => {
    const f = await fixture();
    await f.apply(f.adapter.record);
    f.setRuntimeHook(() => {
      const db = openNodeSqliteDatabase(f.file);
      db.prepare(
        "UPDATE config_machine_state SET updated_at_ms = updated_at_ms + 1 WHERE state_key LIKE 'update.recovery.%'",
      ).run();
      db.close();
    });
    const revision = f.adapter.record.revision;
    await expect(f.adapter.claimPublished()).rejects.toThrow();
    expect(loadUpdateRecovery(f.adapter.record.runId, f.options)?.revision).toBe(revision);
    expect(fs.existsSync(`${f.file}-wal`)).toBe(false);
  });

  it("rejects an alternate immutable after-image and a noncanonical target", async () => {
    const f = await fixture();
    const changed = f.adapter.record;
    changed.afterImages![0]!.afterUpdate.ref.manifestSha256 = "f".repeat(64);
    const wrong = createUpdateRecoveryCheckpointAdapter({ ...f.adapterParams, expected: changed });
    const before = family(f.file);
    await expect(wrong.inspect()).rejects.toThrow();
    expect(() =>
      createUpdateRecoveryCheckpointAdapter({
        ...f.adapterParams,
        expected: f.adapter.record,
        database: { ...f.options, path: f.displacedPath },
      }),
    ).toThrow();
    expect(family(f.file)).toEqual(before);
  });
});

async function nativeFixture(platform: "darwin" | "win32" = "win32", enabled = true) {
  return setupNativeManagerFixture(
    fs.realpathSync(dirs.make("recovery-native-")),
    platform,
    enabled,
  );
}

describe("early native manager recovery", () => {
  it.each([
    { platform: "win32", enabled: true },
    { platform: "darwin", enabled: true },
    { platform: "win32", enabled: false },
    { platform: "darwin", enabled: false },
  ] as const)(
    "preserves original $platform enabled=$enabled state through ambiguous mutation, handoff, reclaim and exact replay",
    async ({ platform, enabled }) => {
      const f = await nativeFixture(platform, enabled);
      let record = await f.bind();
      const original = record.nativeManager!.original;
      const suppressed = { ...original, enabled: false };
      const effectId = randomUUID();
      record = (
        await recordUpdateRecoveryNativeIntent(
          record,
          { effectId, action: "suppress", target: suppressed, observe: f.observe },
          f.fence,
          f.options,
        )
      ).record;
      expect(record.checkpoint).toBeUndefined();
      expect(record.effects).toEqual([]);
      f.setFacts(suppressed); // Owner effect occurred; its acknowledgement was lost.
      const failure = { code: "native-result-lost", effectId };
      record = recordUpdateRecoveryFailure(record, failure, f.fence, f.options);
      const handed = prepareUpdateRecoveryHandoff(record, f.fence, f.options);
      closeOpenClawStateDatabaseForTest();
      const before = family(path.join(f.root, "state", "openclaw.sqlite"));
      expect(
        (await inspectUpdateRecoveryNativeManager(handed.record, f.observe, f.fence, f.options))
          .status,
      ).toBe("after");
      expect(family(path.join(f.root, "state", "openclaw.sqlite"))).toEqual(before);
      await expect(
        recordUpdateRecoveryNativeObservation(
          handed.record,
          effectId,
          f.observe,
          f.fence,
          f.options,
        ),
      ).rejects.toThrow();
      record = acceptUpdateRecoveryHandoff(handed.handoff, f.runtime, f.fence, f.options);
      record = claimUpdateRecovery(record, f.fence, f.options);
      const retry = await recordUpdateRecoveryNativeIntent(
        record,
        { effectId, action: "suppress", target: suppressed, observe: f.observe },
        f.fence,
        f.options,
      );
      expect(retry.status).toBe("after");
      expect(retry.record.revision).toBe(record.revision); // No duplicate intent or manager effect.
      record = (
        await recordUpdateRecoveryNativeObservation(record, effectId, f.observe, f.fence, f.options)
      ).record;
      const restoreId = randomUUID();
      record = (
        await recordUpdateRecoveryNativeIntent(
          record,
          { effectId: restoreId, action: "restore", target: original, observe: f.observe },
          f.fence,
          f.options,
        )
      ).record;
      f.setFacts(original);
      record = (
        await recordUpdateRecoveryNativeObservation(
          record,
          restoreId,
          f.observe,
          f.fence,
          f.options,
        )
      ).record;
      expect(record.nativeManager!.original).toEqual(original);
      expect(record.primaryFailure).toEqual(failure);
      expect(record.effects).toEqual([]);
      expect(JSON.stringify(getUpdateRun(record.runId, f.options))).not.toContain(
        "native-result-lost",
      );
      closeOpenClawStateDatabaseForTest();
      expect(loadUpdateRecovery(record.runId, f.options)?.nativeManager).toEqual(
        record.nativeManager,
      );
    },
  );

  it.each([
    "run",
    "config",
    "state",
    "profile",
    "task",
    "platform",
    "task-space",
    "path-space",
  ] as const)("rejects wrong %s observation without changing the binding", async (field) => {
    const f = await nativeFixture();
    const record = await f.bind();
    const wrong = { ...f.identity };
    if (field === "run") {
      wrong.runId = randomUUID();
    }
    if (field === "path-space") {
      wrong.configPath += " ";
    }
    if (field === "task-space" && wrong.platform === "win32") {
      wrong.taskName += " ";
    }
    if (field === "config") {
      wrong.configPath += ".wrong";
    }
    if (field === "state") {
      wrong.stateDir += "-wrong";
    }
    if (field === "profile") {
      wrong.profile = "different";
    }
    if (field === "task" && wrong.platform === "win32") {
      wrong.taskName += "-wrong";
    }
    const identity: UpdateRecoveryNativeIdentity =
      field === "platform"
        ? { ...wrong, platform: "darwin", domain: "gui/502", label: "ai.openclaw" }
        : wrong;
    await expect(
      bindUpdateRecoveryNativeManager(
        record,
        { identity: f.identity, observe: async () => ({ identity, facts: f.original }) },
        f.fence,
        f.options,
      ),
    ).rejects.toThrow();
    expect(loadUpdateRecovery(record.runId, f.options)).toEqual(record);
  });

  it("refuses changed retry originals, skips, unknown intermediate outcomes, and forward work with pending intent", async () => {
    const f = await nativeFixture();
    let record = await f.bind();
    const disabled = { ...f.original, enabled: false };
    const id = randomUUID();
    record = (
      await recordUpdateRecoveryNativeIntent(
        record,
        { effectId: id, action: "suppress", target: disabled, observe: f.observe },
        f.fence,
        f.options,
      )
    ).record;
    expect(() =>
      recordUpdateRecoveryIntent(
        record,
        {
          effectId: randomUUID(),
          kind: "service-restart",
          resourceId: "gateway",
          runtime: "candidate",
        },
        f.fence,
        f.options,
      ),
    ).toThrow();
    expect(() =>
      bindUpdateRecoveryCheckpoint(
        record,
        {
          ref: {
            checkpointId: randomUUID(),
            manifestPath: path.join(f.root, "full"),
            manifestSha256: "a".repeat(64),
          },
          binding: f.binding,
          preimageRef: record.preimages!.ref,
        },
        f.fence,
        f.options,
      ),
    ).toThrow();
    await expect(
      recordUpdateRecoveryNativeIntent(
        record,
        { effectId: randomUUID(), action: "suppress", target: disabled, observe: f.observe },
        f.fence,
        f.options,
      ),
    ).rejects.toThrow();
    f.setFacts({ ...disabled, loaded: false, stopped: true });
    const conflict = await recordUpdateRecoveryNativeObservation(
      record,
      id,
      f.observe,
      f.fence,
      f.options,
    );
    expect(conflict.status).toBe("conflict");
    expect(conflict.record).toEqual(record);
    f.setFacts(disabled);
    await expect(
      bindUpdateRecoveryNativeManager(
        record,
        { identity: f.identity, observe: f.observe },
        f.fence,
        f.options,
      ),
    ).rejects.toThrow();
    expect(loadUpdateRecovery(record.runId, f.options)).toEqual(record);
  });

  it("rechecks exact claim and exclusion after daemon observation and rolls back final fence loss", async () => {
    const f = await nativeFixture();
    const record = await f.bind();
    let current = record;
    await expect(
      recordUpdateRecoveryNativeIntent(
        record,
        {
          effectId: randomUUID(),
          action: "stop",
          target: { ...f.original, stopped: true },
          observe: async () => {
            current = claimUpdateRecovery(record, f.fence, f.options);
            return f.observe();
          },
        },
        f.fence,
        f.options,
      ),
    ).rejects.toThrow();
    let checks = 0;
    // read/observe/read = four checks; write preflight/transaction entry/final = three.
    const lost = {
      assertCurrent() {
        if (++checks === 7) {
          throw new Error("lost fence");
        }
      },
    };
    await expect(
      recordUpdateRecoveryNativeIntent(
        current,
        {
          effectId: randomUUID(),
          action: "stop",
          target: { ...f.original, stopped: true },
          observe: f.observe,
        },
        lost,
        f.options,
      ),
    ).rejects.toThrow("lost fence");
    expect(loadUpdateRecovery(current.runId, f.options)).toEqual(current);
    const asyncFence = { assertCurrent: async () => {} };
    await expect(
      inspectUpdateRecoveryNativeManager(current, f.observe, asyncFence, f.options),
    ).rejects.toThrow("synchronously");
  });

  it.each(["disable-and-stop", "load-while-stopping"] as const)(
    "rejects %s as one native stop",
    async (kind) => {
      const f = await nativeFixture("darwin");
      if (kind === "load-while-stopping") {
        f.setFacts({ ...f.original, loaded: false, stopped: true });
      }
      const record = await f.bind();
      const target = { ...f.original, enabled: kind !== "disable-and-stop", stopped: true };
      await expect(
        recordUpdateRecoveryNativeIntent(
          record,
          { effectId: randomUUID(), action: "stop", target, observe: f.observe },
          f.fence,
          f.options,
        ),
      ).rejects.toThrow();
      expect(loadUpdateRecovery(record.runId, f.options)).toEqual(record);
    },
  );

  it("restores auto-start while stopped without blessing a restart", async () => {
    const f = await nativeFixture();
    let record = await f.bind();
    async function transition(
      action: "suppress" | "stop" | "restore",
      target: UpdateRecoveryNativeFacts,
    ) {
      const effectId = randomUUID();
      record = (
        await recordUpdateRecoveryNativeIntent(
          record,
          { effectId, action, target, observe: f.observe },
          f.fence,
          f.options,
        )
      ).record;
      f.setFacts(target);
      record = (
        await recordUpdateRecoveryNativeObservation(record, effectId, f.observe, f.fence, f.options)
      ).record;
    }
    await transition("suppress", { ...f.original, enabled: false });
    await transition("stop", { ...f.original, enabled: false, stopped: true });
    await transition("restore", { ...f.original, stopped: true });
    expect(record.nativeManager!.effects.at(-1)?.after.stopped).toBe(true);
    expect(record.nativeManager!.original.stopped).toBe(false);
    expect(record.verification).toBeNull();
    expect(record.effects).toEqual([]);
  });

  it("records stop separately and restores only the original state, never treating early facts as full checkpoint", async () => {
    const f = await nativeFixture("darwin");
    let record = await f.bind();
    expect(() =>
      recordUpdateRecoveryIntent(
        record,
        {
          effectId: randomUUID(),
          kind: "package-activation",
          resourceId: "package",
          runtime: "candidate",
        },
        f.fence,
        f.options,
      ),
    ).toThrow("checkpoint");
    const stopped = { ...f.original, loaded: false, stopped: true };
    const id = randomUUID();
    record = (
      await recordUpdateRecoveryNativeIntent(
        record,
        { effectId: id, action: "stop", target: stopped, observe: f.observe },
        f.fence,
        f.options,
      )
    ).record;
    f.setFacts(stopped);
    record = (
      await recordUpdateRecoveryNativeObservation(record, id, f.observe, f.fence, f.options)
    ).record;
    await expect(
      recordUpdateRecoveryNativeIntent(
        record,
        {
          effectId: randomUUID(),
          action: "restore",
          target: { ...f.original, enabled: false },
          observe: f.observe,
        },
        f.fence,
        f.options,
      ),
    ).rejects.toThrow();
    record = bindUpdateRecoveryCheckpoint(
      record,
      {
        ref: {
          checkpointId: randomUUID(),
          manifestPath: path.join(f.root, "full"),
          manifestSha256: "a".repeat(64),
        },
        binding: f.binding,
        preimageRef: record.preimages!.ref,
      },
      f.fence,
      f.options,
    );
    await expect(
      recordUpdateRecoveryNativeIntent(
        record,
        { effectId: randomUUID(), action: "stop", target: stopped, observe: f.observe },
        f.fence,
        f.options,
      ),
    ).rejects.toThrow();
    expect(record.nativeManager!.original).toEqual(f.original);
    expect(record.effects).toEqual([]);
    const restoreId = randomUUID();
    record = (
      await recordUpdateRecoveryNativeIntent(
        record,
        { effectId: restoreId, action: "restore", target: f.original, observe: f.observe },
        f.fence,
        f.options,
      )
    ).record;
    f.setFacts(f.original);
    record = (
      await recordUpdateRecoveryNativeObservation(record, restoreId, f.observe, f.fence, f.options)
    ).record;
    for (const kind of ["package-activation", "checkpoint-restore", "package-restore"] as const) {
      expect(() =>
        recordUpdateRecoveryIntent(
          record,
          { effectId: randomUUID(), kind, resourceId: "package", runtime: "candidate" },
          f.fence,
          f.options,
        ),
      ).toThrow();
      expect(loadUpdateRecovery(record.runId, f.options)).toEqual(record);
    }
  });
});
