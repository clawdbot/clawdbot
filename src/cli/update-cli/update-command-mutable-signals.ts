import fs from "node:fs";
import {
  finishInterruptedUpdateBeforeActivationInTransaction,
  getUpdateRun,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { isUpdateRecoveryPending } from "../../infra/update-run-recovery-schema.js";
import { readRecoveries, writeRecovery } from "../../infra/update-run-recovery-store.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { waitForSignalExitBarriers } from "../signal-exit-barrier.js";
import type { UpdateCommandOptions } from "./shared.js";

type Run = NonNullable<UpdateCommandOptions["run"]>;
// Only the object minted by this local admission participates. A saved run ID,
// inherited diagnostic row, or a recovered process identity cannot populate it.
const admissions = new WeakMap<
  Run,
  { record: UpdateRunRecord; env: NodeJS.ProcessEnv; dev: number; ino: number }
>();

export function admitMutableUpdateSignalRun(run: Run, record: UpdateRunRecord): void {
  const env = { ...run.env };
  const file = fs.lstatSync(resolveOpenClawStateSqlitePath(env));
  if (!file.isFile()) {
    throw new Error("Update admission requires its regular state database.");
  }
  admissions.set(run, { record, env, dev: file.dev, ino: file.ino });
}

export async function withMutableUpdateSignals<T>(
  opts: UpdateCommandOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const run = opts.run;
  const admission = !opts.dryRun && run ? admissions.get(run) : undefined;
  if (!run || !admission) {
    return await operation();
  }
  admissions.delete(run);
  const { env } = admission;
  const pathname = resolveOpenClawStateSqlitePath(env);
  const assertCurrent = () => {
    if (!run.executorFence) {
      throw new Error("Interrupted update has no live installation owner.");
    }
    run.executorFence.assertCurrent();
    const file = fs.lstatSync(pathname);
    if (!file.isFile() || file.dev !== admission.dev || file.ino !== admission.ino) {
      throw new Error("Interrupted update's canonical state generation changed.");
    }
  };
  const settle = () => {
    if (
      process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1" ||
      process.env.OPENCLAW_UPDATE_POST_CORE === "1" ||
      !run.executorFence
    ) {
      return;
    }
    assertCurrent();
    const expected = getUpdateRun(run.runId, { env });
    if (
      !expected ||
      expected.status !== "running" ||
      !["requested", "staging", "validating"].includes(expected.phase) ||
      expected.createdAtMs !== admission.record.createdAtMs
    ) {
      return;
    }
    assertCurrent();
    // This non-creating transaction cannot migrate or reopen a displaced family.
    // Pending operational recovery keeps exclusive ownership of its outcome.
    writeRecovery(
      { assertCurrent },
      (db) => {
        assertCurrent();
        if (
          readRecoveries(db).some(
            (entry) => entry.runId === run.runId || isUpdateRecoveryPending(entry),
          )
        ) {
          return;
        }
        finishInterruptedUpdateBeforeActivationInTransaction(db, expected, { env });
        assertCurrent();
      },
      { env },
      "existing-schema",
    );
  };
  let shutdown: Promise<void> | undefined;
  const onSignal = (code: number) => {
    if (shutdown) {
      return;
    }
    // Finish the local diagnostic synchronously before a terminated package child
    // can unwind. Native/post-activation work is excluded above and still drains
    // through the existing process-wide signal barriers.
    try {
      settle();
    } catch {
      defaultRuntime.error("Update interruption could not be recorded; history remains pending.");
    }
    shutdown = waitForSignalExitBarriers()
      .catch(() => {
        defaultRuntime.error("Update signal cleanup did not complete.");
      })
      .finally(() => process.exit(code));
  };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    return await operation();
  } finally {
    await shutdown;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}
