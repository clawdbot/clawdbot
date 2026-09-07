import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { inspectCheckpointFile } from "./update-checkpoint-files.js";
import { captureUpdateCheckpoint, reopenUpdateCheckpoint } from "./update-checkpoint.js";
import {
  recordUpdateRecoveryNativeIntent,
  recordUpdateRecoveryNativeNotApplied,
  cancelUpdateRecoveryRestart,
  recordUpdateRecoveryNativeObservation,
} from "./update-run-recovery-native.js";
import { setupNativeManagerFixture } from "./update-run-recovery-native.test-support.js";
import { UpdateRecoveryRecordSchema } from "./update-run-recovery-schema.js";
import {
  bindUpdateRecoveryCheckpoint,
  loadUpdateRecovery,
  recordUpdateRecoveryObservation,
  recordUpdateRecoveryFailure,
} from "./update-run-recovery.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

async function stopped(platform: "darwin" | "win32" | "linux" = "darwin", enabled = true) {
  const f = await setupNativeManagerFixture(
    fs.realpathSync(dirs.make("joint-restart-intent-")),
    platform,
    enabled,
  );
  let record = await f.bind();
  const target = { ...f.original, stopped: true, loaded: false };
  const id = randomUUID();
  record = (
    await recordUpdateRecoveryNativeIntent(
      record,
      { effectId: id, action: "stop", target, observe: f.observe },
      f.fence,
      f.options,
    )
  ).record;
  f.setFacts(target);
  record = (await recordUpdateRecoveryNativeObservation(record, id, f.observe, f.fence, f.options))
    .record;
  const file = path.join(f.root, "service.env");
  const access = { artifactRoot: f.artifactRoot, binding: f.binding };
  const ref = await captureUpdateCheckpoint({
    ...access,
    assertQuiescent: () => f.fence.assertCurrent(),
    resources: [{ sourcePath: file, kind: "service", restore: "replace" }],
    exclusions: [],
    preimages: {
      checkpointRef: record.preimages!.ref,
      postMutationSources: [{ sourcePath: file, state: await inspectCheckpointFile(file) }],
    },
  });
  const full = await reopenUpdateCheckpoint(ref, access);
  record = bindUpdateRecoveryCheckpoint(
    record,
    { ref: full.ref, binding: full.manifest.binding, preimageRef: full.manifest.preimageRef },
    f.fence,
    f.options,
  );
  return { ...f, record };
}

it("commits native restoration and restart intent together before dispatch, without creating readiness", async () => {
  const f = await stopped();
  const effectId = randomUUID();
  const input = {
    effectId,
    action: "restore" as const,
    target: f.original,
    observe: f.observe,
    restart: { runtime: "candidate" as const, resourceId: "gateway" },
  };
  const prepared = await recordUpdateRecoveryNativeIntent(f.record, input, f.fence, f.options);
  closeOpenClawStateDatabaseForTest();
  let record = loadUpdateRecovery(f.record.runId, f.options)!;
  expect(prepared.status).toBe("before");
  expect(record.revision).toBe(f.record.revision + 1);
  expect(record.nativeManager!.effects.at(-1)).toMatchObject({
    effectId,
    state: "intent",
    intentRevision: record.revision,
  });
  expect(record.effects).toEqual([
    {
      effectId,
      kind: "service-restart",
      resourceId: "gateway",
      runtime: "candidate",
      state: "intent",
      observedIdentity: null,
    },
  ]);
  expect(record.verification).toBeNull();
  // Neither journal's incomplete receipt is fresh boot/readiness authority.
  expect(() =>
    recordUpdateRecoveryObservation(
      record,
      { effectId, observedIdentity: "not-yet-a-boot" },
      f.fence,
      f.options,
    ),
  ).toThrow();
  expect(
    (await recordUpdateRecoveryNativeIntent(record, input, f.fence, f.options)).record,
  ).toEqual(record);
  f.setFacts(f.original);
  record = (
    await recordUpdateRecoveryNativeObservation(record, effectId, f.observe, f.fence, f.options)
  ).record;
  expect(record.effects.at(-1)?.state).toBe("intent");
  record = recordUpdateRecoveryObservation(
    record,
    { effectId, observedIdentity: "observed-boot" },
    f.fence,
    f.options,
  );
  expect(record.verification).toBeNull();
  expect(record.nativeManager!.original).toEqual(f.original);
  expect(record.effects.at(-1)).toMatchObject({
    state: "observed",
    observedIdentity: "observed-boot",
  });
});

it.each(["resource", "role", "effect", "action"])(
  "refuses a changed restart %s without advancing either journal",
  async (change) => {
    const f = await stopped();
    const input = {
      effectId: randomUUID(),
      action: "restore" as const,
      target: f.original,
      observe: f.observe,
      restart: { runtime: "candidate" as const, resourceId: "gateway" },
    };
    const prepared = await recordUpdateRecoveryNativeIntent(f.record, input, f.fence, f.options);
    const next = {
      ...input,
      ...(change === "effect" ? { effectId: randomUUID() } : {}),
      ...(change === "action" ? { action: "stop" as const } : {}),
      restart: {
        ...input.restart,
        ...(change === "resource" ? { resourceId: "other" } : {}),
        ...(change === "role" ? { runtime: "previous" as const } : {}),
      },
    };
    await expect(
      recordUpdateRecoveryNativeIntent(prepared.record, next, f.fence, f.options),
    ).rejects.toThrow();
    expect(loadUpdateRecovery(f.record.runId, f.options)).toEqual(prepared.record);
  },
);

it("rolls back both journal entries when the restart descriptor is invalid", async () => {
  const f = await stopped();
  await expect(
    recordUpdateRecoveryNativeIntent(
      f.record,
      {
        effectId: randomUUID(),
        action: "restore",
        target: f.original,
        observe: f.observe,
        restart: { runtime: "candidate", resourceId: "" },
      },
      f.fence,
      f.options,
    ),
  ).rejects.toThrow();
  expect(loadUpdateRecovery(f.record.runId, f.options)).toEqual(f.record);
});

it("rechecks the original live fence after observing a native restart target", async () => {
  const f = await stopped();
  let current = true;
  const fence = {
    assertCurrent() {
      if (!current) {
        throw new Error("original executor revoked");
      }
    },
  };
  await expect(
    recordUpdateRecoveryNativeIntent(
      f.record,
      {
        effectId: randomUUID(),
        action: "restore",
        target: f.original,
        observe: async () => {
          const observed = await f.observe();
          current = false;
          return observed;
        },
        restart: { runtime: "candidate", resourceId: "gateway" },
      },
      fence,
      f.options,
    ),
  ).rejects.toThrow("original executor revoked");
  expect(loadUpdateRecovery(f.record.runId, f.options)).toEqual(f.record);
});

it("reconciles the same dispatched restart after failure without changing its runtime role", async () => {
  const f = await stopped();
  const input = {
    effectId: randomUUID(),
    action: "restore" as const,
    target: f.original,
    observe: f.observe,
    restart: { runtime: "candidate" as const, resourceId: "gateway" },
  };
  const prepared = await recordUpdateRecoveryNativeIntent(f.record, input, f.fence, f.options);
  const failed = recordUpdateRecoveryFailure(
    prepared.record,
    { code: "start-ambiguous", effectId: input.effectId },
    f.fence,
    f.options,
  );
  f.setFacts(f.original);
  const retry = await recordUpdateRecoveryNativeIntent(failed, input, f.fence, f.options);
  expect(retry).toEqual({ record: failed, status: "after" });
  await expect(
    recordUpdateRecoveryNativeIntent(
      failed,
      { ...input, restart: { ...input.restart, runtime: "previous" } },
      f.fence,
      f.options,
    ),
  ).rejects.toThrow();
  expect(loadUpdateRecovery(failed.runId, f.options)).toEqual(failed);
});

it.each(["win32", "darwin", "linux"] as const)(
  "journals temporary start policy only for a captured disabled Windows or launchd job (%s)",
  async (platform) => {
    const f = await stopped(platform, false);
    const target = { ...f.record.nativeManager!.effects.at(-1)!.after, enabled: true };
    const enable = {
      effectId: randomUUID(),
      action: "enable-for-start" as const,
      target,
      observe: f.observe,
    };
    if (platform === "linux") {
      await expect(
        recordUpdateRecoveryNativeIntent(f.record, enable, f.fence, f.options),
      ).rejects.toThrow();
      expect(loadUpdateRecovery(f.record.runId, f.options)).toEqual(f.record);
      return;
    }
    let record = (await recordUpdateRecoveryNativeIntent(f.record, enable, f.fence, f.options))
      .record;
    f.setFacts(target);
    record = (
      await recordUpdateRecoveryNativeObservation(
        record,
        enable.effectId,
        f.observe,
        f.fence,
        f.options,
      )
    ).record;
    const start = {
      effectId: randomUUID(),
      action: "restore" as const,
      target: { ...f.original, enabled: true },
      observe: f.observe,
      restart: { runtime: "candidate" as const, resourceId: "gateway" },
    };
    record = (await recordUpdateRecoveryNativeIntent(record, start, f.fence, f.options)).record;
    const disable = {
      effectId: randomUUID(),
      action: "restore" as const,
      target: f.original,
      observe: f.observe,
    };
    await expect(
      recordUpdateRecoveryNativeIntent(record, disable, f.fence, f.options),
    ).rejects.toThrow();
    f.setFacts(start.target);
    record = (
      await recordUpdateRecoveryNativeObservation(
        record,
        start.effectId,
        f.observe,
        f.fence,
        f.options,
      )
    ).record;
    record = (await recordUpdateRecoveryNativeIntent(record, disable, f.fence, f.options)).record;
    expect(record.effects.at(-1)).toMatchObject({
      effectId: start.effectId,
      state: "intent",
      observedIdentity: null,
    });
    f.setFacts(f.original);
    record = (
      await recordUpdateRecoveryNativeObservation(
        record,
        disable.effectId,
        f.observe,
        f.fence,
        f.options,
      )
    ).record;
    record = recordUpdateRecoveryObservation(
      record,
      { effectId: start.effectId, observedIdentity: "independent-serving-boot" },
      f.fence,
      f.options,
    );
    expect(record.verification).toBeNull();
    expect(record.nativeManager!.effects.at(-1)!.after).toEqual(f.original);
    expect(record.terminal).toBeUndefined();
  },
);

it("journals failure quiescence while a dispatched candidate has no verified boot", async () => {
  const f = await stopped();
  const startId = randomUUID();
  let record = (
    await recordUpdateRecoveryNativeIntent(
      f.record,
      {
        effectId: startId,
        action: "restore",
        target: f.original,
        observe: f.observe,
        restart: { runtime: "candidate", resourceId: "gateway" },
      },
      f.fence,
      f.options,
    )
  ).record;
  f.setFacts(f.original);
  record = (
    await recordUpdateRecoveryNativeObservation(record, startId, f.observe, f.fence, f.options)
  ).record;
  record = recordUpdateRecoveryFailure(
    record,
    { code: "candidate-health-failed", effectId: startId },
    f.fence,
    f.options,
  );
  const target = { ...f.original, enabled: false };
  const suppressId = randomUUID();
  record = (
    await recordUpdateRecoveryNativeIntent(
      record,
      {
        effectId: suppressId,
        action: "suppress",
        target,
        observe: f.observe,
      },
      f.fence,
      f.options,
    )
  ).record;
  expect(record.effects.at(-1)).toMatchObject({
    effectId: startId,
    state: "intent",
    observedIdentity: null,
  });
  f.setFacts(target);
  record = (
    await recordUpdateRecoveryNativeObservation(record, suppressId, f.observe, f.fence, f.options)
  ).record;
  const stopId = randomUUID();
  const stoppedTarget = { ...target, stopped: true, loaded: false };
  record = (
    await recordUpdateRecoveryNativeIntent(
      record,
      { effectId: stopId, action: "stop", target: stoppedTarget, observe: f.observe },
      f.fence,
      f.options,
    )
  ).record;
  expect(record.verification).toBeNull();
  expect(record.terminal).toBeUndefined();
  expect(record.effects.at(-1)?.observedIdentity).toBeNull();
});

it.each(["not-applied", "stopped", "identity-change", "revoked"])(
  "cancels only a failed restart with fresh native quiescence (%s)",
  async (mode) => {
    const f = await stopped();
    const id = randomUUID();
    let record = (
      await recordUpdateRecoveryNativeIntent(
        f.record,
        {
          effectId: id,
          action: "restore",
          target: f.original,
          observe: f.observe,
          restart: { runtime: "candidate", resourceId: "gateway" },
        },
        f.fence,
        f.options,
      )
    ).record;
    await expect(
      cancelUpdateRecoveryRestart(record, f.observe, f.fence, f.options),
    ).rejects.toThrow();
    record = recordUpdateRecoveryFailure(
      record,
      { code: "failed-start", effectId: id },
      f.fence,
      f.options,
    );
    if (mode === "not-applied") {
      record = await recordUpdateRecoveryNativeNotApplied(
        record,
        id,
        f.observe,
        f.fence,
        f.options,
      );
      expect(record.nativeManager!.effects.at(-1)).toMatchObject({
        state: "not-applied",
        after: { stopped: false },
        before: { stopped: true },
      });
      expect(
        UpdateRecoveryRecordSchema.safeParse({ ...record, primaryFailure: null }).success,
      ).toBe(false);
      const impossible = structuredClone(record);
      impossible.nativeManager!.effects.at(-1)!.after = {
        ...impossible.nativeManager!.effects.at(-1)!.before,
      };
      expect(UpdateRecoveryRecordSchema.safeParse(impossible).success).toBe(false);
    } else {
      f.setFacts(f.original);
      record = (
        await recordUpdateRecoveryNativeObservation(record, id, f.observe, f.fence, f.options)
      ).record;
      await expect(
        cancelUpdateRecoveryRestart(record, f.observe, f.fence, f.options),
      ).rejects.toThrow();
      const stop = { ...f.original, stopped: true, loaded: false };
      const stopId = randomUUID();
      record = (
        await recordUpdateRecoveryNativeIntent(
          record,
          { effectId: stopId, action: "stop", target: stop, observe: f.observe },
          f.fence,
          f.options,
        )
      ).record;
      await expect(
        cancelUpdateRecoveryRestart(record, f.observe, f.fence, f.options),
      ).rejects.toThrow();
      f.setFacts(stop);
      record = (
        await recordUpdateRecoveryNativeObservation(record, stopId, f.observe, f.fence, f.options)
      ).record;
    }
    const expected = structuredClone(record);
    let live = true;
    const fence = {
      assertCurrent() {
        if (!live) {
          throw new Error("revoked");
        }
      },
    };
    const observe = async () => {
      const actual = await f.observe();
      if (mode === "revoked") {
        live = false;
      }
      return mode === "identity-change"
        ? { ...actual, identity: { ...actual.identity, runId: randomUUID() } }
        : actual;
    };
    if (mode === "identity-change" || mode === "revoked") {
      await expect(
        cancelUpdateRecoveryRestart(record, observe, fence, f.options),
      ).rejects.toThrow();
      expect(loadUpdateRecovery(record.runId, f.options)).toEqual(expected);
      return;
    }
    record = await cancelUpdateRecoveryRestart(record, observe, fence, f.options);
    expect(record.effects.at(-1)).toMatchObject({
      effectId: id,
      state: "cancelled",
      observedIdentity: null,
      cancelledByNativeEffectId: record.nativeManager!.effects.at(-1)!.effectId,
    });
    expect(record.primaryFailure).toEqual({ code: "failed-start", effectId: id });
    expect(record.verification).toBeNull();
    expect(record.terminal).toBeUndefined();
    expect(() =>
      recordUpdateRecoveryObservation(
        record,
        { effectId: id, observedIdentity: "invented-boot" },
        fence,
        f.options,
      ),
    ).toThrow();
  },
);
