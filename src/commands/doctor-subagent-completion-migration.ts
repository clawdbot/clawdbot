/** Doctor owns legacy completion bindings; runtime reads only exact run identities. */
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

const CHECK_ID = "core/doctor/subagent-completion-bindings";

function inspectCompletionBindings(db: DatabaseSync) {
  const kysely = getNodeSqliteKysely<DB>(db);
  const tasks = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("task_runs")
      .select([
        "task_id",
        "run_id",
        "runtime",
        "child_session_key",
        "requester_session_key",
        "created_at",
      ]),
  ).rows;
  const runs = executeSqliteQuerySync(db, kysely.selectFrom("subagent_runs").selectAll()).rows.map(
    (row) => {
      const payload = safeParseJson(row.payload_json);
      if (!isRecord(payload)) {
        throw new Error("Cannot establish completion ownership from invalid subagent state.");
      }
      const taskRunId = typeof payload.taskRunId === "string" ? payload.taskRunId.trim() : "";
      return Object.assign(row, { payload, binding: taskRunId || row.run_id });
    },
  );
  const bindings: Array<{ runId: string; payloadJson: string }> = [];
  let alreadyCanonical = 0;
  let leftAmbiguous = 0;
  let leftUnbound = 0;
  for (const run of runs) {
    const payload = run.payload;
    if (
      !isRecord(payload.completion) ||
      payload.completion.required !== true ||
      !isRecord(payload.execution) ||
      payload.execution.status !== "terminal"
    ) {
      continue;
    }
    const exactTasks = tasks.filter((task) => task.run_id === run.binding);
    const exactRuns = runs.filter((other) => other.binding === run.binding);
    const exactTask = exactTasks[0];
    if (
      exactTasks.length === 1 &&
      exactRuns.length === 1 &&
      exactTask?.runtime === "subagent" &&
      exactTask.child_session_key === run.child_session_key &&
      exactTask.requester_session_key === run.requester_session_key
    ) {
      alreadyCanonical += 1;
      continue;
    }
    if (payload.taskRunId !== undefined) {
      leftUnbound += 1;
      continue;
    }
    const childRuns = runs.filter((other) => other.child_session_key === run.child_session_key);
    const childTasks = tasks.filter(
      (task) => task.runtime === "subagent" && task.child_session_key === run.child_session_key,
    );
    // Adoption can reorder generations while retaining an earlier session start.
    // Never pick the newest candidate or eliminate siblings by delivery state.
    if (childRuns.length > 1 || childTasks.length > 1) {
      leftAmbiguous += 1;
      continue;
    }
    const task = childTasks[0];
    const start = payload.sessionStartedAt;
    if (
      !task?.run_id ||
      task.run_id.trim() !== task.run_id ||
      task.requester_session_key !== run.requester_session_key ||
      typeof start !== "number" ||
      !Number.isFinite(start) ||
      start >= run.created_at ||
      task.created_at < start ||
      task.created_at > run.created_at
    ) {
      leftUnbound += 1;
      continue;
    }
    // Recovery selects by run binding alone, so collisions outside this child
    // session also prevent a repair, even if that other row is already delivered.
    if (
      tasks.filter((other) => other.run_id === task.run_id).length !== 1 ||
      runs.some((other) => other.binding === task.run_id)
    ) {
      leftAmbiguous += 1;
      continue;
    }
    bindings.push({
      runId: run.run_id,
      payloadJson: JSON.stringify({ ...payload, taskRunId: task.run_id }),
    });
  }
  return { bindings, alreadyCanonical, leftAmbiguous, leftUnbound };
}

function inspectExistingBindings(env: NodeJS.ProcessEnv) {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => runSqliteDeferredTransactionSync(db, () => inspectCompletionBindings(db)),
    { env },
  );
}

function describeBindings(result: ReturnType<typeof inspectCompletionBindings>, repaired: boolean) {
  return `Subagent completion bindings: ${repaired ? "backfilled" : "would-backfill"}=${result.bindings.length}, left-ambiguous=${result.leftAmbiguous}, already-canonical=${result.alreadyCanonical}, left-unbound=${result.leftUnbound}.`;
}

export function collectSubagentCompletionBindingFindings(
  env: NodeJS.ProcessEnv = process.env,
): readonly HealthFinding[] {
  const result = inspectExistingBindings(env);
  if (!result || !(result.bindings.length + result.leftAmbiguous + result.leftUnbound)) {
    return [];
  }
  return [
    {
      checkId: CHECK_ID,
      severity: "warning",
      message: describeBindings(result, false),
      fixHint: `Stop the Gateway, run ${formatCliCommand("openclaw doctor --fix")}, then restart it. Ambiguous or unmatched completions require ownership investigation; doctor will not guess.`,
    },
  ];
}

export async function maybeMigrateSubagentCompletionBindings(params: {
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = params.env ?? process.env;
  try {
    let result = inspectExistingBindings(env);
    if (!result) {
      return;
    }
    if (params.shouldRepair && result.bindings.length > 0) {
      result = await withDoctorSqliteMaintenanceLock({
        env,
        operation: "subagent completion binding migration",
        protectedPaths: [resolveOpenClawStateSqlitePath(env)],
        run: () =>
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              // Re-read under the write lock: previews never authorize a later write.
              const current = inspectCompletionBindings(db);
              const kysely = getNodeSqliteKysely<DB>(db);
              for (const binding of current.bindings) {
                executeSqliteQuerySync(
                  db,
                  kysely
                    .updateTable("subagent_runs")
                    .set({ payload_json: binding.payloadJson })
                    .where("run_id", "=", binding.runId),
                );
              }
              for (const binding of current.bindings) {
                const stored = executeSqliteQuerySync(
                  db,
                  kysely
                    .selectFrom("subagent_runs")
                    .select("payload_json")
                    .where("run_id", "=", binding.runId),
                ).rows[0];
                if (stored?.payload_json !== binding.payloadJson) {
                  throw new Error("Completion binding verification failed; migration rolled back.");
                }
              }
              return current;
            },
            { env },
            { operationLabel: "doctor.subagent-completion-bindings" },
          ),
      });
    }
    note(describeBindings(result, params.shouldRepair), "Subagent completion bindings");
    if (result.leftAmbiguous + result.leftUnbound > 0) {
      note(
        "Completions without an unambiguous owner were left unchanged. No new recovery binding was written for these rows; investigate task/run ownership before retrying.",
        "Doctor warnings",
      );
    } else if (!params.shouldRepair && result.bindings.length > 0) {
      note(
        `Stop the Gateway, run ${formatCliCommand("openclaw doctor --fix")}, then restart it.`,
        "Doctor changes available",
      );
    }
  } catch (error) {
    note(
      `Subagent completion bindings were not migrated: ${formatErrorMessage(error)}`,
      "Doctor warnings",
    );
  }
}
