import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { inspectCheckpointFile } from "./update-checkpoint-files.js";
import { captureUpdateCheckpoint, reopenUpdateCheckpoint } from "./update-checkpoint.js";
import { createUpdateRun } from "./update-run-ledger.js";
import {
  beginUpdateRecovery,
  bindUpdateRecoveryCheckpoint,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryObservation,
  type UpdateRecoveryRecord,
} from "./update-run-recovery.js";

export type RecoveryAfterImageFixture = Awaited<ReturnType<typeof fixture>>;

export const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
export const fence = { assertCurrent() {} }; // The test owns every source and writer.
export async function fixture() {
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
    // The fixture owns this write and retains its output before any later work.
    const output = { sourcePath: configPath, state: await inspectCheckpointFile(configPath) };
    const ref = await captureUpdateCheckpoint({
      ...access,
      expectedSources: [output],
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
  return { root, options, run, runtime, record, checkpoint, input, capture, observe, access };
}
