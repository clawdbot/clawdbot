import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import type { UpdateCheckpointPluginIndexMutation } from "./update-checkpoint-plugin-index.js";
import type { restoreUpdateCheckpointResource } from "./update-checkpoint-restore.js";
import { createUpdateRecoveryCheckpointAdapter } from "./update-run-recovery-checkpoint.js";
import {
  prepareUpdateRecoveryHandoff,
  acceptUpdateRecoveryHandoff,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryObservation,
  bindUpdateRecoveryAfterImage,
  loadUpdateRecovery,
  type UpdateRecoveryRecord,
  type UpdateRecoveryFence,
} from "./update-run-recovery.js";

type BoundCheckpoint = NonNullable<UpdateRecoveryRecord["checkpoint"]>;
export async function captureCheckpointPhases(params: {
  record: UpdateRecoveryRecord;
  phasedPluginWrites: boolean;
  runtime: UpdateRecoveryRecord["to"];
  fence: UpdateRecoveryFence;
  options: OpenClawStateDatabaseOptions;
  file: string;
  initial: BoundCheckpoint;
  effectId: string;
  capture: (
    content: string,
    mutations?: UpdateCheckpointPluginIndexMutation[],
  ) => Promise<BoundCheckpoint>;
}) {
  const { phasedPluginWrites, runtime, fence, options, file, initial, effectId, capture } = params;
  let { record } = params;
  if (phasedPluginWrites) {
    const handoff = prepareUpdateRecoveryHandoff(record, fence, options);
    record = acceptUpdateRecoveryHandoff(handoff.handoff, runtime, fence, options);
  }
  let previousRow: UpdateCheckpointPluginIndexMutation["after"] = null;
  for (const index of phasedPluginWrites ? [0, 1, 2] : [0]) {
    const phaseEffectId = index === 0 ? effectId : randomUUID();
    if (index > 0) {
      record = recordUpdateRecoveryIntent(
        record,
        {
          effectId: phaseEffectId,
          kind: "runtime-mutation",
          resourceId: `phase-${index}`,
          runtime: "candidate",
        },
        fence,
        options,
      );
      record = recordUpdateRecoveryObservation(
        record,
        { effectId: phaseEffectId, observedIdentity: `phase-${index}` },
        fence,
        options,
      );
    }
    const afterRow = {
      state_key: "plugins.installedIndex",
      value_json: `phase-${index}`,
      updated_at_ms: index + 1,
    };
    if (phasedPluginWrites) {
      closeOpenClawStateDatabaseForTest();
      const db = openNodeSqliteDatabase(file);
      db.prepare("INSERT OR REPLACE INTO config_machine_state VALUES(?,?,?)").run(
        afterRow.state_key,
        afterRow.value_json,
        afterRow.updated_at_ms,
      );
      db.close();
    }
    const after = await capture(
      "candidate",
      phasedPluginWrites
        ? [{ databasePath: file, before: previousRow, after: afterRow }]
        : undefined,
    );
    record = bindUpdateRecoveryAfterImage(
      record,
      { checkpointRef: initial.ref, afterUpdate: after, effectIds: [phaseEffectId] },
      fence,
      options,
    );
    previousRow = afterRow;
  }
  return record;
}

type PhaseFixture = {
  file: string;
  options: OpenClawStateDatabaseOptions;
  adapter: ReturnType<typeof createUpdateRecoveryCheckpointAdapter>;
  adapterParams: Omit<Parameters<typeof createUpdateRecoveryCheckpointAdapter>[0], "expected">;
  apply: (
    record: UpdateRecoveryRecord,
    cursor?: number,
  ) => ReturnType<typeof restoreUpdateCheckpointResource>;
};
export function registerCheckpointPhaseReceiptTest(fixture: () => Promise<PhaseFixture>) {
  it("binds all phase-local plugin receipts through a fresh recovery adapter", async () => {
    const f = await fixture();
    const sealed = f.adapter.record;
    expect(sealed.afterImages).toHaveLength(3);
    const unbound = structuredClone(sealed);
    unbound.afterImages![0]!.afterUpdate.ref.manifestSha256 = "f".repeat(64);
    const before = family(f.file);
    const rejected = createUpdateRecoveryCheckpointAdapter({
      ...f.adapterParams,
      expected: unbound,
    });
    await expect(rejected.inspect()).rejects.toThrow();
    expect(family(f.file)).toEqual(before);
    expect((await f.apply(sealed)).status).toBe("applied");
    const fresh = createUpdateRecoveryCheckpointAdapter({
      ...f.adapterParams,
      expected: loadUpdateRecovery(sealed.runId, f.options)!,
    });
    const claimed = await fresh.claimPublished();
    expect(claimed.afterImages).toEqual(sealed.afterImages);
    closeOpenClawStateDatabaseForTest();
    await fresh.observe();
    closeOpenClawStateDatabaseForTest();
    const next = await fresh.next();
    closeOpenClawStateDatabaseForTest();
    expect((await f.apply(next, 1)).status).toBe("applied");
    await fresh.observe();
    closeOpenClawStateDatabaseForTest();
    expect((await fresh.inspect()).status).toBe("verified");
    const db = openNodeSqliteDatabase(f.file, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT * FROM config_machine_state WHERE state_key='plugins.installedIndex'")
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
}

export function fileHash(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
export function family(file: string) {
  return [file, `${file}-wal`, `${file}-shm`, `${file}-journal`].map((entry) =>
    fs.existsSync(entry) ? fileHash(entry) : null,
  );
}

export function trackCheckpointFixtureDirs() {
  return useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      vi.restoreAllMocks();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
}
