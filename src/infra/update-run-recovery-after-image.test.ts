import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { captureUpdateCheckpoint, reopenUpdateCheckpoint } from "./update-checkpoint.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import {
  acceptUpdateRecoveryHandoff,
  beginUpdateRecovery,
  bindUpdateRecoveryAfterImage,
  bindUpdateRecoveryCheckpoint,
  claimUpdateRecovery,
  loadUpdateRecovery,
  prepareUpdateRecoveryCarryForward,
  prepareUpdateRecoveryHandoff,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryObservation,
  type UpdateRecoveryRecord,
} from "./update-run-recovery.js";

const dirs = createTempDirTracker();
const fence = { assertCurrent() {} }; // The test owns every source and writer.
async function fixture() {
  const root = dirs.make("recovery-after-image-");
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const runtime = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
  let record = beginUpdateRecovery(
    { runId: run.runId, from: runtime, to: runtime },
    fence,
    options,
  );
  const configPath = path.join(root, "openclaw.json");
  fs.writeFileSync(configPath, "original");
  const access = {
    artifactRoot: path.join(root, "artifacts"),
    binding: {
      runId: run.runId,
      stateDir: root,
      configPath,
      fromRuntime: { root, nodePath: runtime.nodePath, version: runtime.version },
    },
    assertQuiescent: () => fence.assertCurrent(),
  };
  const capture = async (content: string) => {
    fs.writeFileSync(configPath, content);
    const ref = await captureUpdateCheckpoint({
      ...access,
      resources: [{ sourcePath: configPath, kind: "config", restore: "replace" }],
      exclusions: [],
    });
    const reopened = await reopenUpdateCheckpoint(ref, access);
    return { ref: reopened.ref, binding: reopened.manifest.binding };
  };
  const checkpoint = await capture("original");
  record = bindUpdateRecoveryCheckpoint(record, checkpoint, fence, options);
  const observe = (current: UpdateRecoveryRecord) => {
    const intent = recordUpdateRecoveryIntent(
      current,
      {
        effectId: randomUUID(),
        kind: "package-activation",
        resourceId: "owned-package",
        runtime: "candidate",
      },
      fence,
      options,
    );
    return recordUpdateRecoveryObservation(
      intent,
      {
        effectId: intent.effects.at(-1)!.effectId,
        observedIdentity: "owner-observed-generation",
      },
      fence,
      options,
    );
  };
  record = observe(record);
  const afterUpdate = await capture("owner-written-after-image");
  const input = {
    checkpointRef: checkpoint.ref,
    afterUpdate,
    effectIds: record.effects.map((effect) => effect.effectId),
  };
  return { root, options, run, runtime, record, checkpoint, input, capture, observe };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

describe("durable after-image binding", () => {
  it("retains exact owner-reopened intervals across reopen, handoff, and reclaim without exposing artifacts in history", async () => {
    const f = await fixture();
    let record = bindUpdateRecoveryAfterImage(f.record, f.input, fence, f.options);
    const first = record.afterImages![0];
    closeOpenClawStateDatabaseForTest();
    expect(loadUpdateRecovery(f.run.runId, f.options)?.afterImages).toEqual([first]);
    const handoff = prepareUpdateRecoveryHandoff(record, fence, f.options);
    record = acceptUpdateRecoveryHandoff(handoff.handoff, f.runtime, fence, f.options);
    record = claimUpdateRecovery(record, fence, f.options);
    record = f.observe(record);
    const afterUpdate = await f.capture("second-owned-interval");
    record = bindUpdateRecoveryAfterImage(
      record,
      {
        checkpointRef: f.checkpoint.ref,
        afterUpdate,
        effectIds: [record.effects.at(-1)!.effectId],
      },
      fence,
      f.options,
    );
    closeOpenClawStateDatabaseForTest();
    const loaded = loadUpdateRecovery(f.run.runId, f.options)!;
    expect(loaded.afterImages).toEqual([
      first,
      {
        checkpointRef: f.checkpoint.ref,
        afterUpdate,
        effectIds: [record.effects.at(-1)!.effectId],
        boundAtRevision: record.revision,
      },
    ]);
    expect(loaded.checkpoint).toEqual(f.checkpoint);
    expect(JSON.stringify(getUpdateRun(f.run.runId, f.options))).not.toContain(
      f.input.afterUpdate.ref.manifestPath,
    );
  });

  it.each([
    "initial ref",
    "source binding",
    "initial as after-image",
    "wrong effect",
    "partial interval",
    "unresolved effect",
  ])("rejects %s without changing recovery", async (change) => {
    const f = await fixture();
    const input = structuredClone(f.input);
    let expected = f.record;
    if (change === "initial ref") {
      input.checkpointRef.manifestSha256 = "a".repeat(64);
    }
    if (change === "source binding") {
      input.afterUpdate.binding.configPath = path.join(f.root, "different.json");
    }
    if (change === "initial as after-image") {
      input.afterUpdate = f.checkpoint;
    }
    if (change === "wrong effect") {
      input.effectIds = [randomUUID()];
    }
    if (change === "partial interval") {
      expected = f.observe(expected);
    }
    if (change === "unresolved effect") {
      expected = recordUpdateRecoveryIntent(
        expected,
        {
          effectId: randomUUID(),
          kind: "service-restart",
          resourceId: "gateway",
          runtime: "candidate",
        },
        fence,
        f.options,
      );
      input.effectIds = expected.effects.map((effect) => effect.effectId);
    }
    expect(() => bindUpdateRecoveryAfterImage(expected, input, fence, f.options)).toThrow();
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(expected);
  });

  it("rejects duplicate coverage and reusing an artifact for a later interval", async () => {
    const f = await fixture();
    const bound = bindUpdateRecoveryAfterImage(f.record, f.input, fence, f.options);
    expect(() => bindUpdateRecoveryAfterImage(bound, f.input, fence, f.options)).toThrow();
    const next = f.observe(bound);
    expect(() =>
      bindUpdateRecoveryAfterImage(
        next,
        {
          ...f.input,
          effectIds: [next.effects.at(-1)!.effectId],
        },
        fence,
        f.options,
      ),
    ).toThrow();
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(next);
  });

  it("rejects lost authority after capture and rolls back a binding if exclusion is lost before commit", async () => {
    const f = await fixture();
    const reclaimed = claimUpdateRecovery(f.record, fence, f.options);
    expect(() => bindUpdateRecoveryAfterImage(f.record, f.input, fence, f.options)).toThrow();
    let checks = 0;
    expect(() =>
      bindUpdateRecoveryAfterImage(
        reclaimed,
        f.input,
        {
          assertCurrent() {
            if (++checks === 3) {
              throw new Error("exclusion lost before commit");
            }
          },
        },
        f.options,
      ),
    ).toThrow("exclusion lost before commit");
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(reclaimed);
    const transfer = prepareUpdateRecoveryHandoff(reclaimed, fence, f.options);
    expect(() =>
      bindUpdateRecoveryAfterImage(transfer.record, f.input, fence, f.options),
    ).toThrow();
  });

  it("carries after-image bindings through both databases without accepting new images during restoration", async () => {
    const f = await fixture();
    const bound = bindUpdateRecoveryAfterImage(f.record, f.input, fence, f.options);
    const file = path.join(f.root, "state", "openclaw.sqlite");
    const stage = path.join(f.root, "staged.sqlite");
    closeOpenClawStateDatabaseForTest();
    await createVerifiedSqliteSnapshot({
      sourcePath: file,
      targetPath: stage,
      preserveRowIds: true,
    });
    const intent = recordUpdateRecoveryIntent(
      bound,
      {
        effectId: randomUUID(),
        kind: "checkpoint-restore",
        resourceId: f.checkpoint.ref.checkpointId,
        runtime: "previous",
      },
      fence,
      f.options,
    );
    closeOpenClawStateDatabaseForTest();
    const sourceDb = openNodeSqliteDatabase(file);
    const stagedDb = openNodeSqliteDatabase(stage);
    let restored: UpdateRecoveryRecord;
    try {
      const version = stagedDb.prepare("PRAGMA user_version").get();
      restored = prepareUpdateRecoveryCarryForward({
        sourceDb,
        stagedDb,
        expected: intent,
        fence,
        nextProgress: {
          restoreId: randomUUID(),
          checkpointId: f.checkpoint.ref.checkpointId,
          planPath: path.join(f.root, "restore.json"),
          planSha256: null,
          resourceCursor: 0,
          phase: "preparing",
        },
        validateStagedDatabase(db) {
          expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
        },
      }).record;
    } finally {
      sourceDb.close();
      stagedDb.close();
    }
    expect(loadUpdateRecovery(f.run.runId, f.options)?.afterImages).toEqual(bound.afterImages);
    expect(loadUpdateRecovery(f.run.runId, { path: stage })?.afterImages).toEqual(
      bound.afterImages,
    );
    expect(() => bindUpdateRecoveryAfterImage(restored, f.input, fence, f.options)).toThrow();
  });
});
