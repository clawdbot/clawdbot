// Persists restart sentinel state that coordinates deferred restarts.
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatCliCommand } from "../cli/command-format.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { formatErrorMessage } from "./errors.js";
import {
  deleteRestartSentinelRowSync,
  readRestartSentinelRowSync,
  writeRestartSentinelRowIfRevisionSync,
  writeRestartSentinelRowSync,
  type RestartSentinel,
  type RestartSentinelContinuation,
  type RestartSentinelPayload,
} from "./restart-sentinel-store.js";

export type {
  RestartSentinelContinuation,
  RestartSentinelPayload,
} from "./restart-sentinel-store.js";

const sentinelLog = createSubsystemLogger("restart-sentinel");

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
): Promise<RestartSentinel> {
  return runOpenClawStateWriteTransaction(
    ({ db }) => writeRestartSentinelRowSync(db, payload),
    { env },
    { operationLabel: "restart-sentinel.write" },
  );
}

function cloneRestartSentinelPayload(payload: RestartSentinelPayload): RestartSentinelPayload {
  return structuredClone(payload);
}

async function rewriteRestartSentinel(
  rewrite: (payload: RestartSentinelPayload) => RestartSentinelPayload | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = readRestartSentinelRowSync(db);
      if (current.kind !== "valid") {
        return null;
      }
      const nextPayload = rewrite(cloneRestartSentinelPayload(current.sentinel.payload));
      return nextPayload
        ? writeRestartSentinelRowIfRevisionSync(db, nextPayload, current.sentinel.revision)
        : null;
    },
    { env },
    { operationLabel: "restart-sentinel.rewrite-current" },
  );
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

export async function clearRestartSentinel(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return runOpenClawStateWriteTransaction(
    ({ db }) => deleteRestartSentinelRowSync(db),
    { env },
    { operationLabel: "restart-sentinel.clear" },
  );
}

export async function clearRestartSentinelIfRevision(
  expectedRevision: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return runOpenClawStateWriteTransaction(
    ({ db }) => deleteRestartSentinelRowSync(db, expectedRevision),
    { env },
    { operationLabel: "restart-sentinel.clear-if-revision" },
  );
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
    const current = readRestartSentinelRowSync(database.db);
    if (current.kind === "invalid") {
      sentinelLog.warn("Ignoring invalid typed restart sentinel row");
      return null;
    }
    return current.kind === "valid" ? current.sentinel : null;
  } catch (err) {
    sentinelLog.warn(`Failed to read restart sentinel: ${formatErrorMessage(err)}`);
    return null;
  }
}

export async function hasRestartSentinel(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const database = openOpenClawStateDatabase({ env });
    const current = readRestartSentinelRowSync(database.db);
    if (current.kind === "invalid") {
      sentinelLog.warn("Ignoring invalid typed restart sentinel row");
      return false;
    }
    return current.kind === "valid";
  } catch (err) {
    sentinelLog.warn(`Failed to check restart sentinel: ${formatErrorMessage(err)}`);
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
