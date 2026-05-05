/**
 * Post-restart recovery for main sessions interrupted while holding a transcript lock.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  type SessionEntry,
  loadSessionStore,
  resolveSessionFilePath,
  resolveSessionTranscriptPathInDir,
  updateSessionStore,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { readSessionMessagesAsync } from "../gateway/session-utils.fs.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CommandLane } from "../process/lanes.js";
import { isAcpSessionKey, isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { resolveAgentSessionDirs } from "./session-dirs.js";
import type { SessionLockInspection } from "./session-write-lock.js";

const log = createSubsystemLogger("main-session-restart-recovery");

const DEFAULT_RECOVERY_DELAY_MS = 5_000;
const MAX_RECOVERY_RETRIES = 3;
const RETRY_BACKOFF_MULTIPLIER = 2;

function shouldSkipMainRecovery(entry: SessionEntry, sessionKey: string): boolean {
  if (typeof entry.spawnDepth === "number" && entry.spawnDepth > 0) {
    return true;
  }
  if (entry.subagentRole != null) {
    return true;
  }
  return (
    isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) || isAcpSessionKey(sessionKey)
  );
}

function normalizeTranscriptLockPath(lockPath: string): string | undefined {
  const trimmed = lockPath.trim();
  if (!path.basename(trimmed).endsWith(".jsonl.lock")) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function resolveEntryTranscriptLockPaths(params: {
  entry: SessionEntry;
  sessionsDir: string;
}): string[] {
  const paths = new Set<string>();
  const push = (resolvePath: () => string) => {
    try {
      paths.add(path.resolve(`${resolvePath()}.lock`));
    } catch {
      // Keep restart recovery best-effort when session metadata is stale.
    }
  };
  push(() =>
    resolveSessionFilePath(params.entry.sessionId, params.entry, {
      sessionsDir: params.sessionsDir,
    }),
  );
  push(() => resolveSessionTranscriptPathInDir(params.entry.sessionId, params.sessionsDir));
  return [...paths];
}

function getMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function isMeaningfulTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  if (!role || role === "system") {
    return false;
  }
  return true;
}

function isResumableTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  return role === "user" || role === "tool" || role === "toolResult";
}

function isApprovalPendingToolResult(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "toolResult") {
    return false;
  }
  const details = (message as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return false;
  }
  return (details as { status?: unknown }).status === "approval-pending";
}

function resolveMainSessionResumeBlockReason(messages: unknown[]): string | null {
  const lastMeaningful = messages.toReversed().find(isMeaningfulTailMessage);
  if (!lastMeaningful || !isResumableTailMessage(lastMeaningful)) {
    return "transcript tail is not resumable";
  }
  if (isApprovalPendingToolResult(lastMeaningful)) {
    return "transcript tail is a stale approval-pending tool result";
  }
  return null;
}

function buildResumeMessage(pendingFinalDeliveryText?: string | null): string {
  const base =
    "[System] Your previous turn was interrupted by a gateway restart while " +
    "OpenClaw was waiting on tool/model work. Continue from the existing " +
    "transcript and finish the interrupted response.";
  if (pendingFinalDeliveryText) {
    return `${base}\n\nNote: The interrupted final reply was captured: "${pendingFinalDeliveryText}"`;
  }
  return base;
}

async function markSessionFailed(params: {
  storePath: string;
  sessionKey: string;
  reason: string;
}): Promise<void> {
  await updateSessionStore(
    params.storePath,
    (store) => {
      const entry = store[params.sessionKey];
      if (!entry || entry.status !== "running") {
        return;
      }
      entry.status = "failed";
      entry.abortedLastRun = true;
      entry.endedAt = Date.now();
      entry.updatedAt = entry.endedAt;
      entry.pendingFinalDelivery = undefined;
      entry.pendingFinalDeliveryText = undefined;
      entry.pendingFinalDeliveryCreatedAt = undefined;
      entry.pendingFinalDeliveryLastAttemptAt = undefined;
      entry.pendingFinalDeliveryAttemptCount = undefined;
      entry.pendingFinalDeliveryLastError = undefined;
      entry.pendingFinalDeliveryContext = undefined;
      store[params.sessionKey] = entry;
    },
    { skipMaintenance: true },
  );
  log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
}

async function resumeMainSession(params: {
  storePath: string;
  sessionKey: string;
  pendingFinalDeliveryText?: string | null;
}): Promise<boolean> {
  try {
    await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: buildResumeMessage(params.pendingFinalDeliveryText),
        sessionKey: params.sessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        lane: CommandLane.Main,
      },
      timeoutMs: 10_000,
    });
    await updateSessionStore(
      params.storePath,
      (store) => {
        const entry = store[params.sessionKey];
        if (!entry) {
          return;
        }
        const now = Date.now();
        entry.abortedLastRun = false;
        entry.updatedAt = now;
        if (entry.pendingFinalDelivery || entry.pendingFinalDeliveryText) {
          entry.pendingFinalDeliveryLastAttemptAt = now;
          entry.pendingFinalDeliveryAttemptCount =
            (entry.pendingFinalDeliveryAttemptCount ?? 0) + 1;
          entry.pendingFinalDeliveryLastError = null;
        }
        store[params.sessionKey] = entry;
      },
      { skipMaintenance: true },
    );
    log.info(
      `resumed interrupted main session: ${params.sessionKey}${
        params.pendingFinalDeliveryText ? " (with pending payload)" : ""
      }`,
    );
    return true;
  } catch (err) {
    log.warn(`failed to resume interrupted main session ${params.sessionKey}: ${String(err)}`);
    return false;
  }
}

export async function markRestartAbortedMainSessionsFromLocks(params: {
  sessionsDir: string;
  cleanedLocks: SessionLockInspection[];
}): Promise<{ marked: number; skipped: number }> {
  const result = { marked: 0, skipped: 0 };
  const sessionsDir = path.resolve(params.sessionsDir);
  const interruptedLockPaths = new Set(
    params.cleanedLocks
      .map((lock) => normalizeTranscriptLockPath(lock.lockPath))
      .filter((lockPath): lockPath is string => Boolean(lockPath)),
  );
  if (interruptedLockPaths.size === 0) {
    return result;
  }

  const storePath = path.join(sessionsDir, "sessions.json");
  await updateSessionStore(
    storePath,
    (store) => {
      for (const [sessionKey, entry] of Object.entries(store)) {
        if (!entry || entry.status !== "running") {
          continue;
        }
        if (shouldSkipMainRecovery(entry, sessionKey)) {
          result.skipped++;
          continue;
        }
        const entryLockPaths = resolveEntryTranscriptLockPaths({ entry, sessionsDir });
        if (!entryLockPaths.some((lockPath) => interruptedLockPaths.has(lockPath))) {
          continue;
        }
        entry.abortedLastRun = true;
        store[sessionKey] = entry;
        result.marked++;
      }
    },
    { skipMaintenance: true },
  );

  if (result.marked > 0) {
    log.warn(`marked ${result.marked} interrupted main session(s) from stale transcript locks`);
  }
  return result;
}

async function recoverStore(params: {
  storePath: string;
  resumedSessionKeys: Set<string>;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  let store: Record<string, SessionEntry>;
  try {
    store = loadSessionStore(params.storePath);
  } catch (err) {
    log.warn(`failed to load session store ${params.storePath}: ${String(err)}`);
    result.failed++;
    return result;
  }

  for (const [sessionKey, entry] of Object.entries(store).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!entry || entry.status !== "running" || entry.abortedLastRun !== true) {
      continue;
    }
    if (shouldSkipMainRecovery(entry, sessionKey)) {
      result.skipped++;
      continue;
    }
    if (params.resumedSessionKeys.has(sessionKey)) {
      result.skipped++;
      continue;
    }

    let messages: unknown[];
    try {
      messages = await readSessionMessagesAsync(
        entry.sessionId,
        params.storePath,
        entry.sessionFile,
        {
          mode: "recent",
          maxMessages: 20,
          maxBytes: 256 * 1024,
        },
      );
    } catch (err) {
      log.warn(`failed to read transcript for ${sessionKey}: ${String(err)}`);
      result.failed++;
      continue;
    }

    const resumeBlockReason = resolveMainSessionResumeBlockReason(messages);
    if (resumeBlockReason) {
      await markSessionFailed({
        storePath: params.storePath,
        sessionKey,
        reason: resumeBlockReason,
      });
      result.failed++;
      continue;
    }

    const resumed = await resumeMainSession({
      storePath: params.storePath,
      sessionKey,
      pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
    });
    if (resumed) {
      params.resumedSessionKeys.add(sessionKey);
      result.recovered++;
    } else {
      result.failed++;
    }
  }

  return result;
}

export async function recoverRestartAbortedMainSessions(
  params: {
    stateDir?: string;
    resumedSessionKeys?: Set<string>;
  } = {},
): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const resumedSessionKeys = params.resumedSessionKeys ?? new Set<string>();
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  const sessionDirs = await resolveAgentSessionDirs(stateDir);

  for (const sessionsDir of sessionDirs) {
    const storeResult = await recoverStore({
      storePath: path.join(sessionsDir, "sessions.json"),
      resumedSessionKeys,
    });
    result.recovered += storeResult.recovered;
    result.failed += storeResult.failed;
    result.skipped += storeResult.skipped;
  }

  if (result.recovered > 0 || result.failed > 0) {
    log.info(
      `main-session restart recovery complete: recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`,
    );
  }
  return result;
}

export function scheduleRestartAbortedMainSessionRecovery(
  params: {
    delayMs?: number;
    maxRetries?: number;
    stateDir?: string;
  } = {},
): void {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
  const resumedSessionKeys = new Set<string>();

  const attemptRecovery = (attempt: number, delay: number) => {
    setTimeout(() => {
      void recoverRestartAbortedMainSessions({
        stateDir: params.stateDir,
        resumedSessionKeys,
      })
        .then((result) => {
          if (result.failed > 0 && attempt < maxRetries) {
            attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
          }
        })
        .catch((err) => {
          if (attempt < maxRetries) {
            log.warn(`main-session restart recovery failed: ${String(err)}`);
            attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
          } else {
            log.warn(`main-session restart recovery gave up: ${String(err)}`);
          }
        });
    }, delay).unref?.();
  };

  attemptRecovery(1, initialDelay);
}
