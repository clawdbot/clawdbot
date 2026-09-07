import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";
import {
  createPackageRecoveryTransaction,
  reopenPackageUpdateTransaction,
  type PackageRecoveryVerified,
  type PackageTransactionDescriptor,
} from "./package-update-recovery.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunVerification } from "./update-run-ledger.js";
import {
  defineLegacyRecoveryInspectionTests,
  legacyRecord,
} from "./update-run-recovery-legacy.test-support.js";
import { createUpdateRecoveryPackageHooks } from "./update-run-recovery-package.js";
import {
  encodeUpdateRecovery,
  decodeUpdateRecovery,
  inspectUpdateRecovery,
} from "./update-run-recovery-schema.js";
import { commitUpdateRecoveryTerminal } from "./update-run-recovery-terminal.js";
import {
  beginUpdateRecovery,
  bindUpdateRecoveryCheckpoint,
  bindUpdateRecoveryAfterImage,
  loadUpdateRecovery,
  loadUpdateRecoveries,
  assertNoPendingUpdateRecovery,
  claimUpdateRecovery,
  prepareUpdateRecoveryHandoff,
  acceptUpdateRecoveryHandoff,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryObservation,
  recordUpdateRecoveryVerification,
  recordUpdateRecoveryFailure,
  type UpdateRecoveryRecord,
} from "./update-run-recovery.js";

const dirs = createTempDirTracker();
const fence = { assertCurrent() {} };

async function generation(root: string, version: string) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
}
async function fixture(existingRoot?: string, version = "2.0.0", previousAbsent = false) {
  const root = existingRoot ?? dirs.make("openclaw-recovery-package-");
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root } };
  const global = path.join(root, "node_modules");
  const liveRoot = path.join(global, "openclaw");
  const binDir = path.join(root, "bin");
  const launcher = path.join(binDir, "openclaw");
  if (!existingRoot) {
    if (previousAbsent) {
      await fs.mkdir(global, { recursive: true });
    } else {
      await generation(liveRoot, "1.0.0");
    }
    await fs.mkdir(binDir);
    await fs.writeFile(launcher, "previous launcher");
  }
  const stageRoot = path.join(root, "stage-" + randomUUID());
  await generation(stageRoot, version);
  const reader = createPackageIntegrityReader();
  const previous = previousAbsent ? null : await reader.tree(liveRoot);
  const candidate = await reader.tree(stageRoot, liveRoot);
  const from = {
    root: liveRoot,
    nodePath: process.execPath,
    version: previous?.version ?? "1.0.0",
    buildId: null,
  };
  const to = { ...from, version };
  const run = createUpdateRun({ trigger: "cli" }, options);
  let record = beginUpdateRecovery({ runId: run.runId, from, to }, fence, options);
  const descriptor: PackageTransactionDescriptor = {
    version: 1,
    transactionId: record.transactionId,
    packageName: "openclaw",
    liveRoot,
    stageRoot,
    backupRoot: path.join(global, ".openclaw.package-backup-" + randomUUID()),
    binDir,
    shimBackupRoot: path.join(global, ".openclaw.shim-backup-" + randomUUID()),
    shimBackupIdentity: null,
    previous,
    candidate,
    launchers: [],
    interruptedLaunchers: [],
    retention: null,
  };
  if (!descriptor.shimBackupRoot) {
    throw new Error("Missing fixture shim path");
  }
  await fs.mkdir(descriptor.shimBackupRoot);
  await fs.copyFile(launcher, path.join(descriptor.shimBackupRoot, "openclaw"));
  const stagedLauncher = path.join(root, "launcher-" + randomUUID());
  await fs.writeFile(stagedLauncher, "candidate launcher " + version);
  descriptor.shimBackupIdentity = await reader.directoryIdentity(descriptor.shimBackupRoot);
  descriptor.launchers = [
    {
      name: "openclaw",
      previous: await reader.launcher(launcher),
      candidate: await reader.launcher(stagedLauncher),
    },
  ];
  const hooks = createUpdateRecoveryPackageHooks({
    getRecord: () => record,
    onRecord: (next) => {
      record = next;
    },
    fence,
    options,
  });
  const owner = createPackageRecoveryTransaction(descriptor, hooks);
  const checkpoint = {
    ref: {
      checkpointId: randomUUID(),
      manifestPath: path.join(root, randomUUID(), "manifest.json"),
      manifestSha256: "a".repeat(64),
    },
    binding: {
      runId: run.runId,
      stateDir: root,
      configPath: path.join(root, "openclaw.json"),
      fromRuntime: { root: from.root, nodePath: from.nodePath, version: from.version },
    },
  };
  // The persistence seam receives facts from checkpoint's owner. These tests
  // exercise package files/history atomicity, not checkpoint artifact validation.
  async function activate() {
    await owner.prepare();
    record = bindUpdateRecoveryCheckpoint(record, checkpoint, fence, options);
    const receipt = await owner.beforeActivation();
    if (previous) {
      await fs.rename(liveRoot, descriptor.backupRoot);
    }
    await fs.rename(stageRoot, liveRoot);
    await fs.copyFile(stagedLauncher, launcher);
    const observed = await owner.afterActivation(receipt);
    record = bindUpdateRecoveryAfterImage(
      record,
      {
        checkpointRef: checkpoint.ref,
        afterUpdate: {
          ref: {
            checkpointId: randomUUID(),
            manifestPath: path.join(root, randomUUID(), "manifest.json"),
            manifestSha256: "b".repeat(64),
          },
          binding: checkpoint.binding,
        },
        effectIds: record.effects.map((effect) => effect.effectId),
      },
      fence,
      options,
    );
    return observed;
  }
  function verified(runtime: "candidate" | "previous" = "candidate") {
    const id = randomUUID(),
      boot = randomUUID();
    record = recordUpdateRecoveryIntent(
      record,
      { effectId: id, kind: "service-restart", resourceId: "gateway", runtime },
      fence,
      options,
    );
    record = recordUpdateRecoveryObservation(
      record,
      { effectId: id, observedIdentity: boot },
      fence,
      options,
    );
    record = recordUpdateRecoveryVerification(
      record,
      {
        runtime,
        receipt: {
          runId: run.runId,
          gateway: {
            bootId: boot,
            version: runtime === "candidate" ? version : from.version,
            buildId: null,
          },
          kind: "readiness",
          transactionId: record.transactionId,
          claimId: record.claimId,
          revision: record.revision,
          effectId: id,
          runtime,
          checks: {
            serviceRunning: true,
            pluginsReady: true,
            channelsReady: true,
            settled: true,
            readyz: true,
          },
          verifiedAtMs: Date.now(),
        },
      },
      fence,
      options,
    );
  }
  function reload() {
    closeOpenClawStateDatabaseForTest();
    const loaded = loadUpdateRecovery(run.runId, options);
    if (!loaded) {
      throw new Error("Missing persisted recovery");
    }
    record = loaded;
    return loaded;
  }
  return {
    root,
    options,
    descriptor,
    checkpoint,
    owner,
    hooks,
    run,
    activate,
    verified,
    reload,
    get record() {
      return record;
    },
    set record(next: UpdateRecoveryRecord) {
      record = next;
    },
  };
}
function commit(f: Awaited<ReturnType<typeof fixture>>, observed: PackageRecoveryVerified) {
  f.record = commitUpdateRecoveryTerminal(
    f.record,
    { status: "succeeded", package: observed, assertReady() {} },
    fence,
    f.options,
  );
  return f.record;
}

export type RecoveryPackageTestFactory = typeof fixture;
export type RecoveryPackageTestCommit = typeof commit;

export function defineUpdateRecoveryPackageTests() {
  describe("package recovery", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      closeOpenClawStateDatabaseForTest();
      dirs.cleanup();
    });
    describe("typed package recovery and atomic retained-pair selection", () => {
      it("rejects a terminal record before native running state is restored", async () => {
        const f = await fixture();
        const observed = await f.activate();
        f.verified();
        const record = structuredClone(commit(f, observed));
        const preimageRef = {
          checkpointId: randomUUID(),
          manifestPath: path.join(f.root, "early-manifest.json"),
          manifestSha256: "c".repeat(64),
        };
        record.preimages = { ref: preimageRef, binding: f.checkpoint.binding, boundAtRevision: 0 };
        record.checkpoint!.preimageRef = preimageRef;
        const original = { exists: true, enabled: true, loaded: true, stopped: false };
        record.nativeManager = {
          identity: {
            platform: "win32",
            runId: record.runId,
            stateDir: record.source!.stateDir,
            configPath: record.source!.configPath,
            profile: record.source!.profile ?? null,
            taskName: "OpenClaw-test",
          },
          original,
          boundAtRevision: 0,
          effects: [
            {
              effectId: randomUUID(),
              action: "stop",
              before: original,
              after: { ...original, stopped: true },
              state: "observed",
              intentRevision: 1,
              observedRevision: 2,
            },
          ],
        };
        // Durable decoding is an admission/terminal boundary, not a substitute for daemon proof.
        expect(() => decodeUpdateRecovery(JSON.stringify(record), record.runId)).toThrow();
        record.nativeManager.effects[0]!.action = "restore";
        record.nativeManager.effects[0]!.after = original;
        expect(decodeUpdateRecovery(encodeUpdateRecovery(record), record.runId)).toEqual(record);
      });

      it("persists exact typed effects across handoff/reclaim without disclosing them in history", async () => {
        const f = await fixture();
        await f.activate();
        const before = f.reload();
        const transfer = prepareUpdateRecoveryHandoff(before, fence, f.options);
        f.record = acceptUpdateRecoveryHandoff(transfer.handoff, before.to, fence, f.options);
        f.record = claimUpdateRecovery(f.record, fence, f.options);
        const reopened = f.reload();
        expect(reopened.package).toEqual(before.package);
        expect(reopened.effects).toEqual(before.effects);
        expect(JSON.stringify(getUpdateRun(f.run.runId, f.options))).not.toContain(
          f.descriptor.backupRoot,
        );
      });

      it("refuses activation intent before checkpoint binding without a filesystem effect", async () => {
        const f = await fixture();
        await f.owner.prepare();
        await expect(f.owner.beforeActivation()).rejects.toThrow();
        expect(f.reload().effects).toEqual([]);
        await expect(
          fs.readFile(path.join(f.descriptor.liveRoot, "package.json"), "utf8"),
        ).resolves.toContain("1.0.0");
      });

      it("reconciles the same intent after a committed observation loses its acknowledgement", async () => {
        const f = await fixture();
        await f.owner.prepare();
        f.record = bindUpdateRecoveryCheckpoint(f.record, f.checkpoint, fence, f.options);
        const effect = {
          effectId: randomUUID(),
          action: "activate" as const,
          descriptor: f.descriptor,
        };
        const observed = await f.owner.observe();
        if (observed.status !== "verified") {
          throw new Error(observed.reason);
        }
        const receipt = await f.hooks.beforeEffect(effect, { mode: "new", observed });
        await receipt.afterEffect(observed, "interrupted");
        const saved = f.reload();
        const resumed = await f.hooks.beforeEffect(effect, { mode: "resume", observed });
        await resumed.afterEffect(observed, "interrupted");
        expect(f.reload()).toEqual(saved);
        await expect(
          f.hooks.beforeEffect({ ...effect, effectId: randomUUID() }, { mode: "new", observed }),
        ).resolves.toBeDefined();
      });

      it("rejects a stale receipt after claim rotation and retains the pending package intent", async () => {
        const f = await fixture();
        await f.owner.prepare();
        f.record = bindUpdateRecoveryCheckpoint(f.record, f.checkpoint, fence, f.options);
        const observed = await f.owner.observe();
        if (observed.status !== "verified") {
          throw new Error(observed.reason);
        }
        const receipt = await f.hooks.beforeEffect(
          { effectId: randomUUID(), action: "activate", descriptor: f.descriptor },
          { mode: "new", observed },
        );
        f.record = claimUpdateRecovery(f.record, fence, f.options);
        await expect(receipt.afterEffect(observed, "interrupted")).rejects.toThrow();
        expect(f.reload().effects.at(-1)?.state).toBe("intent");
      });

      it("atomically records verified history and selection, rejecting receipt-only completion", async () => {
        const f = await fixture();
        const observed = await f.activate();
        expect(() => commit(f, observed)).toThrow();
        f.verified();
        const beforeHistory = recordUpdateRunVerification(
          f.run.runId,
          {
            readyz: false,
            channelsReady: false,
            pluginErrors: ["candidate plugin failed before recovery"],
            noticeDelivered: false,
          },
          f.options,
        );
        let checks = 0;
        expect(() =>
          commitUpdateRecoveryTerminal(
            f.record,
            {
              status: "succeeded",
              package: observed,
              assertReady() {
                if (++checks === 2) {
                  throw new Error("authority lost at commit");
                }
              },
            },
            fence,
            f.options,
          ),
        ).toThrow("authority lost");
        expect(f.reload().terminal).toBeUndefined();
        expect(getUpdateRun(f.run.runId, f.options)).toEqual(beforeHistory);
        const terminal = commit(f, observed);
        const { completeUpdateCommandRun } =
          await import("../cli/update-cli/update-command-run.js");
        expect(
          completeUpdateCommandRun(
            { status: "error", reason: "diagnostic-only", mode: "npm", durationMs: 1, steps: [] },
            { runId: f.run.runId, env: f.options.env },
          ),
        ).toMatchObject({ status: "ok", runId: f.run.runId });
        expect(f.reload()).toEqual(terminal);
        expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("succeeded");
        expect(getUpdateRun(f.run.runId, f.options)?.verification).toMatchObject({
          readyz: true,
          channelsReady: true,
          pluginErrors: [],
          noticeDelivered: false,
        });
        expect(getUpdateRun(f.run.runId, f.options)?.verification).not.toHaveProperty(
          "inferenceProbe",
        );
        expect(terminal.package?.descriptor.retention?.state).toBe("selected");
        expect(() => assertNoPendingUpdateRecovery(f.options)).not.toThrow();
        const retention = terminal.package?.descriptor.retention;
        if (retention?.state !== "selected") {
          throw new Error("Missing selected decision");
        }
        expect(await f.owner.retain(retention)).toMatchObject({ status: "verified" });
        expect(
          await f.owner.retire({ state: "unselected", ownerRevision: terminal.revision }),
        ).toMatchObject({ status: "conflict" });
      });

      it("retains terminal readiness as history after reclaim without accepting legacy receipts", async () => {
        const f = await fixture();
        const observed = await f.activate();
        f.verified();
        const terminal = commit(f, observed);
        const receipt = terminal.terminal!.receipt;
        const historical = structuredClone(terminal);
        const legacy = legacyRecord(historical);
        expect(inspectUpdateRecovery(JSON.stringify(legacy), f.run.runId)).toEqual({
          format: "legacy-serving",
          raw: JSON.stringify(legacy),
          record: legacy,
        });
        expect(() => decodeUpdateRecovery(JSON.stringify(legacy), f.run.runId)).toThrow(
          /legacy.*readiness/i,
        );
        for (const mismatch of ["effect", "runtime"] as const) {
          const contradictory = structuredClone(legacy);
          const finalRestart = contradictory.effects.at(-1)!;
          const earlier = { ...finalRestart, effectId: randomUUID() };
          if (mismatch === "runtime") {
            earlier.runtime = "previous";
            contradictory.from.version = contradictory.to.version;
            contradictory.from.buildId = contradictory.to.buildId;
          }
          contradictory.effects.splice(-1, 0, earlier);
          contradictory.verification!.effectId = earlier.effectId;
          contradictory.verification!.runtime = earlier.runtime;
          expect(() => inspectUpdateRecovery(JSON.stringify(contradictory), f.run.runId)).toThrow();
        }
        expect(f.reload()).toEqual(terminal);
        f.record = claimUpdateRecovery(terminal, fence, f.options);
        expect(f.reload().verification).toBeNull();
        expect(f.record.terminal).toEqual(terminal.terminal);
        expect(f.record.retainedPair).toEqual(terminal.retainedPair);
        expect(f.record.claimId).not.toBe(receipt.claimId);
        const reclaimedLegacy = legacyRecord(f.record);
        const inspected = inspectUpdateRecovery(JSON.stringify(reclaimedLegacy), f.run.runId);
        expect(inspected.record.verification).toBeNull();
        expect(inspected.record.terminal?.receipt).toEqual(reclaimedLegacy.terminal?.receipt);
        expect(inspected.record.retainedPair).toEqual(terminal.retainedPair);
        for (const field of ["version", "buildId", "bootId"] as const) {
          const corrupted = structuredClone(reclaimedLegacy);
          corrupted.terminal!.receipt.gateway[field] = "foreign-runtime";
          expect(() => inspectUpdateRecovery(JSON.stringify(corrupted), f.run.runId)).toThrow();
        }

        const wrongRun = structuredClone(f.record);
        wrongRun.terminal!.receipt.runId = randomUUID();
        expect(() => decodeUpdateRecovery(JSON.stringify(wrongRun), f.run.runId)).toThrow();
        expect(() => assertNoPendingUpdateRecovery(f.options)).not.toThrow();
      });

      defineLegacyRecoveryInspectionTests(fixture, commit);

      it("selects the next pair before retirement and preserves it through interrupted cleanup", async () => {
        const a = await fixture();
        const observedA = await a.activate();
        a.verified();
        commit(a, observedA);
        const decisionA = a.record.package?.descriptor.retention;
        if (decisionA?.state !== "selected") {
          throw new Error("Missing selection");
        }
        expect(await a.owner.retain(decisionA)).toMatchObject({ status: "verified" });
        const b = await fixture(a.root, "3.0.0");
        const observedB = await b.activate();
        b.verified();
        let checks = 0;
        expect(() =>
          commitUpdateRecoveryTerminal(
            b.record,
            {
              status: "succeeded",
              package: observedB,
              assertReady() {
                if (++checks === 2) {
                  throw new Error("lost readiness");
                }
              },
            },
            fence,
            b.options,
          ),
        ).toThrow("lost readiness");
        expect(a.reload().retainedPair?.state).toBe("selected");
        expect(b.reload().terminal).toBeUndefined();
        commit(b, observedB);
        const selected = b.reload();
        const old = a.reload();
        expect(old.retainedPair).toMatchObject({
          state: "superseded",
          replacementRunId: b.run.runId,
        });
        const retention = old.package?.descriptor.retention;
        if (!old.package || retention?.state !== "superseded") {
          throw new Error("Missing retirement decision");
        }
        const reopened = await reopenPackageUpdateTransaction({
          descriptor: old.package.descriptor,
          expectedLiveRoot: old.from.root,
          expectedBinDir: old.package.descriptor.binDir,
          expectedTransactionId: old.transactionId,
          hooks: a.hooks,
        });
        if (reopened.status !== "ready") {
          throw new Error(reopened.reason);
        }
        const remove = fs.rm.bind(fs);
        const interruption = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
          if (target === old.package?.descriptor.shimBackupRoot) {
            throw new Error("retirement interrupted");
          }
          return remove(target, options);
        });
        try {
          expect(await reopened.transaction.retire(retention)).toMatchObject({
            status: "unavailable",
            pendingEffect: { action: "retire" },
          });
        } finally {
          interruption.mockRestore();
        }
        expect(b.reload()).toEqual(selected);
        const interrupted = a.reload();
        expect(interrupted.effects.at(-1)?.state).toBe("intent");
        const retry = await reopenPackageUpdateTransaction({
          descriptor: interrupted.package?.descriptor,
          pendingEffect: interrupted.effects.at(-1)?.package?.intent,
          expectedLiveRoot: old.from.root,
          expectedBinDir: old.package.descriptor.binDir,
          expectedTransactionId: old.transactionId,
          hooks: a.hooks,
        });
        if (retry.status !== "ready") {
          throw new Error(retry.reason);
        }
        expect(await retry.transaction.retire(retention)).toMatchObject({ status: "verified" });
        expect(b.reload()).toEqual(selected);
        await expect(
          fs.readFile(path.join(selected.package!.descriptor.backupRoot, "package.json"), "utf8"),
        ).resolves.toContain("2.0.0");
        expect(
          loadUpdateRecoveries(b.options)
            .filter((record) => record.retainedPair?.state === "selected")
            .map((record) => record.runId),
        ).toEqual([b.run.runId]);
      });

      it.each([false, true])(
        "commits verified rollback with exact prior roles/history (previousAbsent=%s)",
        async (previousAbsent) => {
          const a = previousAbsent ? undefined : await fixture();
          if (a) {
            const initial = await a.activate();
            a.verified();
            commit(a, initial);
          }
          const b = await fixture(a?.root, "3.0.0", previousAbsent);
          await b.activate();
          b.record = recordUpdateRecoveryFailure(
            b.record,
            { code: "candidate-failed", effectId: null },
            fence,
            b.options,
          );
          expect(await b.owner.rollback()).toMatchObject({ status: "verified" });
          const restoreId = randomUUID();
          b.record = recordUpdateRecoveryIntent(
            b.record,
            {
              effectId: restoreId,
              kind: "checkpoint-restore",
              resourceId: b.checkpoint.ref.checkpointId,
              runtime: "previous",
            },
            fence,
            b.options,
          );
          b.record = recordUpdateRecoveryObservation(
            b.record,
            { effectId: restoreId, observedIdentity: "fixture-checkpoint-owner-restored" },
            fence,
            b.options,
          );
          b.verified("previous");
          recordUpdateRunVerification(
            b.run.runId,
            {
              runningBuildId: "stale-candidate-build",
              readyz: false,
              channelsReady: false,
              pluginErrors: ["candidate plugin failed before rollback"],
              noticeDelivered: false,
            },
            b.options,
          );
          const restored = await b.owner.observe();
          if (restored.status !== "verified") {
            throw new Error(restored.reason);
          }
          b.record = commitUpdateRecoveryTerminal(
            b.record,
            { status: "rolled-back", package: restored, assertReady() {} },
            fence,
            b.options,
          );
          expect(b.reload().terminal?.status).toBe("rolled-back");
          expect(getUpdateRun(b.run.runId, b.options)?.reason).toBe("candidate-failed");
          expect(getUpdateRun(b.run.runId, b.options)?.verification.runningBuildId).toBeUndefined();
          expect(getUpdateRun(b.run.runId, b.options)?.verification).toMatchObject({
            runningVersion: b.record.from.version,
            readyz: true,
            channelsReady: true,
            pluginErrors: [],
            noticeDelivered: false,
          });
          expect(getUpdateRun(b.run.runId, b.options)?.verification).not.toHaveProperty(
            "inferenceProbe",
          );
          if (a) {
            expect(a.reload().retainedPair?.state).toBe("selected");
          } else {
            expect(b.reload().retainedPair).toBeUndefined();
            expect(restored.observation.previous).toBe("absent");
            await expect(fs.stat(b.descriptor.liveRoot)).rejects.toMatchObject({ code: "ENOENT" });
          }
        },
      );
    });
  });
}
