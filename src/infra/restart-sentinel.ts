// Persists restart sentinel state that coordinates deferred restarts.
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type RestartSentinelLog = {
  stdoutTail?: string | null;
  stderrTail?: string | null;
  exitCode?: number | null;
};

type RestartSentinelStep = {
  name: string;
  command: string;
  cwd?: string | null;
  durationMs?: number | null;
  log?: RestartSentinelLog | null;
};

type RestartSentinelStats = {
  mode?: string;
  root?: string;
  requiresRestart?: boolean;
  handoffId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  steps?: RestartSentinelStep[];
  reason?: string | null;
  durationMs?: number | null;
};

export type RestartSentinelContinuation =
  | {
      kind: "systemEvent";
      text: string;
      traceparent?: string;
    }
  | {
      kind: "agentTurn";
      message: string;
      traceparent?: string;
    };

export type RestartSentinelPayload = {
  kind: "config-apply" | "config-auto-recovery" | "config-patch" | "update" | "restart";
  status: "ok" | "error" | "skipped";
  ts: number;
  sessionKey?: string;
  /** Delivery context captured at restart time to ensure channel routing survives restart. */
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
  /** Thread ID for reply threading (e.g., Slack thread_ts). */
  threadId?: string;
  message?: string | null;
  continuation?: RestartSentinelContinuation | null;
  doctorHint?: string | null;
  stats?: RestartSentinelStats | null;
};

type RestartSentinel = {
  version: 1;
  payload: RestartSentinelPayload;
};

const RESTART_SENTINEL_KEY = "current";
const LEGACY_RESTART_SENTINEL_FILENAME = "restart-sentinel.json";
type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;

export function formatDoctorNonInteractiveHint(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return `Recommended follow-up: run ${formatCliCommand(
    "openclaw doctor --non-interactive",
    env,
  )} in a terminal or approvals-capable OpenClaw surface.`;
}

export async function writeRestartSentinel(
  payload: RestartSentinelPayload,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const updatedAtMs = Date.now();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
      executeSqliteQuerySync(
        db,
        stateDb
          .insertInto("gateway_restart_sentinel")
          .values({
            sentinel_key: RESTART_SENTINEL_KEY,
            version: 1,
            kind: payload.kind,
            status: payload.status,
            ts: payload.ts,
            session_key: payload.sessionKey ?? null,
            thread_id: payload.threadId ?? null,
            delivery_channel: payload.deliveryContext?.channel ?? null,
            delivery_to: payload.deliveryContext?.to ?? null,
            delivery_account_id: payload.deliveryContext?.accountId ?? null,
            message: payload.message ?? null,
            continuation_json: payload.continuation ? JSON.stringify(payload.continuation) : null,
            doctor_hint: payload.doctorHint ?? null,
            stats_json: payload.stats ? JSON.stringify(payload.stats) : null,
            payload_json: JSON.stringify(payload),
            updated_at_ms: updatedAtMs,
          })
          .onConflict((conflict) =>
            conflict.column("sentinel_key").doUpdateSet({
              version: (eb) => eb.ref("excluded.version"),
              kind: (eb) => eb.ref("excluded.kind"),
              status: (eb) => eb.ref("excluded.status"),
              ts: (eb) => eb.ref("excluded.ts"),
              session_key: (eb) => eb.ref("excluded.session_key"),
              thread_id: (eb) => eb.ref("excluded.thread_id"),
              delivery_channel: (eb) => eb.ref("excluded.delivery_channel"),
              delivery_to: (eb) => eb.ref("excluded.delivery_to"),
              delivery_account_id: (eb) => eb.ref("excluded.delivery_account_id"),
              message: (eb) => eb.ref("excluded.message"),
              continuation_json: (eb) => eb.ref("excluded.continuation_json"),
              doctor_hint: (eb) => eb.ref("excluded.doctor_hint"),
              stats_json: (eb) => eb.ref("excluded.stats_json"),
              payload_json: (eb) => eb.ref("excluded.payload_json"),
              updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
            }),
          ),
      );
    },
    { env },
  );
  await removeLegacyRestartSentinel(env);
}

function cloneRestartSentinelPayload(payload: RestartSentinelPayload): RestartSentinelPayload {
  return structuredClone(payload);
}

async function rewriteRestartSentinel(
  rewrite: (payload: RestartSentinelPayload) => RestartSentinelPayload | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const current = await readRestartSentinel(env);
  if (!current) {
    return null;
  }
  const nextPayload = rewrite(cloneRestartSentinelPayload(current.payload));
  if (!nextPayload) {
    return null;
  }
  await writeRestartSentinel(nextPayload, env);
  return {
    version: 1,
    payload: nextPayload,
  };
}

export async function finalizeUpdateRestartSentinelRunningVersion(
  version = resolveRuntimeServiceVersion(process.env),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  return await rewriteRestartSentinel((payload) => {
    if (payload.kind !== "update") {
      return null;
    }
    const stats = payload.stats ? { ...payload.stats } : {};
    const after = isPlainRecord(stats.after) ? { ...stats.after } : {};
    if (after.version === version) {
      return null;
    }
    after.version = version;
    stats.after = after;
    return {
      ...payload,
      stats,
    };
  }, env);
}

export async function markUpdateRestartSentinelFailure(
  reason: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  return await rewriteRestartSentinel((payload) => {
    if (payload.kind !== "update") {
      return null;
    }
    const payloadWithoutContinuation = { ...payload };
    delete payloadWithoutContinuation.continuation;
    const stats = payload.stats ? { ...payload.stats } : {};
    stats.reason = reason;
    return {
      ...payloadWithoutContinuation,
      status: "error",
      stats,
    };
  }, env);
}

export async function clearRestartSentinel(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
        executeSqliteQuerySync(
          db,
          stateDb
            .deleteFrom("gateway_restart_sentinel")
            .where("sentinel_key", "=", RESTART_SENTINEL_KEY),
        );
      },
      { env },
    );
  } catch {}
  await removeLegacyRestartSentinel(env);
}

function resolveLegacyRestartSentinelPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), LEGACY_RESTART_SENTINEL_FILENAME);
}

async function removeLegacyRestartSentinel(env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await rm(resolveLegacyRestartSentinelPath(env), { force: true });
  } catch {}
}

async function importLegacyRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const legacyPath = resolveLegacyRestartSentinelPath(env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(legacyPath, "utf-8")) as unknown;
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed) || parsed.version !== 1 || !isPlainRecord(parsed.payload)) {
    await removeLegacyRestartSentinel(env);
    return null;
  }
  const payload = parsed.payload as RestartSentinelPayload;
  await writeRestartSentinel(payload, env);
  await removeLegacyRestartSentinel(env);
  return { version: 1, payload };
}

export function buildRestartSuccessContinuation(params: {
  sessionKey?: string;
  continuationMessage?: string | null;
}): RestartSentinelContinuation | null {
  const message = params.continuationMessage?.trim();
  if (message) {
    return { kind: "agentTurn", message };
  }
  return null;
}

export async function readRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  try {
    const database = openOpenClawStateDatabase({ env });
    const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      stateDb
        .selectFrom("gateway_restart_sentinel")
        .select(["version", "payload_json"])
        .where("sentinel_key", "=", RESTART_SENTINEL_KEY),
    );
    if (!row) {
      return await importLegacyRestartSentinel(env);
    }
    let payload: RestartSentinelPayload | undefined;
    try {
      payload = JSON.parse(row.payload_json) as RestartSentinelPayload | undefined;
    } catch {
      await clearRestartSentinel(env);
      return null;
    }
    if (row.version !== 1 || !payload) {
      await clearRestartSentinel(env);
      return null;
    }
    return { version: 1, payload };
  } catch {
    return null;
  }
}

export async function hasRestartSentinel(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const database = openOpenClawStateDatabase({ env });
    const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      stateDb
        .selectFrom("gateway_restart_sentinel")
        .select("sentinel_key")
        .where("sentinel_key", "=", RESTART_SENTINEL_KEY),
    );
    if (row) {
      return true;
    }
    return Boolean(await importLegacyRestartSentinel(env));
  } catch {
    return false;
  }
}

export function formatRestartSentinelMessage(payload: RestartSentinelPayload): string {
  const message = payload.message?.trim();
  if (message && (!payload.stats || payload.kind === "config-auto-recovery")) {
    return message;
  }
  const lines: string[] = [summarizeRestartSentinel(payload)];
  if (message) {
    lines.push(message);
  }
  const reason = payload.stats?.reason?.trim();
  if (reason && reason !== message) {
    lines.push(`Reason: ${reason}`);
  }
  if (payload.doctorHint?.trim()) {
    lines.push(payload.doctorHint.trim());
  }
  return lines.join("\n");
}

function isRestartRequiredConfigWriteSentinel(payload: RestartSentinelPayload): boolean {
  return (
    (payload.kind === "config-apply" || payload.kind === "config-patch") &&
    payload.status === "ok" &&
    payload.stats?.requiresRestart === true
  );
}

export function summarizeRestartSentinel(payload: RestartSentinelPayload): string {
  if (payload.kind === "config-auto-recovery") {
    return "Gateway auto-recovery";
  }
  if (isRestartRequiredConfigWriteSentinel(payload)) {
    const mode = payload.stats?.mode ? ` (${payload.stats.mode})` : "";
    return `Gateway restart required${mode}`.trim();
  }
  const kind = payload.kind;
  const status = payload.status;
  const mode = payload.stats?.mode ? ` (${payload.stats.mode})` : "";
  const kindSegment = kind === "restart" ? "" : ` ${kind}`;
  return `Gateway restart${kindSegment} ${status}${mode}`.trim();
}

export function trimLogTail(input?: string | null, maxChars = 8000) {
  if (!input) {
    return null;
  }
  const text = input.trimEnd();
  if (text.length <= maxChars) {
    return text;
  }
  return `…${sliceUtf16Safe(text, text.length - maxChars)}`;
}
