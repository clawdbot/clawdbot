import { inspect } from "node:util";
import { expect } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { completeUpdateCommandCandidate } from "./update-command-candidate-completion.js";
import { resumePendingUpdateCommand } from "./update-command-pending-replay.js";
import type { FinishUpdateParams } from "./update-command-post-update.js";
import { UpdateCommandFinalizedRecoveryFailure } from "./update-command-result.js";

/** Leave the first real executor after disable/stop applied but readback was interrupted.
 * Only a new owner may reconcile the same pending operation and fresh native stop. */
export async function interruptNativeSuppressionReplay(
  params: FinishUpdateParams,
  releaseInspection: () => void,
  action: "stop" | "suppress" = "suppress",
): Promise<() => Promise<void>> {
  const recovery = params.opts.recovery!;
  const env = params.opts.run!.env;
  const outcome = await completeUpdateCommandCandidate(params).catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(Error);
  const pending = recovery.getRecord();
  const suppression = structuredClone(pending.nativeManager!.effects.at(-1)!);
  expect(suppression).toMatchObject({
    action,
    state: "intent",
    before: { enabled: action === "suppress", loaded: true, stopped: false },
    after: { enabled: false, loaded: true, stopped: action === "stop" },
  });
  expect(pending.effects.at(-1)).toMatchObject({
    kind: "service-restart",
    runtime: "candidate",
    state: "intent",
    observedIdentity: null,
  });
  expect(
    pending.effects.some((effect) =>
      ["package-restore", "checkpoint-restore"].includes(effect.kind),
    ),
  ).toBe(false);
  expect(pending.restore).toBeNull();
  expect(pending.terminal).toBeUndefined();
  const resume = () =>
    resumePendingUpdateCommand({
      opts: { json: true, yes: true },
      root: params.root,
      timeoutMs: params.updateStepTimeoutMs,
    });
  await expect(resume()).rejects.toThrow(/Another update executor/);
  return async () => {
    releaseInspection();
    closeOpenClawStateDatabaseForTest();
    const resumed = await resume().catch((error: unknown) => error);
    expect(resumed, inspect(resumed, { depth: 12 })).toBeInstanceOf(
      UpdateCommandFinalizedRecoveryFailure,
    );
    const current = loadUpdateRecovery(pending.runId, { env })!;
    expect(current.claimId).not.toBe(pending.claimId);
    expect(current.transactionId).toBe(pending.transactionId);
    expect(current.terminal).toMatchObject({
      status: "rolled-back",
      receipt: { runtime: "previous" },
    });
    const settled = current.nativeManager!.effects.find(
      (effect) => effect.effectId === suppression.effectId,
    )!;
    if (action === "stop") {
      expect(settled.state).toBe("observed");
      expect(settled.observedRevision).toBeGreaterThan(suppression.intentRevision);
    }
    expect(settled.before).toEqual(suppression.before);
    expect(settled.after).toEqual(suppression.after);
    expect(settled.intentRevision).toBe(suppression.intentRevision);
    const db = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(env), { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM update_runs").get()?.n).toBe(1);
    } finally {
      db.close();
    }
  };
}
