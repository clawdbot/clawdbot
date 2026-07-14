/**
 * Post-restart recovery for main sessions interrupted while holding a transcript lock.
 */

import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { resolveStateDir } from "../config/paths.js";
import {
  type RestartRecoveryRun,
  type SessionEntry,
  resolveSessionWorkStartError,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionFilePath,
  resolveSessionTranscriptPathInDir,
} from "../config/sessions.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import {
  applySessionEntryReplacements,
  listSessionEntriesByStatus,
} from "../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
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
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import {
  beginSessionWorkAdmission,
  cancelSessionWorkAdmissionHandoff,
} from "../sessions/session-lifecycle-admission.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "./code-mode-control-tools.js";
import {
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "./embedded-agent-runner/run-state.js";
import {
  buildUnresumableSessionNoticeIdempotencyKey,
  loadExpectedRestartRecoveryClaim,
  type ExpectedRestartRecoveryClaim,
} from "./main-session-restart-claim.js";
import {
  resolveRestartRecoveryDeliveryContext,
  resumeMainSession,
} from "./main-session-restart-dispatch.js";
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
      statuses: ["running"],
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

function readCodeModeWaitCall(
  message: unknown,
): { runId: string; toolCallId?: string } | undefined {
  if (
    !message ||
    typeof message !== "object" ||
    getMessageRole(message) !== "assistant" ||
    (message as { stopReason?: unknown }).stopReason !== "toolUse"
  ) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const supportedTypes = new Set(["text", "thinking", "toolCall", "toolUse", "tool_use"]);
  if (
    content.some(
      (block) =>
        !block ||
        typeof block !== "object" ||
        !supportedTypes.has(String((block as { type?: unknown }).type)) ||
        ((block as { type?: unknown }).type === "text" &&
          Boolean(normalizeOptionalString((block as { text?: unknown }).text))),
    )
  ) {
    return undefined;
  }
  const toolCalls = content.filter((block) => {
    const type = (block as { type?: unknown }).type;
    return type === "toolCall" || type === "toolUse" || type === "tool_use";
  });
  if (toolCalls.length !== 1) {
    return undefined;
  }
  const block = toolCalls[0] as Record<string, unknown>;
  if (normalizeOptionalString((block as { name?: unknown }).name) !== CODE_MODE_WAIT_TOOL_NAME) {
    return undefined;
  }
  const args = (block as { arguments?: unknown }).arguments ?? (block as { input?: unknown }).input;
  const runId =
    args && typeof args === "object"
      ? normalizeOptionalString((args as { runId?: unknown }).runId)
      : undefined;
  if (!runId) {
    return undefined;
  }
  const toolCallId = normalizeOptionalString(block.id);
  return { runId, ...(toolCallId ? { toolCallId } : {}) };
}

function isResumableTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  return role === "user" || role === "tool" || role === "toolResult";
}

function isPendingAssistantToolCall(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "assistant") {
    return false;
  }
  if (normalizeOptionalString((message as { stopReason?: unknown }).stopReason) !== "toolUse") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  let hasToolCall = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    const type = normalizeOptionalString((block as { type?: unknown }).type);
    if (type === "toolCall" || type === "toolUse" || type === "tool_use") {
      hasToolCall = true;
      continue;
    }
    if (type === "thinking") {
      continue;
    }
    if (type === "text" && !normalizeOptionalString((block as { text?: unknown }).text)) {
      continue;
    }
    return false;
  }
  return hasToolCall;
}

function readCodeModeCheckpoint(
  message: unknown,
): { replaySafe: boolean; runId?: string } | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = getMessageRole(message);
  if (role !== "tool" && role !== "toolResult") {
    return undefined;
  }
  const toolName = normalizeOptionalString((message as { toolName?: unknown }).toolName);
  if (toolName !== CODE_MODE_EXEC_TOOL_NAME && toolName !== CODE_MODE_WAIT_TOOL_NAME) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlock = content.find(
    (block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text",
  ) as { text?: unknown } | undefined;
  const text = normalizeOptionalString(textBlock?.text);
  if (!text) {
    return undefined;
  }
  try {
    const result = JSON.parse(text) as {
      status?: unknown;
      replaySafe?: unknown;
      runId?: unknown;
    };
    if (result.status === "completed" || result.status === "failed") {
      return { replaySafe: result.replaySafe === true };
    }
    const runId = normalizeOptionalString(result.runId);
    return result.status === "waiting" && runId
      ? { replaySafe: result.replaySafe === true, runId }
      : undefined;
  } catch {
    return undefined;
  }
}

function hasReplaySafeCodeModeCheckpointInCurrentTurn(messages: readonly unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (getMessageRole(message) === "user") {
      return false;
    }
    if (readCodeModeCheckpoint(message)?.replaySafe === true) {
      return true;
    }
  }
  return false;
}

function isRestartAbortTailArtifact(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "assistant") {
    return false;
  }
  const stopReason = normalizeOptionalString((message as { stopReason?: unknown }).stopReason);
  if (stopReason !== "error" && stopReason !== "aborted") {
    return false;
  }
  const errorMessage = normalizeOptionalString(
    (message as { errorMessage?: unknown }).errorMessage,
  );
  const content = (message as { content?: unknown }).content;
  return (
    Array.isArray(content) &&
    content.length === 0 &&
    (errorMessage === "Request was aborted" || errorMessage === "This operation was aborted")
  );
}

function isRestartAbortedWaitFailure(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "toolResult") {
    return false;
  }
  const record = message as Record<string, unknown>;
  if (
    normalizeOptionalString(record.toolName) !== CODE_MODE_WAIT_TOOL_NAME ||
    record.isError !== true
  ) {
    return false;
  }
  const details = record.details;
  if (
    !details ||
    typeof details !== "object" ||
    (details as { status?: unknown }).status !== "failed" ||
    (details as { code?: unknown }).code !== "internal_error"
  ) {
    return false;
  }
  const content = record.content;
  const contentText = Array.isArray(content)
    ? content
        .filter(
          (block) =>
            block && typeof block === "object" && (block as { type?: unknown }).type === "text",
        )
        .map((block) => normalizeOptionalString((block as { text?: unknown }).text) ?? "")
        .join("\n")
    : "";
  const errorText =
    normalizeOptionalString((details as { error?: unknown }).error) ??
    normalizeOptionalString(contentText);
  return /^(?:(?:Abort)?Error:\s*)?(?:The|This) operation was aborted\.?$/u.test(errorText ?? "");
}

function isRestartAbortedWaitResultArtifact(message: unknown, waitMessage: unknown): boolean {
  if (!isRestartAbortedWaitFailure(message)) {
    return false;
  }
  const toolCallId = normalizeOptionalString((message as Record<string, unknown>).toolCallId);
  const waitCall = readCodeModeWaitCall(waitMessage);
  return Boolean(toolCallId && waitCall?.toolCallId === toolCallId);
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

function resolveMainSessionResumePolicy(
  messages: unknown[],
  forceRestartSafeTools = false,
): {
  blockReason: string | null;
  forceRestartSafeTools: boolean;
} {
  const meaningfulMessages = messages.toReversed().filter(isMeaningfulTailMessage);
  if (isRestartAbortTailArtifact(meaningfulMessages[0])) {
    meaningfulMessages.shift();
  }
  if (isRestartAbortedWaitResultArtifact(meaningfulMessages[0], meaningfulMessages[1])) {
    meaningfulMessages.shift();
  }
  const lastMeaningful = meaningfulMessages[0];
  if (forceRestartSafeTools && isPendingAssistantToolCall(lastMeaningful)) {
    return { blockReason: null, forceRestartSafeTools: true };
  }
  if (isRestartAbortedWaitFailure(lastMeaningful)) {
    const waitCall = readCodeModeWaitCall(meaningfulMessages[1]);
    const checkpoint = readCodeModeCheckpoint(meaningfulMessages[2]);
    return waitCall && checkpoint?.replaySafe === true && checkpoint.runId === waitCall.runId
      ? { blockReason: null, forceRestartSafeTools: true }
      : {
          blockReason: "failed Code Mode wait cannot be matched to a replay-safe checkpoint",
          forceRestartSafeTools: false,
        };
  }
  const waitCall = readCodeModeWaitCall(lastMeaningful);
  if (waitCall) {
    const checkpoint = readCodeModeCheckpoint(meaningfulMessages[1]);
    return checkpoint?.replaySafe === true && checkpoint.runId === waitCall.runId
      ? { blockReason: null, forceRestartSafeTools: true }
      : {
          blockReason: "Code Mode wait checkpoint is not replay-safe",
          forceRestartSafeTools: false,
        };
  }
  const tailCheckpoint = readCodeModeCheckpoint(lastMeaningful);
  if (tailCheckpoint) {
    return tailCheckpoint.replaySafe
      ? { blockReason: null, forceRestartSafeTools: true }
      : {
          blockReason: "Code Mode wait checkpoint is not replay-safe",
          forceRestartSafeTools: false,
        };
  }
  if (!lastMeaningful || !isResumableTailMessage(lastMeaningful)) {
    return { blockReason: "transcript tail is not resumable", forceRestartSafeTools: false };
  }
  if (isApprovalPendingToolResult(lastMeaningful)) {
    return {
      blockReason: "transcript tail is a stale approval-pending tool result",
      forceRestartSafeTools: false,
    };
  }
  return { blockReason: null, forceRestartSafeTools: false };
}

async function markSessionFailed(params: {
  expectedRecoveryRunId?: string;
  expectedRecoverySourceRunId?: string;
  expectedSessionId: string;
  storePath: string;
  sessionKey: string;
  reason: string;
}): Promise<boolean> {
  const marked = await applySessionEntryReplacements({
    sessionKeys: [params.sessionKey],
    storePath: params.storePath,
    update: (entries) => {
      const current = entries.find((entry) => entry.sessionKey === params.sessionKey);
      const entry = current?.entry;
      if (
        !entry ||
        entry.sessionId !== params.expectedSessionId ||
        entry.status !== "running" ||
        entry.abortedLastRun !== true ||
        normalizeOptionalString(entry.restartRecoveryDeliveryRunId) !==
          params.expectedRecoveryRunId ||
        normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) !==
          params.expectedRecoverySourceRunId
      ) {
        return { result: false };
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
      Object.assign(
        entry,
        buildRestartRecoveryClaimCleanupPatch({
          entry,
          recordTerminalSource: true,
        }),
      );
      return {
        result: true,
        replacements: [{ sessionKey: params.sessionKey, entry }],
      };
    },
  });
  if (marked) {
    log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
  }
  return marked;
}

async function sendUnresumableSessionNotice(params: {
  deliveryContext: DeliveryContext;
  entry: SessionEntry;
  reason: string;
  sessionKey: string;
}): Promise<void> {
  const messageParams: Record<string, unknown> = {
    to: params.deliveryContext.to,
    message: UNRESUMABLE_SESSION_NOTICE,
    bestEffort: true,
  };
  if (params.deliveryContext.threadId != null) {
    messageParams.threadId = params.deliveryContext.threadId;
  }
  const actionParams: Record<string, unknown> = {
    channel: params.deliveryContext.channel,
    action: "send",
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    idempotencyKey: buildUnresumableSessionNoticeIdempotencyKey(params.entry),
    params: messageParams,
  };
  const accountId = normalizeOptionalString(params.deliveryContext.accountId);
  if (accountId) {
    actionParams.accountId = accountId;
  }

  try {
    await callGateway({
      method: "message.action",
      params: actionParams,
      timeoutMs: 10_000,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
    log.info(
      `sent interrupted main session recovery notice: ${params.sessionKey} (${params.reason})`,
    );
  } catch (err) {
    log.warn(
      `failed to send interrupted main session recovery notice ${params.sessionKey}: ${String(err)}`,
    );
  }
}

async function writeUnresumableSessionNotice(params: {
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): Promise<boolean> {
  const result = await appendAssistantMessageToSessionTranscript({
    agentId: resolveAgentIdFromSessionKey(params.sessionKey),
    sessionKey: params.sessionKey,
    expectedSessionId: params.entry.sessionId,
    expectedSessionState: {
      abortedLastRun: params.entry.abortedLastRun,
      restartRecoveryDeliveryRequestFingerprint:
        params.entry.restartRecoveryDeliveryRequestFingerprint,
      restartRecoveryDeliveryRunId: params.entry.restartRecoveryDeliveryRunId,
      restartRecoveryDeliverySourceRunId: params.entry.restartRecoveryDeliverySourceRunId,
      status: params.entry.status,
      updatedAt: params.entry.updatedAt,
    },
    storePath: params.storePath,
    text: UNRESUMABLE_SESSION_NOTICE,
    idempotencyKey: buildUnresumableSessionNoticeIdempotencyKey(params.entry),
  }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!result.ok) {
    log.warn(
      `failed to write interrupted main session notice ${params.sessionKey}: ${result.reason}`,
    );
  }
  return result.ok;
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
    statuses: ["running"],
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

function resolveRecoveryDispatchSessionKey(params: {
  cfg?: OpenClawConfig;
  sessionKey: string;
  storePath: string;
}): string | undefined {
  if (!params.cfg) {
    return params.sessionKey;
  }
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.sessionKey,
    });
    return !params.cfg.session?.store ||
      path.resolve(target.storePath) === path.resolve(params.storePath)
      ? target.canonicalKey
      : undefined;
  } catch (err) {
    log.warn(`failed to resolve recovery store for ${params.sessionKey}: ${String(err)}`);
    return undefined;
  }
}

async function recoverStore(params: {
  cfg?: OpenClawConfig;
  storePath: string;
  resumedSessionKeys: Set<string>;
  expectedClaim?: ExpectedRestartRecoveryClaim;
  sessionWorkAdmissionHandoffId?: string;
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
  let entries: Array<{ sessionKey: string; entry: SessionEntry }>;
  try {
    if (params.expectedClaim) {
      const entry = loadExpectedRestartRecoveryClaim({
        expected: params.expectedClaim,
        storePath: params.storePath,
      });
      entries = entry ? [{ sessionKey: params.expectedClaim.sessionKey, entry }] : [];
    } else {
      entries = listSessionEntriesByStatus({ storePath: params.storePath }, ["running"]);
    }
  } catch (err) {
    log.warn(`failed to load session store ${params.storePath}: ${String(err)}`);
    result.failed++;
    return result;
  }

  for (const { sessionKey, entry } of entries.toSorted((a, b) =>
    a.sessionKey.localeCompare(b.sessionKey),
  )) {
    if (!entry || entry.status !== "running" || entry.abortedLastRun !== true) {
      continue;
    }
    if (shouldSkipMainRecovery(entry, sessionKey)) {
      result.skipped++;
      continue;
    }
    if (resolveSessionWorkStartError(sessionKey, entry)) {
      result.skipped++;
      continue;
    }
    const resolvedDispatchSessionKey = resolveRecoveryDispatchSessionKey({
      cfg: params.cfg,
      sessionKey,
      storePath: params.storePath,
    });
    if (!resolvedDispatchSessionKey) {
      result.skipped++;
      continue;
    }
    const dispatchSessionKey =
      params.expectedClaim?.canonicalSessionKey ?? resolvedDispatchSessionKey;
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

    if (
      entry.pendingFinalDelivery === true &&
      entry.pendingFinalDeliveryText &&
      entry.restartRecoveryForceSafeTools === true
    ) {
      const resumed = await resumeMainSession({
        canonicalSessionKey: dispatchSessionKey,
        cfg: params.cfg,
        entry,
        storePath: params.storePath,
        sessionKey,
        pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
        forceRestartSafeTools: true,
        sessionWorkAdmissionHandoffId: params.sessionWorkAdmissionHandoffId,
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
      if (entry.pendingFinalDelivery === true && entry.pendingFinalDeliveryText) {
        log.warn(
          `transcript unavailable for ${sessionKey}; resuming its durable pending final delivery`,
        );
        const resumed = await resumeMainSession({
          canonicalSessionKey: dispatchSessionKey,
          cfg: params.cfg,
          entry,
          storePath: params.storePath,
          sessionKey,
          pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
          sessionWorkAdmissionHandoffId: params.sessionWorkAdmissionHandoffId,
        });
        if (resumed) {
          params.resumedSessionKeys.add(resumeDedupeKey);
          result.recovered++;
        } else {
          result.failed++;
        }
        continue;
      }
      log.warn(`failed to read transcript for ${sessionKey}: ${String(err)}`);
      result.failed++;
      continue;
    }

    if (entry.pendingFinalDelivery === true && entry.pendingFinalDeliveryText) {
      const resumed = await resumeMainSession({
        canonicalSessionKey: dispatchSessionKey,
        cfg: params.cfg,
        entry,
        storePath: params.storePath,
        sessionKey,
        pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
        forceRestartSafeTools: hasReplaySafeCodeModeCheckpointInCurrentTurn(messages),
        sessionWorkAdmissionHandoffId: params.sessionWorkAdmissionHandoffId,
      });
      if (resumed) {
        params.resumedSessionKeys.add(resumeDedupeKey);
        result.recovered++;
      } else {
        result.failed++;
      }
      continue;
    }

    const transcriptResumePolicy = resolveMainSessionResumePolicy(
      messages,
      entry.restartRecoveryForceSafeTools === true,
    );
    const resumePolicy = {
      ...transcriptResumePolicy,
      forceRestartSafeTools:
        entry.restartRecoveryForceSafeTools === true ||
        transcriptResumePolicy.forceRestartSafeTools,
    };
    if (resumePolicy.blockReason) {
      const deliveryContext = resolveRestartRecoveryDeliveryContext({
        cfg: params.cfg,
        entry,
        includeSessionDeliveryFallback: true,
        sessionKey,
      });
      // Transcript-only notices are guarded by the interrupted entry snapshot.
      // External delivery waits until the same ownership is atomically failed.
      if (
        !deliveryContext &&
        !(await writeUnresumableSessionNotice({
          entry,
          sessionKey,
          storePath: params.storePath,
        }))
      ) {
        // Keep the claim recoverable until its user-visible terminal notice is durable.
        result.failed++;
        continue;
      }
      const failed = await markSessionFailed({
        expectedRecoveryRunId: normalizeOptionalString(entry.restartRecoveryDeliveryRunId),
        expectedRecoverySourceRunId: normalizeOptionalString(
          entry.restartRecoveryDeliverySourceRunId,
        ),
        expectedSessionId: entry.sessionId,
        storePath: params.storePath,
        sessionKey,
        reason: resumePolicy.blockReason,
      });
      if (failed) {
        if (deliveryContext) {
          await sendUnresumableSessionNotice({
            deliveryContext,
            entry,
            reason: resumePolicy.blockReason,
            sessionKey,
          });
        }
        result.failed++;
      } else {
        result.skipped++;
      }
      continue;
    }

    const resumed = await resumeMainSession({
      canonicalSessionKey: dispatchSessionKey,
      cfg: params.cfg,
      entry,
      storePath: params.storePath,
      sessionKey,
      pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
      forceRestartSafeTools: resumePolicy.forceRestartSafeTools,
      sessionWorkAdmissionHandoffId: params.sessionWorkAdmissionHandoffId,
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

/** Retries one exact durable Control UI row from its owning per-agent SQLite store. */
export async function retryRestartAbortedMainSessionRecovery(params: {
  canonicalSessionKey?: string;
  cfg?: OpenClawConfig;
  expectedRecoveryRunId: string;
  expectedRecoverySourceRunId: string;
  expectedSessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const expectedClaim: ExpectedRestartRecoveryClaim = {
    canonicalSessionKey: params.canonicalSessionKey,
    recoveryRunId: params.expectedRecoveryRunId,
    recoverySourceRunId: params.expectedRecoverySourceRunId,
    sessionId: params.expectedSessionId,
    sessionKey: params.sessionKey,
  };
  if (!loadExpectedRestartRecoveryClaim({ expected: expectedClaim, storePath: params.storePath })) {
    return { recovered: 0, failed: 0, skipped: 0 };
  }
  const assertClaimCurrent = () => {
    if (
      !loadExpectedRestartRecoveryClaim({ expected: expectedClaim, storePath: params.storePath })
    ) {
      throw new Error("restart recovery session ownership changed before dispatch");
    }
  };
  // Keep lifecycle replacement behind the accepted recovery dispatch. The agent
  // RPC atomically adopts this lease, so no second admission can deadlock behind
  // a mutation that already sees the accepted browser turn as active work.
  const admission = await beginSessionWorkAdmission({
    scope: params.storePath,
    identities: [params.sessionKey, params.canonicalSessionKey, params.expectedSessionId],
    assertAllowed: assertClaimCurrent,
    revalidateAllowed: assertClaimCurrent,
  });
  const handoffId = admission.createHandoff();
  try {
    return await admission.run(
      async () =>
        await recoverStore({
          cfg: params.cfg,
          storePath: params.storePath,
          resumedSessionKeys: new Set<string>(),
          expectedClaim,
          sessionWorkAdmissionHandoffId: handoffId,
        }),
    );
  } finally {
    cancelSessionWorkAdmissionHandoff(handoffId);
  }
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
