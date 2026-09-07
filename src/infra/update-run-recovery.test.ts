import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { defineUpdateRecoveryArtifactTests } from "./update-run-recovery-after-image.test-support.js";
import { RecoveryNativeIdentitySchema } from "./update-run-recovery-native-schema.js";
import {
  recordUpdateRecoveryNativeIntent,
  recordUpdateRecoveryNativeObservation,
  type UpdateRecoveryNativeIdentity,
} from "./update-run-recovery-native.js";
import { setupNativeManagerFixture } from "./update-run-recovery-native.test-support.js";
import { defineUpdateRecoveryPackageTests } from "./update-run-recovery-package.test-support.js";
import {
  acceptUpdateRecoveryHandoff,
  assertNoPendingUpdateRecovery,
  assertUpdateRecoveryClaim,
  beginUpdateRecovery,
  bindUpdateRecoveryCheckpoint,
  claimUpdateRecovery,
  loadUpdateRecoveries,
  loadUpdateRecovery,
  prepareUpdateRecoveryHandoff,
  recordUpdateRecoveryFailure,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryObservation,
  recordUpdateRecoveryVerification,
  UpdateRecoveryConflictError,
  UpdateRecoveryRequiredError,
} from "./update-run-recovery.js";
import type { UpdateServingReceipt } from "./update-serving-verification-receipt.js";

const tempDirs = createTempDirTracker();
// Test owns every writer of these disposable databases.
const fence = { assertCurrent() {} };
function setup() {
  const root = tempDirs.make("openclaw-update-recovery-");
  const options = { env: { OPENCLAW_STATE_DIR: root, HOME: root } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const from = {
    root: path.join(root, "old"),
    nodePath: process.execPath,
    version: "1.0.0",
    buildId: "old-build",
  };
  const to = { ...from, root: path.join(root, "new"), version: "2.0.0", buildId: "new-build" };
  return { root, options, run, from, to };
}
function checkpointFor(fixture: ReturnType<typeof setup>) {
  const checkpointId = randomUUID();
  return {
    ref: {
      checkpointId,
      manifestPath: path.join(fixture.root, "checkpoints", checkpointId, "manifest.json"),
      manifestSha256: "c".repeat(64),
    },
    binding: {
      runId: fixture.run.runId,
      stateDir: fixture.root,
      configPath: path.join(fixture.root, "openclaw.json"),
      fromRuntime: {
        root: fixture.from.root,
        version: fixture.from.version,
        nodePath: fixture.from.nodePath,
      },
    },
  };
}
function beginCapturedRecovery(fixture: ReturnType<typeof setup>) {
  const record = beginUpdateRecovery(
    { runId: fixture.run.runId, from: fixture.from, to: fixture.to },
    fence,
    fixture.options,
  );
  return bindUpdateRecoveryCheckpoint(record, checkpointFor(fixture), fence, fixture.options);
}
function setupServing(runtime: "candidate" | "previous" = "candidate") {
  const fixture = setup();
  const record = beginCapturedRecovery(fixture);
  const restartEffectId = randomUUID();
  const intent = recordUpdateRecoveryIntent(
    record,
    {
      effectId: restartEffectId,
      kind: "service-restart",
      resourceId: "gateway",
      runtime,
    },
    fence,
    fixture.options,
  );
  const observed = recordUpdateRecoveryObservation(
    intent,
    {
      effectId: restartEffectId,
      observedIdentity: "serving-boot",
    },
    fence,
    fixture.options,
  );
  const identity = runtime === "candidate" ? fixture.to : fixture.from;
  const receipt: UpdateServingReceipt = {
    runId: fixture.run.runId,
    gateway: { bootId: "serving-boot", version: identity.version, buildId: identity.buildId },
    agentId: "main",
    sessionKey: "agent:main:update-verification:synthetic",
    sessionId: "synthetic-session",
    agentRunId: randomUUID(),
    transcript: {
      generation: "synthetic-generation",
      maxSeq: 3,
      user: { entryId: "synthetic-user", seq: 1 },
      assistant: { entryId: "synthetic-assistant", seq: 3 },
    },
    verifiedAtMs: Date.now(),
  };
  return { ...fixture, observed, receipt, runtime, restartEffectId };
}
function snapshot(root: string) {
  return fs
    .readdirSync(root, { recursive: true })
    .map((entry) => String(entry))
    .toSorted((left, right) => left.localeCompare(right))
    .map((name) => {
      const file = path.join(root, name);
      const stat = fs.statSync(file);
      return {
        name,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        digest: stat.isFile()
          ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
          : null,
      };
    });
}

describe("durable update recovery", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  });
  it("pins source paths at admission instead of deriving them from a later checkpoint", () => {
    const fixture = setup();
    const { options, run, from, to } = fixture;
    const selectedConfig = path.join(fixture.root, "selected.json");
    const selectedOptions = { env: { ...options.env, OPENCLAW_CONFIG_PATH: selectedConfig } };
    const record = beginUpdateRecovery({ runId: run.runId, from, to }, fence, selectedOptions);
    expect(record.source).toEqual({
      stateDir: fixture.root,
      configPath: selectedConfig,
      profile: null,
    });
    const checkpoint = checkpointFor(fixture);
    expect(() => bindUpdateRecoveryCheckpoint(record, checkpoint, fence, options)).toThrow(
      "admitted source",
    );
    checkpoint.binding.configPath = selectedConfig;
    // The admitted identity survives a changed environment and database reopen.
    closeOpenClawStateDatabaseForTest();
    expect(bindUpdateRecoveryCheckpoint(record, checkpoint, fence, options).source).toEqual(
      record.source,
    );
  });

  it("preserves exact checkpoint identity across reopen without diagnostic disclosure", () => {
    const fixture = setup();
    const { root, options, run, from, to } = fixture;
    const record = beginUpdateRecovery({ runId: run.runId, from, to }, fence, options);
    const checkpoint = checkpointFor(fixture);
    checkpoint.ref.manifestPath = path.join(root, "x".repeat(900), "manifest.json");
    const first = bindUpdateRecoveryCheckpoint(record, checkpoint, fence, options);
    // A fresh consumer may reconstruct the same facts with different property order.
    const bound = bindUpdateRecoveryCheckpoint(
      first,
      { binding: checkpoint.binding, ref: checkpoint.ref },
      fence,
      options,
    );
    closeOpenClawStateDatabaseForTest();
    const before = snapshot(root);
    expect(loadUpdateRecovery(run.runId, options)?.checkpoint).toEqual(checkpoint);
    expect(snapshot(root)).toEqual(before);
    expect(JSON.stringify(getUpdateRun(run.runId, options))).not.toContain(
      checkpoint.ref.manifestPath,
    );
    const intent = recordUpdateRecoveryIntent(
      bound,
      {
        effectId: randomUUID(),
        kind: "package-activation",
        resourceId: to.root,
        runtime: "candidate",
      },
      fence,
      options,
    );
    expect(intent.checkpoint).toEqual(checkpoint);
    expect(() => bindUpdateRecoveryCheckpoint(bound, checkpoint, fence, options)).toThrow(
      UpdateRecoveryConflictError,
    );
    expect(() => bindUpdateRecoveryCheckpoint(intent, checkpoint, fence, options)).toThrow(
      "before update effects",
    );
  });

  it.each(["run", "root", "version", "node", "state", "config"])(
    "rejects a checkpoint for another %s without changing the record",
    (mismatch) => {
      const fixture = setup();
      const { options, run, from, to } = fixture;
      const record = beginUpdateRecovery({ runId: run.runId, from, to }, fence, options);
      const checkpoint = checkpointFor(fixture);
      if (mismatch === "state") {
        checkpoint.binding.stateDir = path.join(fixture.root, "other-state");
      }
      if (mismatch === "config") {
        checkpoint.binding.configPath = path.join(fixture.root, "other-config.json");
      }
      if (mismatch === "run") {
        checkpoint.binding.runId = randomUUID();
      }
      if (mismatch === "root") {
        checkpoint.binding.fromRuntime.root = to.root;
      }
      if (mismatch === "version") {
        checkpoint.binding.fromRuntime.version = to.version;
      }
      if (mismatch === "node") {
        checkpoint.binding.fromRuntime.nodePath = path.join(fixture.root, "other-node");
      }
      expect(() => bindUpdateRecoveryCheckpoint(record, checkpoint, fence, options)).toThrow(
        "admitted source",
      );
      expect(loadUpdateRecovery(run.runId, options)).toEqual(record);
    },
  );

  it("rejects checkpoint replacement and rolls back binding when the live fence is lost", () => {
    const fixture = setup();
    const { options, run, from, to } = fixture;
    const record = beginUpdateRecovery({ runId: run.runId, from, to }, fence, options);
    const checkpoint = checkpointFor(fixture);
    let calls = 0;
    expect(() =>
      bindUpdateRecoveryCheckpoint(
        record,
        checkpoint,
        {
          assertCurrent() {
            if (++calls === 3) {
              throw new Error("exclusion lost");
            }
          },
        },
        options,
      ),
    ).toThrow("exclusion lost");
    expect(loadUpdateRecovery(run.runId, options)).toEqual(record);
    const bound = bindUpdateRecoveryCheckpoint(record, checkpoint, fence, options);
    expect(() =>
      bindUpdateRecoveryCheckpoint(bound, checkpointFor(fixture), fence, options),
    ).toThrow(UpdateRecoveryConflictError);
    expect(loadUpdateRecovery(run.runId, options)).toEqual(bound);
  });

  it("refuses package activation without a durable checkpoint binding", () => {
    const { options, run, from, to } = setup();
    const record = beginUpdateRecovery({ runId: run.runId, from, to }, fence, options);
    expect(() =>
      recordUpdateRecoveryIntent(
        record,
        {
          effectId: randomUUID(),
          kind: "package-activation",
          resourceId: to.root,
          runtime: "candidate",
        },
        fence,
        options,
      ),
    ).toThrow("durable checkpoint binding");
    expect(loadUpdateRecovery(run.runId, options)).toEqual(record);
  });

  it("fences the parent before a single-use handoff and accepts the fresh candidate after reopening", () => {
    const { root, options, run, observed, receipt, to } = setupServing();
    const verified = recordUpdateRecoveryVerification(
      observed,
      { runtime: "candidate", receipt },
      fence,
      options,
    );
    const prepared = prepareUpdateRecoveryHandoff(verified, fence, options);
    expect(prepared.record.verification).toBeNull();
    expect(() => assertUpdateRecoveryClaim(verified, fence, options)).toThrow(
      UpdateRecoveryConflictError,
    );
    // Reloading correlation IDs cannot turn a prepared transfer into execution authority.
    expect(() => assertUpdateRecoveryClaim(prepared.record, fence, options)).toThrow(
      UpdateRecoveryConflictError,
    );
    expect(() =>
      recordUpdateRecoveryFailure(
        prepared.record,
        { code: "late-parent", effectId: null },
        fence,
        options,
      ),
    ).toThrow(UpdateRecoveryConflictError);
    closeOpenClawStateDatabaseForTest();
    const before = snapshot(root);
    expect(loadUpdateRecovery(run.runId, options)).toEqual(prepared.record);
    expect(snapshot(root)).toEqual(before);
    const handoffInput = JSON.stringify(prepared.handoff);
    const accepted = acceptUpdateRecoveryHandoff(JSON.parse(handoffInput), to, fence, options);
    expect(accepted.claimKind).toBe("handoff");
    expect(accepted.handoff?.state).toBe("accepted");
    expect(accepted.claimId).not.toBe(prepared.record.claimId);
    expect(() => assertUpdateRecoveryClaim(accepted, fence, options)).not.toThrow();
    expect(() => acceptUpdateRecoveryHandoff(prepared.handoff, to, fence, options)).toThrow(
      UpdateRecoveryConflictError,
    );
    expect(JSON.stringify(getUpdateRun(run.runId, options))).not.toContain(
      prepared.handoff.handoffId,
    );
  });

  it("distinguishes an abandoned handoff from normal continuation and rejects the late worker", () => {
    const { options, run, from, to } = setup();
    const initial = beginUpdateRecovery({ runId: run.runId, from, to }, fence, options);
    expect(initial.claimKind).toBe("initial");
    const prepared = prepareUpdateRecoveryHandoff(initial, fence, options);
    closeOpenClawStateDatabaseForTest();
    const resumed = claimUpdateRecovery(prepared.record, fence, options);
    expect(resumed.claimKind).toBe("recovery");
    expect(resumed.handoff).toBeNull();
    expect(() => acceptUpdateRecoveryHandoff(prepared.handoff, to, fence, options)).toThrow(
      UpdateRecoveryConflictError,
    );
    expect(() => assertUpdateRecoveryClaim(resumed, fence, options)).not.toThrow();
    expect(loadUpdateRecovery(run.runId, options)).toEqual(resumed);
  });

  it("rejects misbound worker identity without consuming the prepared handoff", () => {
    const { options, run, from, to } = setup();
    const initial = beginUpdateRecovery({ runId: run.runId, from, to }, fence, options);
    const { record, handoff } = prepareUpdateRecoveryHandoff(initial, fence, options);
    for (const wrong of [
      { ...handoff, handoffId: randomUUID() },
      { ...handoff, transactionId: randomUUID() },
      { ...handoff, claimId: randomUUID() },
      { ...handoff, runId: randomUUID() },
    ]) {
      expect(() => acceptUpdateRecoveryHandoff(wrong, to, fence, options)).toThrow(
        UpdateRecoveryConflictError,
      );
    }
    for (const wrong of [
      { ...to, root: from.root },
      { ...to, nodePath: path.join(from.root, "node") },
      { ...to, version: from.version },
      { ...to, buildId: null },
    ]) {
      expect(() => acceptUpdateRecoveryHandoff(handoff, wrong, fence, options)).toThrow(
        UpdateRecoveryConflictError,
      );
    }
    expect(loadUpdateRecovery(run.runId, options)).toEqual(record);
    expect(acceptUpdateRecoveryHandoff(handoff, to, fence, options).claimKind).toBe("handoff");
  });

  it("does not transfer unresolved effects or consume a handoff after losing live exclusion", () => {
    const fixture = setup();
    const { options, run, to } = fixture;
    const initial = beginCapturedRecovery(fixture);
    const effectId = randomUUID();
    const intent = recordUpdateRecoveryIntent(
      initial,
      {
        effectId,
        kind: "package-activation",
        resourceId: to.root,
        runtime: "candidate",
      },
      fence,
      options,
    );
    expect(() => prepareUpdateRecoveryHandoff(intent, fence, options)).toThrow(
      "Reconcile outstanding effects",
    );
    expect(loadUpdateRecovery(run.runId, options)).toEqual(intent);
    const observed = recordUpdateRecoveryObservation(
      intent,
      { effectId, observedIdentity: "verified-candidate" },
      fence,
      options,
    );
    const { record, handoff } = prepareUpdateRecoveryHandoff(observed, fence, options);
    let calls = 0;
    expect(() =>
      acceptUpdateRecoveryHandoff(
        handoff,
        to,
        {
          assertCurrent() {
            if (++calls === 3) {
              throw new Error("exclusion lost");
            }
          },
        },
        options,
      ),
    ).toThrow("exclusion lost");
    expect(loadUpdateRecovery(run.runId, options)).toEqual(record);
  });

  it.each(["candidate", "previous"] as const)(
    "reopens private %s proof bound to the observed boot without exposing it in history",
    (runtime) => {
      const { options, run, observed, receipt, restartEffectId } = setupServing(runtime);
      const recorded = recordUpdateRecoveryVerification(
        observed,
        { runtime, receipt },
        fence,
        options,
      );
      closeOpenClawStateDatabaseForTest();
      expect(loadUpdateRecovery(run.runId, options)?.verification).toEqual({
        runtime,
        effectId: restartEffectId,
        receipt,
      });
      expect(JSON.stringify(getUpdateRun(run.runId, options))).not.toContain(receipt.sessionId);
      expect(recorded.revision).toBe(observed.revision + 1);
    },
  );

  it.each(["run", "version", "build", "boot", "runtime"] as const)(
    "rejects proof from a different %s without changing persisted state",
    (mismatch) => {
      const { options, run, observed, receipt } = setupServing();
      if (mismatch === "run") {
        receipt.runId = randomUUID();
      }
      if (mismatch === "version") {
        receipt.gateway.version = "3.0.0";
      }
      if (mismatch === "build") {
        receipt.gateway.buildId = null;
      }
      if (mismatch === "boot") {
        receipt.gateway.bootId = "another-boot";
      }
      expect(() =>
        recordUpdateRecoveryVerification(
          observed,
          {
            runtime: mismatch === "runtime" ? "previous" : "candidate",
            receipt,
          },
          fence,
          options,
        ),
      ).toThrow("final observed update runtime");
      expect(loadUpdateRecovery(run.runId, options)).toEqual(observed);
    },
  );

  it.each([
    "service-restart",
    "checkpoint-restore",
    "package-activation",
    "package-restore",
    "claim",
  ] as const)("invalidates serving proof before %s and rejects a stale revision", (transition) => {
    const { options, run, observed, receipt } = setupServing();
    const verified = recordUpdateRecoveryVerification(
      observed,
      { runtime: "candidate", receipt },
      fence,
      options,
    );
    const next =
      transition === "claim"
        ? claimUpdateRecovery(verified, fence, options)
        : recordUpdateRecoveryIntent(
            verified,
            {
              effectId: randomUUID(),
              kind: transition,
              resourceId: "gateway",
              runtime: "candidate",
            },
            fence,
            options,
          );
    expect(loadUpdateRecovery(run.runId, options)?.verification).toBeNull();
    expect(() =>
      recordUpdateRecoveryVerification(verified, { runtime: "candidate", receipt }, fence, options),
    ).toThrow(UpdateRecoveryConflictError);
    if (transition !== "claim") {
      expect(() =>
        recordUpdateRecoveryVerification(next, { runtime: "candidate", receipt }, fence, options),
      ).toThrow("final observed update runtime");
    }
  });

  it("keeps missing-state reads non-creating", () => {
    const root = tempDirs.make("openclaw-update-recovery-empty-");
    const options = { env: { OPENCLAW_STATE_DIR: root } };
    expect(loadUpdateRecoveries(options)).toEqual([]);
    expect(() => assertNoPendingUpdateRecovery(options)).not.toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("reopens exact identity and detects interruption without writing any database artifact", () => {
    const fixture = setup();
    const { root, options, run, from } = fixture;
    const record = beginCapturedRecovery(fixture);
    const effectId = randomUUID();
    const pending = recordUpdateRecoveryIntent(
      record,
      {
        effectId,
        kind: "package-activation",
        resourceId: from.root,
        runtime: "candidate",
      },
      fence,
      options,
    );
    recordUpdateRunStep(
      run.runId,
      { step: "private", status: "completed", detail: from.root },
      options,
    );
    // Closing all owner handles and reopening must not need a transaction closure.
    closeOpenClawStateDatabaseForTest();
    const before = snapshot(root);
    expect(loadUpdateRecovery(run.runId, options)).toEqual(pending);
    expect(() => assertNoPendingUpdateRecovery(options)).toThrow(UpdateRecoveryRequiredError);
    expect(snapshot(root)).toEqual(before);
    expect(JSON.stringify(getUpdateRun(run.runId, options))).not.toContain(from.root);
  });

  it("fences a stale claimant and will not skip an unresolved effect", () => {
    const { options, run, from, to } = setup();
    const record = beginUpdateRecovery({ runId: run.runId, from, to }, fence, options);
    const claimed = claimUpdateRecovery(record, fence, options);
    expect(claimed.claimId).not.toBe(record.claimId);
    expect(() => claimUpdateRecovery(record, fence, options)).toThrow(UpdateRecoveryConflictError);
    const effectId = randomUUID();
    const pending = recordUpdateRecoveryIntent(
      claimed,
      {
        effectId,
        kind: "checkpoint-restore",
        resourceId: "shared-db",
        runtime: "previous",
      },
      fence,
      options,
    );
    expect(() =>
      recordUpdateRecoveryIntent(
        pending,
        {
          effectId: randomUUID(),
          kind: "service-restart",
          resourceId: "gateway",
          runtime: "previous",
        },
        fence,
        options,
      ),
    ).toThrow("outstanding recovery effect");
    expect(loadUpdateRecovery(run.runId, options)).toEqual(pending);
    const observed = recordUpdateRecoveryObservation(
      pending,
      {
        effectId,
        observedIdentity: "sha256:" + "a".repeat(64),
      },
      fence,
      options,
    );
    expect(observed.effects.at(-1)).toMatchObject({ state: "observed" });
    expect(() =>
      recordUpdateRecoveryObservation(
        pending,
        {
          effectId,
          observedIdentity: "sha256:" + "b".repeat(64),
        },
        fence,
        options,
      ),
    ).toThrow(UpdateRecoveryConflictError);
  });

  it("keeps recovery active despite diagnostic terminal writes and rejects another transaction", () => {
    const { options, run, from, to } = setup();
    const record = beginUpdateRecovery({ runId: run.runId, from, to }, fence, options);
    finishUpdateRun(run.runId, { status: "failed", reason: "interrupted" }, options);
    expect(loadUpdateRecovery(run.runId, options)).toEqual(record);
    expect(() => beginUpdateRecovery({ runId: run.runId, from, to }, fence, options)).toThrow(
      UpdateRecoveryRequiredError,
    );
  });

  it("preserves the primary failure and rolls back a lost live fence", () => {
    const { options, run, from, to } = setup();
    const record = beginUpdateRecovery({ runId: run.runId, from, to }, fence, options);
    const failed = recordUpdateRecoveryFailure(
      record,
      { code: "verification-failed", effectId: null },
      fence,
      options,
    );
    const again = recordUpdateRecoveryFailure(
      failed,
      { code: "restore-conflict", effectId: null },
      fence,
      options,
    );
    expect(again.primaryFailure?.code).toBe("verification-failed");
    let calls = 0;
    expect(() =>
      claimUpdateRecovery(
        again,
        {
          assertCurrent() {
            if (++calls === 3) {
              throw new Error("exclusion lost");
            }
          },
        },
        options,
      ),
    ).toThrow("exclusion lost");
    expect(loadUpdateRecovery(run.runId, options)).toEqual(again);
  });

  it("preserves the entire schema while persisting private records alongside history", () => {
    const { options, run, from, to } = setup();
    const { db } = openOpenClawStateDatabase(options);
    const schema = () => db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
    const before = schema();
    const version = db.prepare("PRAGMA user_version").get();
    const history = getUpdateRun(run.runId, options);
    const record = beginUpdateRecovery({ runId: run.runId, from, to }, fence, options);
    expect(loadUpdateRecovery(run.runId, options)).toEqual(record);
    expect(getUpdateRun(run.runId, options)).toEqual(history);
    expect(schema()).toEqual(before);
    expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
  });

  it("rejects corrupt operational records without erasing them or admitting new work", () => {
    const { options, run } = setup();
    const { db } = openOpenClawStateDatabase(options);
    const key = "update.recovery." + run.runId;
    db.prepare(
      "INSERT INTO config_machine_state (value_json,state_key,updated_at_ms) VALUES (?,?,0)",
    ).run('{"revision":1}', key);
    expect(() => assertNoPendingUpdateRecovery(options)).toThrow();
    expect(
      db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?").get(key)
        ?.value_json,
    ).toBe('{"revision":1}');
  });
});

defineUpdateRecoveryArtifactTests();
defineUpdateRecoveryPackageTests();

describe("systemd native identity binding", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  });
  it.each(["scope", "uid", "unit", "unit-space"] as const)(
    "rejects a different systemd %s during pending readback without advancing its record",
    async (field) => {
      const f = await setupNativeManagerFixture(
        fs.realpathSync(tempDirs.make("recovery-systemd-")),
        "linux",
        true,
      );
      let record = await f.bind();
      if (f.identity.platform !== "linux" || f.identity.scope !== "user") {
        throw new Error("Expected user-manager fixture");
      }
      const target = { ...f.original, stopped: true };
      const effectId = randomUUID();
      record = (
        await recordUpdateRecoveryNativeIntent(
          record,
          { effectId, action: "stop", target, observe: f.observe },
          f.fence,
          f.options,
        )
      ).record;
      const { uid: _uid, ...system } = f.identity;
      const identity: UpdateRecoveryNativeIdentity =
        field === "scope"
          ? { ...system, scope: "system" }
          : field === "uid"
            ? { ...f.identity, uid: 1001 }
            : {
                ...f.identity,
                unitName: f.identity.unitName + (field === "unit" ? "-other" : " "),
              };
      f.setFacts(target);
      await expect(
        recordUpdateRecoveryNativeObservation(
          record,
          effectId,
          async () => ({ identity, facts: target }),
          f.fence,
          f.options,
        ),
      ).rejects.toThrow();
      expect(loadUpdateRecovery(record.runId, f.options)).toEqual(record);
      const observed = await recordUpdateRecoveryNativeObservation(
        record,
        effectId,
        f.observe,
        f.fence,
        f.options,
      );
      expect(observed.status).toBe("after");
      expect(observed.record.nativeManager!.effects.at(-1)?.state).toBe("observed");
    },
  );

  it("requires an explicit numeric user-manager UID and rejects one on system scope", async () => {
    const f = await setupNativeManagerFixture(
      fs.realpathSync(tempDirs.make("recovery-systemd-")),
      "linux",
      true,
    );
    if (f.identity.platform !== "linux" || f.identity.scope !== "user") {
      throw new Error("Expected user-manager fixture");
    }
    const { uid: _uid, ...withoutUid } = f.identity;
    for (const uid of [undefined, null, "0", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(RecoveryNativeIdentitySchema.safeParse({ ...withoutUid, uid }).success).toBe(false);
    }
    expect(RecoveryNativeIdentitySchema.safeParse({ ...f.identity, scope: "system" }).success).toBe(
      false,
    );
    expect(RecoveryNativeIdentitySchema.safeParse({ ...withoutUid, scope: "system" }).success).toBe(
      true,
    );
  });
});
