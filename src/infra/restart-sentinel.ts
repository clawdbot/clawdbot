// Persists restart sentinel state that coordinates deferred restarts.
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatCliCommand } from "../cli/command-format.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { formatErrorMessage } from "./errors.js";
import { resolveCommitHash } from "./git-commit.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import {
  deleteRestartSentinelRowSync,
  readRestartSentinelRowSync,
  readUpdateInstallReceiptRowSync,
  writeRestartSentinelRowIfRevisionSync,
  writeRestartSentinelRowSync,
  writeUpdateInstallReceiptRowSync,
  type RestartSentinel,
  type RestartSentinelContinuation,
  type RestartSentinelPayload,
} from "./restart-sentinel-store.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";

export type {
  RestartSentinelContinuation,
  RestartSentinelPayload,
} from "./restart-sentinel-store.js";

export type VerifiedGitUpdateReceipt = {
  root: string;
  sha: string;
  upstreamRef?: string;
  installedAtMs: number;
};

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

function commitsMatch(expected: string, actual: string): boolean {
  const normalizedExpected = expected.trim().toLowerCase();
  const normalizedActual = actual.trim().toLowerCase();
  return (
    normalizedExpected.length >= 7 &&
    normalizedActual.length >= 7 &&
    (normalizedExpected.startsWith(normalizedActual) ||
      normalizedActual.startsWith(normalizedExpected))
  );
}

export async function finalizeUpdateRestartSentinelRunningVersion(
  version = resolveRuntimeServiceVersion(process.env),
  env: NodeJS.ProcessEnv = process.env,
  commit = resolveCommitHash({ env, moduleUrl: import.meta.url }),
  runningRoot?: string | null,
): Promise<RestartSentinel | null> {
  const snapshot = await readRestartSentinel(env);
  if (!snapshot || snapshot.payload.kind !== "update") {
    return null;
  }
  const snapshotRoot = snapshot.payload.stats?.root;
  const expectedRoot =
    typeof snapshotRoot === "string" ? resolveUpdateInstallRoot(snapshotRoot) : null;
  const discoveredRoot = expectedRoot
    ? (runningRoot ??
      (await resolveOpenClawPackageRoot({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
      })))
    : null;
  const actualRoot = discoveredRoot ? resolveUpdateInstallRoot(discoveredRoot) : null;

  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = readRestartSentinelRowSync(db);
      if (
        current.kind !== "valid" ||
        current.sentinel.revision !== snapshot.revision ||
        current.sentinel.payload.kind !== "update"
      ) {
        return null;
      }

      const payload = cloneRestartSentinelPayload(current.sentinel.payload);
      const stats = payload.stats ? { ...payload.stats } : {};
      const after = isPlainRecord(stats.after) ? { ...stats.after } : {};
      let changed = false;
      if (after.version !== version) {
        after.version = version;
        changed = true;
      }
      if (expectedRoot && stats.root !== expectedRoot) {
        stats.root = expectedRoot;
        changed = true;
      }

      const before = isPlainRecord(stats.before) ? stats.before : {};
      const beforeSha = typeof before.sha === "string" ? before.sha.trim() : "";
      const expectedSha = typeof after.sha === "string" ? after.sha.trim() : "";
      const actualSha = commit?.trim() ?? "";
      const verifiesGitRevision =
        stats.mode !== "git" || (expectedSha.length > 0 && commitsMatch(expectedSha, actualSha));
      const verifiesInstallRoot =
        expectedRoot !== null && actualRoot !== null && expectedRoot === actualRoot;
      const changedInstall =
        stats.mode !== "git" ||
        (beforeSha.length > 0 && expectedSha.length > 0 && !commitsMatch(beforeSha, expectedSha));
      if (payload.status === "ok" && expectedRoot && !verifiesInstallRoot) {
        payload.status = "error";
        stats.reason = actualRoot ? "restart-root-mismatch" : "restart-root-unavailable";
        delete payload.continuation;
        changed = true;
      } else if (
        payload.status === "ok" &&
        stats.mode === "git" &&
        expectedSha &&
        !verifiesGitRevision
      ) {
        payload.status = "error";
        stats.reason = actualSha ? "restart-revision-mismatch" : "restart-revision-unavailable";
        delete payload.continuation;
        changed = true;
      }

      stats.after = after;
      payload.stats = stats;
      const finalized = changed
        ? writeRestartSentinelRowIfRevisionSync(db, payload, current.sentinel.revision)
        : current.sentinel;
      if (!finalized) {
        return null;
      }
      // This receipt records the install fact proven by the running process. Post-install
      // failures such as managed-service-handoff-failed keep the sentinel in error without
      // erasing the upstream fallback for campaign-managed detached installs (#121634).
      if (stats.mode === "git" && verifiesInstallRoot && verifiesGitRevision && changedInstall) {
        writeUpdateInstallReceiptRowSync(db, payload);
      }
      return changed ? finalized : null;
    },
    { env },
    { operationLabel: "restart-sentinel.finalize-running-install" },
  );
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

/** Read the restart sentinel without creating or mutating shared state. */
export async function readRestartSentinelReadOnly(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  try {
    const current = withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readRestartSentinelRowSync(db),
      { env },
    );
    if (!current || current.kind === "missing") {
      return null;
    }
    if (current.kind === "invalid") {
      sentinelLog.warn("Ignoring invalid typed restart sentinel row");
      return null;
    }
    return current.sentinel;
  } catch (err) {
    sentinelLog.warn(`Failed to read restart sentinel: ${formatErrorMessage(err)}`);
    return null;
  }
}

async function readUpdateInstallReceiptPayload(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinelPayload | null> {
  try {
    const database = openOpenClawStateDatabase({ env });
    return readUpdateInstallReceiptRowSync(database.db)?.payload ?? null;
  } catch (err) {
    sentinelLog.warn(`Failed to read update install receipt: ${formatErrorMessage(err)}`);
    return null;
  }
}

function normalizeVerifiedGitUpdateReceipt(
  payload: RestartSentinelPayload | null,
): VerifiedGitUpdateReceipt | null {
  // Receipt rows are only written after the running install verifies root and revision.
  // An error status records a post-install failure, not an untrusted install.
  if (
    payload?.kind !== "update" ||
    payload.stats?.mode !== "git" ||
    !isPlainRecord(payload.stats.after)
  ) {
    return null;
  }
  const root = typeof payload.stats.root === "string" ? payload.stats.root.trim() : "";
  const sha = typeof payload.stats.after.sha === "string" ? payload.stats.after.sha.trim() : "";
  if (!root || !sha) {
    return null;
  }
  const upstreamRef =
    typeof payload.stats.after.upstreamRef === "string"
      ? payload.stats.after.upstreamRef.trim()
      : "";
  return {
    root,
    sha,
    ...(upstreamRef ? { upstreamRef } : {}),
    installedAtMs: payload.ts,
  };
}

export async function readVerifiedGitUpdateReceipt(
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedGitUpdateReceipt | null> {
  return normalizeVerifiedGitUpdateReceipt(await readUpdateInstallReceiptPayload(env));
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
