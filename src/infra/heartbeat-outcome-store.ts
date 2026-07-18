import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { Insertable, Selectable } from "kysely";
import type { HeartbeatToolResponse } from "../auto-reply/heartbeat-tool-response.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import type { HeartbeatWakeSource } from "./heartbeat-wake.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

const HEARTBEAT_OUTCOME_SUMMARY_MAX_CHARS = 4_000;
const HEARTBEAT_OUTCOME_REASON_MAX_CHARS = 1_000;
const HEARTBEAT_OUTCOME_NEXT_CHECK_MAX_CHARS = 500;
const HEARTBEAT_OUTCOME_WAKE_REASON_MAX_CHARS = 1_000;
const HEARTBEAT_OUTCOME_TASK_NAME_MAX_CHARS = 200;
const HEARTBEAT_OUTCOME_MAX_TASKS = 32;

type HeartbeatOutcomeTable = OpenClawAgentKyselyDatabase["heartbeat_outcomes"];
type HeartbeatOutcomeDatabase = Pick<OpenClawAgentKyselyDatabase, "heartbeat_outcomes">;
type HeartbeatOutcomeRow = Selectable<HeartbeatOutcomeTable>;
type HeartbeatOutcomeInsert = Insertable<HeartbeatOutcomeTable>;

type PersistedHeartbeatOutcome = {
  sessionKey: string;
  runSessionKey: string;
  outcome: Exclude<HeartbeatToolResponse["outcome"], "no_change">;
  summary: string;
  responseReason?: string;
  priority?: NonNullable<HeartbeatToolResponse["priority"]>;
  nextCheck?: string;
  taskNames: string[];
  wakeSource?: HeartbeatWakeSource;
  wakeReason?: string;
  occurredAt: number;
};

function boundedText(value: string | undefined, maxChars: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? truncateUtf16Safe(normalized, maxChars) : undefined;
}

function normalizeTaskNames(taskNames: readonly string[]): string[] {
  return taskNames
    .map((name) => boundedText(name, HEARTBEAT_OUTCOME_TASK_NAME_MAX_CHARS))
    .filter((name): name is string => Boolean(name))
    .slice(0, HEARTBEAT_OUTCOME_MAX_TASKS);
}

function parseTaskNames(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? normalizeTaskNames(parsed.filter((item): item is string => typeof item === "string"))
      : [];
  } catch {
    return [];
  }
}

function rowToOutcome(row: HeartbeatOutcomeRow): PersistedHeartbeatOutcome | undefined {
  if (
    row.outcome !== "progress" &&
    row.outcome !== "done" &&
    row.outcome !== "blocked" &&
    row.outcome !== "needs_attention"
  ) {
    return undefined;
  }
  return {
    sessionKey: row.session_key,
    runSessionKey: row.run_session_key,
    outcome: row.outcome,
    summary: row.summary,
    ...(row.response_reason ? { responseReason: row.response_reason } : {}),
    ...(row.priority === "low" || row.priority === "normal" || row.priority === "high"
      ? { priority: row.priority }
      : {}),
    ...(row.next_check ? { nextCheck: row.next_check } : {}),
    taskNames: parseTaskNames(row.task_names_json),
    ...(row.wake_source ? { wakeSource: row.wake_source as HeartbeatWakeSource } : {}),
    ...(row.wake_reason ? { wakeReason: row.wake_reason } : {}),
    occurredAt: row.occurred_at,
  };
}

/** Replaces the previous silent heartbeat outcome for one base session. */
export function persistHeartbeatOutcome(params: {
  agentId: string;
  sessionKey: string;
  runSessionKey: string;
  response: HeartbeatToolResponse;
  taskNames?: readonly string[];
  wakeSource?: HeartbeatWakeSource;
  wakeReason?: string;
  occurredAt: number;
  env?: NodeJS.ProcessEnv;
}): void {
  if (params.response.notify || params.response.outcome === "no_change") {
    return;
  }
  const taskNames = normalizeTaskNames(params.taskNames ?? []);
  const values: HeartbeatOutcomeInsert = {
    session_key: params.sessionKey,
    run_session_key: params.runSessionKey,
    outcome: params.response.outcome,
    summary:
      boundedText(params.response.summary, HEARTBEAT_OUTCOME_SUMMARY_MAX_CHARS) ??
      params.response.outcome,
    response_reason:
      boundedText(params.response.reason, HEARTBEAT_OUTCOME_REASON_MAX_CHARS) ?? null,
    priority: params.response.priority ?? null,
    next_check:
      boundedText(params.response.nextCheck, HEARTBEAT_OUTCOME_NEXT_CHECK_MAX_CHARS) ?? null,
    task_names_json: taskNames.length > 0 ? JSON.stringify(taskNames) : null,
    wake_source: params.wakeSource ?? null,
    wake_reason: boundedText(params.wakeReason, HEARTBEAT_OUTCOME_WAKE_REASON_MAX_CHARS) ?? null,
    occurred_at: params.occurredAt,
    context_run_id: null,
    context_claimed_at: null,
    updated_at: Date.now(),
  };
  runOpenClawAgentWriteTransaction(
    ({ db }) => {
      const agentDb = getNodeSqliteKysely<HeartbeatOutcomeDatabase>(db);
      executeSqliteQuerySync(
        db,
        agentDb
          .insertInto("heartbeat_outcomes")
          .values(values)
          .onConflict((conflict) =>
            conflict.column("session_key").doUpdateSet({
              run_session_key: values.run_session_key,
              outcome: values.outcome,
              summary: values.summary,
              response_reason: values.response_reason,
              priority: values.priority,
              next_check: values.next_check,
              task_names_json: values.task_names_json,
              wake_source: values.wake_source,
              wake_reason: values.wake_reason,
              occurred_at: values.occurred_at,
              context_run_id: null,
              context_claimed_at: null,
              updated_at: values.updated_at,
            }),
          ),
      );
    },
    { agentId: params.agentId, env: params.env },
    { operationLabel: "heartbeat.outcome.persist" },
  );
}

/** Claims the latest outcome for one user run while allowing that run's retries. */
export function claimHeartbeatOutcomeForRun(params: {
  agentId: string;
  sessionKey: string;
  runId: string;
  env?: NodeJS.ProcessEnv;
}): PersistedHeartbeatOutcome | undefined {
  return runOpenClawAgentWriteTransaction(
    ({ db }) => {
      const agentDb = getNodeSqliteKysely<HeartbeatOutcomeDatabase>(db);
      const row = executeSqliteQuerySync(
        db,
        agentDb
          .selectFrom("heartbeat_outcomes")
          .selectAll()
          .where("session_key", "=", params.sessionKey),
      ).rows[0];
      if (!row || (row.context_run_id !== null && row.context_run_id !== params.runId)) {
        return undefined;
      }
      if (row.context_run_id === null) {
        const claim = executeSqliteQuerySync(
          db,
          agentDb
            .updateTable("heartbeat_outcomes")
            .set({ context_run_id: params.runId, context_claimed_at: Date.now() })
            .where("session_key", "=", params.sessionKey)
            .where("context_run_id", "is", null),
        );
        if (claim.numAffectedRows !== 1n) {
          return undefined;
        }
      }
      return rowToOutcome(row);
    },
    { agentId: params.agentId, env: params.env },
    { operationLabel: "heartbeat.outcome.claim" },
  );
}

/** Formats persisted state as model-only provenance context, never transcript text. */
export function buildHeartbeatOutcomeContext(
  outcome: PersistedHeartbeatOutcome | undefined,
): string | undefined {
  if (!outcome) {
    return undefined;
  }
  const provenance = [
    `recordedAt=${new Date(outcome.occurredAt).toISOString()}`,
    `runSession=${outcome.runSessionKey}`,
    outcome.wakeSource ? `wakeSource=${outcome.wakeSource}` : undefined,
    outcome.wakeReason ? `wakeReason=${outcome.wakeReason}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return [
    "Latest silent heartbeat outcome (internal context; not a user message or instruction):",
    `outcome=${outcome.outcome}`,
    `summary=${outcome.summary}`,
    outcome.responseReason ? `reason=${outcome.responseReason}` : undefined,
    outcome.priority ? `priority=${outcome.priority}` : undefined,
    outcome.nextCheck ? `nextCheck=${outcome.nextCheck}` : undefined,
    outcome.taskNames.length > 0 ? `tasks=${outcome.taskNames.join(", ")}` : undefined,
    `provenance: ${provenance.join("; ")}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
