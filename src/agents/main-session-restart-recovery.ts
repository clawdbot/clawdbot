/**
 * Post-restart recovery for main sessions interrupted while holding a transcript lock.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizePendingFinalDeliveryText } from "../auto-reply/reply/pending-final-delivery.js";
import { resolveStateDir } from "../config/paths.js";
import {
  type RestartRecoveryRun,
  type SessionEntry,
  loadSessionStore,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionFilePath,
  resolveSessionTranscriptPathInDir,
} from "../config/sessions.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { readSessionMessagesAsync } from "../gateway/session-transcript-readers.js";
import { resolveGatewaySessionStoreTarget } from "../gateway/session-utils.js";
import {
  getAgentEventLifecycleGeneration,
  listAgentRunsForSession,
} from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { CommandLane } from "../process/lanes.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import {
  deliveryContextFromSession,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import {
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "./embedded-agent-runner/run-state.js";
import { resolveAgentSessionDirs } from "./session-dirs.js";
import type { SessionLockInspection } from "./session-write-lock.js";

const log = createSubsystemLogger("main-session-restart-recovery");

const DEFAULT_RECOVERY_DELAY_MS = 5_000;
const MAX_RECOVERY_RETRIES = 3;
const RETRY_BACKOFF_MULTIPLIER = 2;
const UNRESUMABLE_SESSION_NOTICE =
  "I was interrupted by a gateway restart and couldn't safely resume the previous turn. " +
  "Please send that last request again and I'll pick it up cleanly.";

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

function normalizeStringSet(values: Iterable<string> | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return normalized;
}

function normalizeFiniteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasCurrentProcessOwner(params: {
  activeSessionIds: Set<string>;
  activeSessionKeys: Set<string>;
  entry: SessionEntry;
  sessionKey: string;
}): boolean {
  if (params.activeSessionIds.has(params.entry.sessionId)) {
    return true;
  }
  return params.activeSessionIds.size === 0 && params.activeSessionKeys.has(params.sessionKey);
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

export async function markRestartAbortedMainSessions(params: {
  cfg?: OpenClawConfig;
  additionalCfgs?: Iterable<OpenClawConfig | undefined>;
  stateDir?: string;
  sessionKeys?: Iterable<string>;
  sessionIds?: Iterable<string>;
  activeRuns?: Iterable<
    RestartRecoveryRun & {
      sessionKey: string;
      sessionId: string;
      observedAt?: number;
    }
  >;
  isActiveRun?: (
    run: RestartRecoveryRun & {
      sessionKey: string;
      sessionId: string;
      observedAt?: number;
    },
  ) => boolean;
  reason?: string;
}): Promise<{ marked: number; skipped: number }> {
  const sessionKeys = normalizeStringSet(params.sessionKeys);
  const sessionIds = normalizeStringSet(params.sessionIds);
  const preferSessionIdMatch = sessionIds.size > 0;
  const activeRuns = [...(params.activeRuns ?? [])]
    .map((run) => ({
      runId: run.runId.trim(),
      lifecycleGeneration: run.lifecycleGeneration.trim(),
      sessionKey: run.sessionKey.trim(),
      sessionId: run.sessionId.trim(),
      observedAt: normalizeFiniteTimestamp(run.observedAt),
    }))
    .filter((run) => run.runId && run.lifecycleGeneration && (run.sessionKey || run.sessionId));
  const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
  const result = { marked: 0, skipped: 0 };
  if (sessionKeys.size === 0 && sessionIds.size === 0) {
    return result;
  }

  const storePaths = new Set<string>();
  const env =
    params.stateDir === undefined
      ? process.env
      : { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const stateDir = resolveStateDir(env);
  const configs = [params.cfg, ...(params.additionalCfgs ?? [])].filter(
    (cfg): cfg is OpenClawConfig => Boolean(cfg),
  );
  for (const cfg of configs) {
    try {
      for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
        storePaths.add(path.resolve(target.storePath));
      }
    } catch (err) {
      log.warn(`failed to resolve configured session stores for restart marker: ${String(err)}`);
    }
    for (const sessionKey of sessionKeys) {
      try {
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key: sessionKey,
        });
        storePaths.add(path.resolve(target.storePath));
        for (const storeKey of target.storeKeys) {
          const trimmed = storeKey.trim();
          if (trimmed) {
            sessionKeys.add(trimmed);
          }
        }
      } catch (err) {
        log.warn(
          `failed to resolve session store for restart marker ${sessionKey}: ${String(err)}`,
        );
      }
    }
  }

  for (const sessionsDir of await resolveAgentSessionDirs(stateDir)) {
    storePaths.add(path.join(sessionsDir, "sessions.json"));
  }

  for (const storePath of storePaths) {
    const storeResult = await applySessionEntryReplacements({
      storePath,
      requireWriteSuccess: true,
      update: (entries) => {
        const replacements: Array<{ sessionKey: string; entry: SessionEntry }> = [];
        const counts = { marked: 0, skipped: 0 };
        for (const { sessionKey, entry } of entries) {
          const registeredActiveRuns = listAgentRunsForSession({
            sessionKey,
            sessionId: entry.sessionId,
          });
          const matchingActiveRuns = activeRuns.filter(
            (run) =>
              (run.sessionId ? run.sessionId === entry.sessionId : run.sessionKey === sessionKey) &&
              (entry.status === "running" ||
                run.observedAt === undefined ||
                normalizeFiniteTimestamp(entry.updatedAt) === undefined ||
                (entry.updatedAt < run.observedAt &&
                  run.lifecycleGeneration !== currentLifecycleGeneration)) &&
              params.isActiveRun?.(run) !== false,
          );
          if (
            entry.status !== "running" &&
            matchingActiveRuns.length === 0 &&
            registeredActiveRuns.length === 0
          ) {
            continue;
          }
          const matches =
            typeof entry.sessionId === "string" && sessionIds.has(entry.sessionId)
              ? true
              : !preferSessionIdMatch && sessionKeys.has(sessionKey);
          if (!matches) {
            continue;
          }
          if (shouldSkipMainRecovery(entry, sessionKey)) {
            counts.skipped++;
            continue;
          }
          const wasRunning = entry.status === "running";
          entry.status = "running";
          entry.abortedLastRun = true;
          if (!wasRunning) {
            entry.startedAt = undefined;
            entry.endedAt = undefined;
            entry.runtimeMs = undefined;
          }
          const recoveryRuns = new Map<string, RestartRecoveryRun>();
          for (const run of entry.restartRecoveryRuns ?? []) {
            if (run.lifecycleGeneration === currentLifecycleGeneration) {
              recoveryRuns.set(`${run.runId}\u0000${run.lifecycleGeneration}`, run);
            }
          }
          const replaceActiveRunMarker = (run: RestartRecoveryRun) => {
            for (const [key, existingRun] of recoveryRuns) {
              if (existingRun.runId === run.runId) {
                recoveryRuns.delete(key);
              }
            }
            recoveryRuns.set(`${run.runId}\u0000${run.lifecycleGeneration}`, run);
          };
          for (const run of registeredActiveRuns) {
            replaceActiveRunMarker(run);
          }
          for (const run of matchingActiveRuns) {
            replaceActiveRunMarker({
              runId: run.runId,
              lifecycleGeneration: run.lifecycleGeneration,
            });
          }
          entry.restartRecoveryRuns = [...recoveryRuns.values()].toSorted((a, b) =>
            a.runId === b.runId
              ? a.lifecycleGeneration.localeCompare(b.lifecycleGeneration)
              : a.runId.localeCompare(b.runId),
          );
          entry.updatedAt = Date.now();
          replacements.push({ sessionKey, entry });
          counts.marked++;
        }
        return { result: counts, replacements };
      },
    });
    result.marked += storeResult.marked;
    result.skipped += storeResult.skipped;
  }

  if (result.marked > 0) {
    log.warn(
      `marked ${result.marked} interrupted main session(s) for restart recovery${
        params.reason ? ` (${params.reason})` : ""
      }`,
    );
  }
  return result;
}

export async function markStartupOrphanedMainSessionsForRecovery(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  updatedBeforeMs?: number;
}): Promise<{ marked: number; skipped: number }> {
  const result = { marked: 0, skipped: 0 };
  const providedActiveSessionIds =
    params.activeSessionIds === undefined ? undefined : normalizeStringSet(params.activeSessionIds);
  const providedActiveSessionKeys =
    params.activeSessionKeys === undefined
      ? undefined
      : normalizeStringSet(params.activeSessionKeys);
  const updatedBeforeMs = normalizeFiniteTimestamp(params.updatedBeforeMs);
  const resolveActiveSessionIds = () =>
    providedActiveSessionIds ?? normalizeStringSet(listActiveEmbeddedRunSessionIds());
  const resolveActiveSessionKeys = () =>
    providedActiveSessionKeys ?? normalizeStringSet(listActiveEmbeddedRunSessionKeys());

  for (const storePath of await resolveRestartRecoveryStorePaths(params)) {
    const storeResult = await applySessionEntryReplacements({
      storePath,
      update: (entries) => {
        const replacements: Array<{ sessionKey: string; entry: SessionEntry }> = [];
        const counts = { marked: 0, skipped: 0 };
        for (const { sessionKey, entry } of entries) {
          if (entry.status !== "running" || entry.abortedLastRun === true) {
            continue;
          }
          if (shouldSkipMainRecovery(entry, sessionKey)) {
            counts.skipped++;
            continue;
          }
          const updatedAt = normalizeFiniteTimestamp(entry.updatedAt);
          if (
            updatedBeforeMs !== undefined &&
            updatedAt !== undefined &&
            updatedAt > updatedBeforeMs
          ) {
            continue;
          }
          if (
            hasCurrentProcessOwner({
              activeSessionIds: resolveActiveSessionIds(),
              activeSessionKeys: resolveActiveSessionKeys(),
              entry,
              sessionKey,
            })
          ) {
            continue;
          }
          entry.abortedLastRun = true;
          entry.updatedAt = Date.now();
          replacements.push({ sessionKey, entry });
          counts.marked++;
        }
        return { result: counts, replacements };
      },
    });
    result.marked += storeResult.marked;
    result.skipped += storeResult.skipped;
  }

  if (result.marked > 0) {
    log.warn(`marked ${result.marked} startup-orphaned main session(s) for restart recovery`);
  }
  return result;
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
  const sanitizedPendingText =
    typeof pendingFinalDeliveryText === "string"
      ? sanitizePendingFinalDeliveryText(pendingFinalDeliveryText)
      : "";
  if (sanitizedPendingText) {
    return `${base}\n\nNote: The interrupted final reply was captured: "${sanitizedPendingText}"`;
  }
  return base;
}

async function markSessionFailed(params: {
  storePath: string;
  sessionKey: string;
  reason: string;
}): Promise<void> {
  await applySessionEntryReplacements({
    storePath: params.storePath,
    update: (entries) => {
      const current = entries.find((entry) => entry.sessionKey === params.sessionKey);
      const entry = current?.entry;
      if (!entry || entry.status !== "running") {
        return { result: undefined };
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
      entry.restartRecoveryDeliveryContext = undefined;
      entry.restartRecoveryDeliveryRunId = undefined;
      return {
        result: undefined,
        replacements: [{ sessionKey: params.sessionKey, entry }],
      };
    },
  });
  log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
}

async function sendUnresumableSessionNotice(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  reason: string;
  sessionKey: string;
}): Promise<boolean> {
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    includeSessionDeliveryFallback: true,
    sessionKey: params.sessionKey,
  });
  if (!deliveryContext) {
    return false;
  }

  const messageParams: Record<string, unknown> = {
    to: deliveryContext.to,
    message: UNRESUMABLE_SESSION_NOTICE,
    bestEffort: true,
  };
  if (deliveryContext?.threadId != null) {
    messageParams.threadId = deliveryContext.threadId;
  }
  const actionParams: Record<string, unknown> = {
    channel: deliveryContext.channel,
    action: "send",
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    idempotencyKey: `main-session-restart-recovery:${params.entry.sessionId}:failed-notice`,
    params: messageParams,
  };
  const accountId = normalizeOptionalString(deliveryContext?.accountId);
  if (accountId) {
    actionParams.accountId = accountId;
  }

  try {
    await callGateway({
      method: "message.action",
      params: actionParams,
      timeoutMs: 10_000,
    });
    log.info(
      `sent interrupted main session recovery notice: ${params.sessionKey} (${params.reason})`,
    );
    return true;
  } catch (err) {
    log.warn(
      `failed to send interrupted main session recovery notice ${params.sessionKey}: ${String(err)}`,
    );
    return false;
  }
}

function resolveRestartRecoveryDeliveryContext(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  includeSessionDeliveryFallback?: boolean;
  sessionKey: string;
}): DeliveryContext | undefined {
  const deliveryContext =
    normalizeDeliveryContext(params.entry.pendingFinalDeliveryContext) ??
    normalizeDeliveryContext(params.entry.restartRecoveryDeliveryContext) ??
    (params.includeSessionDeliveryFallback ? deliveryContextFromSession(params.entry) : undefined);
  const channel = normalizeOptionalString(deliveryContext?.channel);
  const to = normalizeOptionalString(deliveryContext?.to);
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  if (
    params.cfg &&
    resolveSendPolicy({
      cfg: params.cfg,
      entry: params.entry,
      sessionKey: params.sessionKey,
      channel,
      chatType: params.entry.chatType,
    }) === "deny"
  ) {
    return undefined;
  }
  return {
    ...deliveryContext,
    channel,
    to,
  };
}

async function resumeMainSession(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  storePath: string;
  sessionKey: string;
  pendingFinalDeliveryText?: string | null;
}): Promise<boolean> {
  const sanitizedPendingText =
    typeof params.pendingFinalDeliveryText === "string"
      ? sanitizePendingFinalDeliveryText(params.pendingFinalDeliveryText)
      : "";
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    sessionKey: params.sessionKey,
  });
  try {
    const agentParams: Record<string, unknown> = {
      message: buildResumeMessage(sanitizedPendingText),
      sessionKey: params.sessionKey,
      idempotencyKey: crypto.randomUUID(),
      deliver: Boolean(deliveryContext),
      lane: CommandLane.Main,
    };
    if (deliveryContext) {
      agentParams.channel = deliveryContext.channel;
      agentParams.to = deliveryContext.to;
      agentParams.bestEffortDeliver = true;
      if (deliveryContext.accountId) {
        agentParams.accountId = deliveryContext.accountId;
      }
      if (deliveryContext.threadId != null) {
        agentParams.threadId = String(deliveryContext.threadId);
      }
    }
    await callGateway<{ runId: string }>({
      method: "agent",
      params: agentParams,
      timeoutMs: 10_000,
    });
    await applySessionEntryReplacements({
      storePath: params.storePath,
      update: (entries) => {
        const current = entries.find((entry) => entry.sessionKey === params.sessionKey);
        const entry = current?.entry;
        if (!entry) {
          return { result: undefined };
        }
        const now = Date.now();
        entry.abortedLastRun = false;
        entry.updatedAt = now;
        if (entry.pendingFinalDelivery || entry.pendingFinalDeliveryText) {
          if (sanitizedPendingText) {
            entry.pendingFinalDeliveryLastAttemptAt = now;
            entry.pendingFinalDeliveryAttemptCount =
              (entry.pendingFinalDeliveryAttemptCount ?? 0) + 1;
            entry.pendingFinalDeliveryLastError = null;
            entry.pendingFinalDeliveryText = sanitizedPendingText;
          } else {
            entry.pendingFinalDelivery = undefined;
            entry.pendingFinalDeliveryText = undefined;
            entry.pendingFinalDeliveryCreatedAt = undefined;
            entry.pendingFinalDeliveryLastAttemptAt = undefined;
            entry.pendingFinalDeliveryAttemptCount = undefined;
            entry.pendingFinalDeliveryLastError = undefined;
            entry.pendingFinalDeliveryContext = undefined;
          }
        }
        return {
          result: undefined,
          replacements: [{ sessionKey: params.sessionKey, entry }],
        };
      },
    });
    log.info(
      `resumed interrupted main session: ${params.sessionKey}${
        sanitizedPendingText ? " (with pending payload)" : ""
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
  const storeResult = await applySessionEntryReplacements({
    storePath,
    update: (entries) => {
      const replacements: Array<{ sessionKey: string; entry: SessionEntry }> = [];
      const counts = { marked: 0, skipped: 0 };
      for (const { sessionKey, entry } of entries) {
        if (entry.status !== "running") {
          continue;
        }
        if (shouldSkipMainRecovery(entry, sessionKey)) {
          counts.skipped++;
          continue;
        }
        const entryLockPaths = resolveEntryTranscriptLockPaths({ entry, sessionsDir });
        if (!entryLockPaths.some((lockPath) => interruptedLockPaths.has(lockPath))) {
          continue;
        }
        entry.abortedLastRun = true;
        replacements.push({ sessionKey, entry });
        counts.marked++;
      }
      return { result: counts, replacements };
    },
  });
  result.marked += storeResult.marked;
  result.skipped += storeResult.skipped;

  if (result.marked > 0) {
    log.warn(`marked ${result.marked} interrupted main session(s) from stale transcript locks`);
  }
  return result;
}

function isRoutableRecoveryStore(params: {
  cfg?: OpenClawConfig;
  sessionKey: string;
  storePath: string;
}): boolean {
  if (!params.cfg) {
    return true;
  }
  if (!params.cfg.session?.store) {
    return true;
  }
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.sessionKey,
    });
    return path.resolve(target.storePath) === path.resolve(params.storePath);
  } catch (err) {
    log.warn(`failed to resolve recovery store for ${params.sessionKey}: ${String(err)}`);
    return false;
  }
}

async function recoverStore(params: {
  cfg?: OpenClawConfig;
  storePath: string;
  resumedSessionKeys: Set<string>;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const providedActiveSessionIds =
    params.activeSessionIds === undefined ? undefined : normalizeStringSet(params.activeSessionIds);
  const providedActiveSessionKeys =
    params.activeSessionKeys === undefined
      ? undefined
      : normalizeStringSet(params.activeSessionKeys);
  const resolveActiveSessionIds = () =>
    providedActiveSessionIds ?? normalizeStringSet(listActiveEmbeddedRunSessionIds());
  const resolveActiveSessionKeys = () =>
    providedActiveSessionKeys ?? normalizeStringSet(listActiveEmbeddedRunSessionKeys());
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
    if (
      !isRoutableRecoveryStore({
        cfg: params.cfg,
        sessionKey,
        storePath: params.storePath,
      })
    ) {
      result.skipped++;
      continue;
    }
    if (
      hasCurrentProcessOwner({
        activeSessionIds: resolveActiveSessionIds(),
        activeSessionKeys: resolveActiveSessionKeys(),
        entry,
        sessionKey,
      })
    ) {
      result.skipped++;
      continue;
    }
    const resumeDedupeKey = sessionKey;
    if (params.resumedSessionKeys.has(resumeDedupeKey)) {
      result.skipped++;
      continue;
    }

    if (entry.pendingFinalDelivery === true && entry.pendingFinalDeliveryText) {
      const resumed = await resumeMainSession({
        cfg: params.cfg,
        entry,
        storePath: params.storePath,
        sessionKey,
        pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
      });
      if (resumed) {
        params.resumedSessionKeys.add(resumeDedupeKey);
        result.recovered++;
      } else {
        result.failed++;
      }
      continue;
    }

    let messages: unknown[];
    try {
      messages = await readSessionMessagesAsync(
        {
          agentId: resolveAgentIdFromSessionKey(sessionKey),
          sessionEntry: entry,
          sessionId: entry.sessionId,
          sessionKey,
          storePath: params.storePath,
        },
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
      await sendUnresumableSessionNotice({
        cfg: params.cfg,
        entry,
        sessionKey,
        reason: resumeBlockReason,
      });
      await markSessionFailed({
        storePath: params.storePath,
        sessionKey,
        reason: resumeBlockReason,
      });
      result.failed++;
      continue;
    }

    const resumed = await resumeMainSession({
      cfg: params.cfg,
      entry,
      storePath: params.storePath,
      sessionKey,
      pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
    });
    if (resumed) {
      params.resumedSessionKeys.add(resumeDedupeKey);
      result.recovered++;
    } else {
      result.failed++;
    }
  }

  return result;
}

async function resolveRestartRecoveryStorePaths(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
}): Promise<string[]> {
  const storePaths = new Set<string>();
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  for (const sessionsDir of await resolveAgentSessionDirs(stateDir)) {
    storePaths.add(path.join(sessionsDir, "sessions.json"));
  }
  if (params.cfg) {
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env })) {
      storePaths.add(path.resolve(target.storePath));
    }
  }
  return [...storePaths].toSorted((a, b) => a.localeCompare(b));
}

export async function recoverRestartAbortedMainSessions(
  params: {
    cfg?: OpenClawConfig;
    stateDir?: string;
    resumedSessionKeys?: Set<string>;
    activeSessionIds?: Iterable<string>;
    activeSessionKeys?: Iterable<string>;
  } = {},
): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const resumedSessionKeys = params.resumedSessionKeys ?? new Set<string>();

  for (const storePath of await resolveRestartRecoveryStorePaths(params)) {
    const storeResult = await recoverStore({
      cfg: params.cfg,
      storePath,
      resumedSessionKeys,
      activeSessionIds: params.activeSessionIds,
      activeSessionKeys: params.activeSessionKeys,
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

export async function recoverStartupOrphanedMainSessions(
  params: {
    cfg?: OpenClawConfig;
    stateDir?: string;
    activeSessionIds?: Iterable<string>;
    activeSessionKeys?: Iterable<string>;
    updatedBeforeMs?: number;
    resumedSessionKeys?: Set<string>;
  } = {},
): Promise<{ marked: number; recovered: number; failed: number; skipped: number }> {
  const startupRecoveryCutoffMs = params.updatedBeforeMs ?? Date.now();
  const marked = await markStartupOrphanedMainSessionsForRecovery({
    cfg: params.cfg,
    stateDir: params.stateDir,
    activeSessionIds: params.activeSessionIds,
    activeSessionKeys: params.activeSessionKeys,
    updatedBeforeMs: startupRecoveryCutoffMs,
  });
  const recovered = await recoverRestartAbortedMainSessions({
    cfg: params.cfg,
    stateDir: params.stateDir,
    resumedSessionKeys: params.resumedSessionKeys,
    activeSessionIds: params.activeSessionIds,
    activeSessionKeys: params.activeSessionKeys,
  });
  return {
    marked: marked.marked,
    recovered: recovered.recovered,
    failed: recovered.failed,
    skipped: marked.skipped + recovered.skipped,
  };
}

export function scheduleRestartAbortedMainSessionRecovery(
  params: {
    cfg?: OpenClawConfig;
    delayMs?: number;
    maxRetries?: number;
    stateDir?: string;
  } = {},
): void {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
  const resumedSessionKeys = new Set<string>();
  // Only reconcile rows that existed before this startup recovery was scheduled.
  // Fresh runs started by this gateway are protected again by the active-run check.
  const startupRecoveryCutoffMs = Date.now();

  const runRecoveryAttempt = (attempt: number, delay: number) => {
    // Delayed retries outlive startup; each attempt must independently block
    // host suspension while it reads and rewrites recovery session state.
    void runWithGatewayIndependentRootWorkAdmission(
      async () =>
        await recoverStartupOrphanedMainSessions({
          cfg: params.cfg,
          stateDir: params.stateDir,
          resumedSessionKeys,
          updatedBeforeMs: startupRecoveryCutoffMs,
        }),
    )
      .then((result) => {
        if (result.failed > 0 && attempt < maxRetries) {
          scheduleAttempt(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
        }
      })
      .catch((err: unknown) => {
        if (attempt < maxRetries) {
          log.warn(`main-session restart recovery failed: ${String(err)}`);
          scheduleAttempt(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
        } else {
          log.warn(`main-session restart recovery gave up: ${String(err)}`);
        }
      });
  };

  const scheduleAttempt = (attempt: number, delay: number) => {
    if (delay <= 0) {
      runRecoveryAttempt(attempt, delay);
      return;
    }
    setTimeout(() => {
      runRecoveryAttempt(attempt, delay);
    }, delay).unref?.();
  };

  scheduleAttempt(1, initialDelay);
}
