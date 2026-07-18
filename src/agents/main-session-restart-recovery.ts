/**
 * Post-restart recovery for main sessions interrupted while holding a transcript lock.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { resolveStateDir } from "../config/paths.js";
import {
  type InternalSessionEntry as SessionEntry,
  type RestartRecoveryRun,
  resolveSessionWorkStartError,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionFilePath,
  resolveSessionTranscriptPathInDir,
} from "../config/sessions.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import {
  applySessionEntryReplacements,
  loadExactSessionEntry,
  listSessionEntriesByStatus,
  persistSessionTranscriptTurn,
  type SessionTranscriptTurnExpectedState,
  type SessionTranscriptTurnLifecyclePatch,
} from "../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { readSessionMessagesAsync } from "../gateway/session-transcript-readers.js";
import { resolveGatewaySessionStoreTarget } from "../gateway/session-utils.js";
import {
  getAgentEventLifecycleGeneration,
  listAgentRunsForSession,
} from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  beginSessionWorkAdmission,
  cancelSessionWorkAdmissionHandoff,
} from "../sessions/session-lifecycle-admission.js";
import { buildRunUserTurnIdempotencyKey } from "../sessions/user-turn-transcript.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "./code-mode-control-tools.js";
import {
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "./embedded-agent-runner/run-state.js";
import {
  isMainRestartRecoveryCandidate,
  transitionMainSessionRecovery,
  type MainSessionRecoveryObservation,
} from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import {
  buildUnresumableSessionNoticeIdempotencyKey,
  loadExpectedRestartRecoveryClaim,
  type ExpectedRestartRecoveryClaim,
} from "./main-session-restart-claim.js";
import {
  hasRestartRecoveryMessageActionAuthority,
  requiresRestartRecoveryMessageActionAuthority,
  resolveRestartRecoveryResumeBlockReason,
  resolveRestartRecoveryDeliveryContext,
  resumeMainSession,
} from "./main-session-restart-dispatch.js";
import { tombstoneMainRestartRecoveryWithNotice } from "./main-session-restart-recovery-failure.js";
import { resolveAgentSessionDirs } from "./session-dirs.js";
import type { SessionLockInspection } from "./session-write-lock.js";

const log = createSubsystemLogger("main-session-restart-recovery");
const DEFAULT_RECOVERY_DELAY_MS = 5_000;
const MAX_RECOVERY_RETRIES = 3;
const RETRY_BACKOFF_MULTIPLIER = 2;
const UNRESUMABLE_SESSION_NOTICE =
  "I was interrupted by a gateway restart and couldn't safely resume the previous turn. " +
  "Please send that last request again and I'll pick it up cleanly.";

type ExpectedRestartRecoveryTarget = {
  canonicalSessionKey?: string;
  sessionId: string;
  sessionKey: string;
};

type ExhaustedRestartRecoveryTarget = ExpectedRestartRecoveryTarget & {
  storePath: string;
};

function loadExpectedRestartRecoveryTarget(params: {
  expected: ExpectedRestartRecoveryTarget;
  storePath: string;
}): SessionEntry | undefined {
  const exact = loadExactSessionEntry({
    sessionKey: params.expected.sessionKey,
    storePath: params.storePath,
    readConsistency: "latest",
  });
  const entry = exact?.sessionKey === params.expected.sessionKey ? exact.entry : undefined;
  return entry?.sessionId === params.expected.sessionId &&
    entry.status === "running" &&
    entry.abortedLastRun === true &&
    isMainRestartRecoveryCandidate(entry, params.expected.sessionKey)
    ? entry
    : undefined;
}

function shouldSkipMainRecovery(entry: SessionEntry, sessionKey: string): boolean {
  return !isMainRestartRecoveryCandidate(entry, sessionKey);
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
          transitionMainSessionRecovery(entry, {
            kind: "mark_interrupted",
            cycleId: randomUUID(),
            now: Date.now(),
            resetRuntime: !wasRunning,
            runs: entry.restartRecoveryRuns,
          });
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
          transitionMainSessionRecovery(entry, {
            kind: "mark_interrupted",
            cycleId: randomUUID(),
            now: Date.now(),
          });
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

function findSourceTurnRange(params: {
  continuationRunId?: string;
  messages: readonly unknown[];
  sourceTurnId: string;
}): { startIndex: number; endIndex: number } | undefined {
  const sourceUserTurnId = buildRunUserTurnIdempotencyKey(params.sourceTurnId);
  const sourceTurnIds = new Set([params.sourceTurnId, sourceUserTurnId]);
  const continuationTurnId = params.continuationRunId
    ? buildRunUserTurnIdempotencyKey(params.continuationRunId)
    : undefined;
  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const message = params.messages[index];
    if (
      getMessageRole(message) === "user" &&
      message &&
      typeof message === "object" &&
      sourceTurnIds.has(
        normalizeOptionalString((message as { idempotencyKey?: unknown }).idempotencyKey) ?? "",
      )
    ) {
      let endIndex = params.messages.length;
      for (let nextIndex = index + 1; nextIndex < params.messages.length; nextIndex += 1) {
        const nextMessage = params.messages[nextIndex];
        if (getMessageRole(nextMessage) !== "user") {
          continue;
        }
        const nextIdempotencyKey =
          nextMessage && typeof nextMessage === "object"
            ? normalizeOptionalString((nextMessage as { idempotencyKey?: unknown }).idempotencyKey)
            : undefined;
        // Late media and the exact restart continuation extend the same logical source turn.
        if (
          nextIdempotencyKey === `${params.sourceTurnId}:late-media` ||
          nextIdempotencyKey === continuationTurnId ||
          (continuationTurnId !== undefined &&
            nextIdempotencyKey === `${continuationTurnId}:late-media`)
        ) {
          continue;
        }
        endIndex = nextIndex;
        break;
      }
      return { startIndex: index, endIndex };
    }
  }
  return undefined;
}

function readToolCallId(message: Record<string, unknown>): string | undefined {
  return [
    message.toolCallId,
    message.toolUseId,
    message.tool_call_id,
    message.tool_use_id,
    message.callId,
    message.call_id,
  ]
    .map(normalizeOptionalString)
    .find(Boolean);
}

function findMessageToolCallIndexInSourceTurn(params: {
  messages: readonly unknown[];
  sourceTurnRange: { startIndex: number; endIndex: number };
  toolCallId: string;
}): number | undefined {
  for (
    let index = params.sourceTurnRange.endIndex - 1;
    index > params.sourceTurnRange.startIndex;
    index -= 1
  ) {
    const message = params.messages[index];
    if (!message || typeof message !== "object" || getMessageRole(message) !== "assistant") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    const matched = content.some((block) => {
      if (!block || typeof block !== "object") {
        return false;
      }
      const record = block as Record<string, unknown>;
      const type = normalizeOptionalString(record.type);
      return (
        (type === "toolCall" || type === "toolUse" || type === "tool_use") &&
        normalizeOptionalString(record.id) === params.toolCallId &&
        normalizeOptionalString(record.name) === "message"
      );
    });
    if (matched) {
      return index;
    }
  }
  return undefined;
}

function hasSiblingAssistantToolCalls(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "assistant") {
    return true;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return true;
  }
  let toolCallCount = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = normalizeOptionalString((block as { type?: unknown }).type);
    if (type === "toolCall" || type === "toolUse" || type === "tool_use") {
      toolCallCount += 1;
    }
  }
  return toolCallCount !== 1;
}

function isSuccessfulMessageToolResult(message: unknown, toolCallId: string): boolean {
  const role = getMessageRole(message);
  if (!message || typeof message !== "object" || (role !== "tool" && role !== "toolResult")) {
    return false;
  }
  const record = message as Record<string, unknown>;
  return (
    readToolCallId(record) === toolCallId &&
    normalizeOptionalString(record.toolName) === "message" &&
    record.isError !== true
  );
}

function findSuccessfulMessageToolResultIndex(params: {
  messages: readonly unknown[];
  sourceTurnRange: { startIndex: number; endIndex: number };
  toolCallId: string;
  toolCallIndex: number;
}): number | undefined {
  for (let index = params.toolCallIndex + 1; index < params.sourceTurnRange.endIndex; index += 1) {
    if (isSuccessfulMessageToolResult(params.messages[index], params.toolCallId)) {
      return index;
    }
  }
  return undefined;
}

function isExactMessageToolDeliveryMirror(params: {
  message: unknown;
  sourceTurnId: string;
  toolCallId: string;
}): boolean {
  if (!params.message || typeof params.message !== "object") {
    return false;
  }
  const marker = (params.message as { openclawDeliveryMirror?: unknown }).openclawDeliveryMirror;
  if (!marker || typeof marker !== "object") {
    return false;
  }
  const delivery = marker as Record<string, unknown>;
  return (
    delivery.kind === "message-tool-source-reply" &&
    delivery.final === true &&
    normalizeOptionalString(delivery.sourceTurnId) === params.sourceTurnId &&
    normalizeOptionalString(delivery.toolCallId) === params.toolCallId
  );
}

function isSafeTerminalDeliveryTailMessage(params: {
  message: unknown;
  sourceTurnId: string;
  toolCallId: string;
}): boolean {
  if (isExactMessageToolDeliveryMirror(params)) {
    return true;
  }
  // An empty provider abort is restart lifecycle noise. Partial output remains unsafe.
  return isRestartAbortTailArtifact(params.message);
}

function isTerminalSilentAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "assistant") {
    return false;
  }
  if (normalizeOptionalString((message as { stopReason?: unknown }).stopReason) !== "stop") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    const type = normalizeOptionalString((block as { type?: unknown }).type);
    if (type === "thinking") {
      continue;
    }
    if (type !== "text") {
      return false;
    }
    const text = normalizeOptionalString((block as { text?: unknown }).text);
    if (text) {
      textParts.push(text);
    }
  }
  return isSilentReplyPayloadText(textParts.join("\n"), SILENT_REPLY_TOKEN);
}

function canReconcileTerminalDeliveryAtSourceTurnTail(params: {
  messages: readonly unknown[];
  sourceTurnId: string;
  sourceTurnRange: { startIndex: number; endIndex: number };
  toolCallId: string;
  toolCallIndex: number;
  successfulToolResultIndex?: number;
}): boolean {
  if (params.sourceTurnRange.endIndex !== params.messages.length) {
    return false;
  }
  for (
    let messageIndex = params.toolCallIndex + 1;
    messageIndex < params.sourceTurnRange.endIndex;
    messageIndex += 1
  ) {
    if (messageIndex === params.successfulToolResultIndex) {
      continue;
    }
    const message = params.messages[messageIndex];
    if (
      params.successfulToolResultIndex !== undefined &&
      messageIndex > params.successfulToolResultIndex &&
      messageIndex === params.sourceTurnRange.endIndex - 1 &&
      isTerminalSilentAssistantMessage(message)
    ) {
      continue;
    }
    if (
      isSafeTerminalDeliveryTailMessage({
        message,
        sourceTurnId: params.sourceTurnId,
        toolCallId: params.toolCallId,
      })
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function buildRecoveryToolResultIdempotencyKey(sourceTurnId: string, toolCallId: string): string {
  return `restart-recovery:message-tool-result:${sourceTurnId}:${toolCallId}`;
}

function isMeaningfulTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  if (!role || role === "system") {
    return false;
  }
  return true;
}

function readDeliveredTerminalSourceReplyToolCallId(
  messages: readonly unknown[],
  expectedSourceTurnId: string | undefined,
): string | undefined {
  if (!expectedSourceTurnId) {
    return undefined;
  }
  for (const message of messages.toReversed()) {
    if (!message || typeof message !== "object" || getMessageRole(message) !== "assistant") {
      continue;
    }
    const marker = (message as { openclawDeliveryMirror?: unknown }).openclawDeliveryMirror;
    if (!marker || typeof marker !== "object") {
      continue;
    }
    const delivery = marker as {
      final?: unknown;
      kind?: unknown;
      sourceTurnId?: unknown;
      toolCallId?: unknown;
    };
    if (
      delivery.kind === "message-tool-source-reply" &&
      delivery.final === true &&
      normalizeOptionalString(delivery.sourceTurnId) === expectedSourceTurnId
    ) {
      return normalizeOptionalString(delivery.toolCallId);
    }
  }
  return undefined;
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

type MainSessionResumePolicy =
  | {
      action: "complete";
      reason: "delivered-terminal" | "delivered-terminal-receipt";
      toolCallId: string;
    }
  | { action: "complete"; reason: "handled-silent" }
  | { action: "fail"; reason: string }
  | { action: "resume"; forceRestartSafeTools: boolean };

function resolveMainSessionResumePolicy(
  messages: unknown[],
  forceRestartSafeTools = false,
  expectedSourceTurnId?: string,
  beforeAgentReplyState?: SessionEntry["restartRecoveryBeforeAgentReplyState"],
  deliveryReceiptState?: SessionEntry["restartRecoveryDeliveryReceiptState"],
  deliveryToolCallId?: string,
): MainSessionResumePolicy {
  const mirroredToolCallId = readDeliveredTerminalSourceReplyToolCallId(
    messages,
    expectedSourceTurnId,
  );
  if (mirroredToolCallId) {
    return { action: "complete", reason: "delivered-terminal", toolCallId: mirroredToolCallId };
  }
  if (deliveryReceiptState === "delivered-terminal") {
    return deliveryToolCallId
      ? {
          action: "complete",
          reason: "delivered-terminal-receipt",
          toolCallId: deliveryToolCallId,
        }
      : { action: "fail", reason: "terminal delivery receipt lacks tool-call correlation" };
  }
  if (deliveryReceiptState === "terminal-pending") {
    return { action: "fail", reason: "terminal source reply delivery outcome is unknown" };
  }
  if (beforeAgentReplyState === "handled-silent") {
    return { action: "complete", reason: "handled-silent" };
  }
  if (beforeAgentReplyState === "pending") {
    return { action: "fail", reason: "before_agent_reply hook outcome is unknown" };
  }
  if (beforeAgentReplyState === "handled-reply") {
    return { action: "fail", reason: "before_agent_reply handled reply is not recoverable" };
  }
  if (beforeAgentReplyState === "handled-unrecoverable") {
    return { action: "fail", reason: "before_agent_reply handled an unrecoverable reply shape" };
  }
  // `admitted` means no optional hook started. The dispatch boundary reloads
  // the current hook set before it permits this transcript to resume.
  const meaningfulMessages = messages.toReversed().filter(isMeaningfulTailMessage);
  if (isRestartAbortTailArtifact(meaningfulMessages[0])) {
    meaningfulMessages.shift();
  }
  if (isRestartAbortedWaitResultArtifact(meaningfulMessages[0], meaningfulMessages[1])) {
    meaningfulMessages.shift();
  }
  const lastMeaningful = meaningfulMessages[0];
  if (forceRestartSafeTools && isPendingAssistantToolCall(lastMeaningful)) {
    return { action: "resume", forceRestartSafeTools: true };
  }
  if (isRestartAbortedWaitFailure(lastMeaningful)) {
    const waitCall = readCodeModeWaitCall(meaningfulMessages[1]);
    const checkpoint = readCodeModeCheckpoint(meaningfulMessages[2]);
    return waitCall && checkpoint?.replaySafe === true && checkpoint.runId === waitCall.runId
      ? { action: "resume", forceRestartSafeTools: true }
      : {
          action: "fail",
          reason: "failed Code Mode wait cannot be matched to a replay-safe checkpoint",
        };
  }
  const waitCall = readCodeModeWaitCall(lastMeaningful);
  if (waitCall) {
    const checkpoint = readCodeModeCheckpoint(meaningfulMessages[1]);
    return checkpoint?.replaySafe === true && checkpoint.runId === waitCall.runId
      ? { action: "resume", forceRestartSafeTools: true }
      : { action: "fail", reason: "Code Mode wait checkpoint is not replay-safe" };
  }
  const tailCheckpoint = readCodeModeCheckpoint(lastMeaningful);
  if (tailCheckpoint) {
    return tailCheckpoint.replaySafe
      ? { action: "resume", forceRestartSafeTools: true }
      : { action: "fail", reason: "Code Mode wait checkpoint is not replay-safe" };
  }
  if (!lastMeaningful || !isResumableTailMessage(lastMeaningful)) {
    return { action: "fail", reason: "transcript tail is not resumable" };
  }
  if (isApprovalPendingToolResult(lastMeaningful)) {
    return {
      action: "fail",
      reason: "transcript tail is a stale approval-pending tool result",
    };
  }
  return { action: "resume", forceRestartSafeTools: false };
}

async function markSessionFailed(params: {
  observation: MainSessionRecoveryObservation;
  storePath: string;
  sessionKey: string;
  reason: string;
}): Promise<boolean> {
  const marked = await commitMainSessionRecovery({
    command: {
      kind: "fail_recovery",
      now: Date.now(),
      observation: params.observation,
    },
    requireWriteSuccess: true,
    target: { sessionKey: params.sessionKey, storePath: params.storePath },
  });
  if (marked.transition.kind === "failed") {
    log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
    return true;
  }
  return false;
}

type RecoveryCheckpointCompletion =
  | { outcome: "completed" }
  | { outcome: "changed" }
  | { outcome: "unsafe-transcript"; reason: string };

async function markSessionCompletedAfterRecoveryCheckpoint(params: {
  entry: SessionEntry;
  messages: readonly unknown[];
  reason: "delivered-terminal" | "delivered-terminal-receipt" | "handled-silent";
  storePath: string;
  sessionKey: string;
  sourceTurnId?: string;
  toolCallId?: string;
}): Promise<RecoveryCheckpointCompletion> {
  const expectedRecoveryRunId = normalizeOptionalString(params.entry.restartRecoveryDeliveryRunId);
  const expectedRecoverySourceRunId = normalizeOptionalString(
    params.entry.restartRecoveryDeliverySourceRunId,
  );
  const endedAt = Date.now();
  const lifecyclePatch: SessionTranscriptTurnLifecyclePatch = {
    ...buildRestartRecoveryClaimCleanupPatch({
      entry: params.entry,
      recordTerminalSource: expectedRecoverySourceRunId !== undefined,
      terminalSourceRunId: expectedRecoverySourceRunId,
    }),
    abortedLastRun: false,
    endedAt,
    pendingFinalDelivery: undefined,
    pendingFinalDeliveryText: undefined,
    pendingFinalDeliveryCreatedAt: undefined,
    pendingFinalDeliveryLastAttemptAt: undefined,
    pendingFinalDeliveryAttemptCount: undefined,
    pendingFinalDeliveryLastError: undefined,
    pendingFinalDeliveryContext: undefined,
    pendingFinalDeliveryIntentId: undefined,
    restartRecoveryForceSafeTools: undefined,
    restartRecoveryRuns: undefined,
    runtimeMs:
      typeof params.entry.startedAt === "number"
        ? Math.max(0, endedAt - params.entry.startedAt)
        : undefined,
    status: "done",
    updatedAt: endedAt,
  };
  const sourceTurnId = normalizeOptionalString(params.sourceTurnId);
  if (params.reason === "handled-silent" && !sourceTurnId) {
    return {
      outcome: "unsafe-transcript",
      reason: "handled silent checkpoint lacks its durable source turn",
    };
  }
  const sourceTurnRange = sourceTurnId
    ? findSourceTurnRange({
        continuationRunId: expectedRecoveryRunId,
        messages: params.messages,
        sourceTurnId,
      })
    : undefined;
  const toolCallId = normalizeOptionalString(params.toolCallId);
  if (sourceTurnId && sourceTurnRange === undefined) {
    return {
      outcome: "unsafe-transcript",
      reason: "recovery checkpoint cannot be matched to its durable source turn",
    };
  }
  if (sourceTurnRange && sourceTurnRange.endIndex !== params.messages.length) {
    return {
      outcome: "unsafe-transcript",
      reason: "recovery checkpoint belongs to an earlier transcript turn",
    };
  }
  if (toolCallId && !sourceTurnId) {
    return {
      outcome: "unsafe-transcript",
      reason: "terminal delivery lacks its durable source turn",
    };
  }
  const messageToolCallIndex =
    toolCallId && sourceTurnRange
      ? findMessageToolCallIndexInSourceTurn({
          messages: params.messages,
          sourceTurnRange,
          toolCallId,
        })
      : undefined;
  if (toolCallId && messageToolCallIndex === undefined) {
    return {
      outcome: "unsafe-transcript",
      reason: "terminal delivery cannot be matched to its message tool call",
    };
  }
  if (
    messageToolCallIndex !== undefined &&
    hasSiblingAssistantToolCalls(params.messages[messageToolCallIndex])
  ) {
    return {
      outcome: "unsafe-transcript",
      reason: "terminal message tool call has sibling tool work",
    };
  }
  const recoveryToolResultIdempotencyKey =
    toolCallId && sourceTurnId
      ? buildRecoveryToolResultIdempotencyKey(sourceTurnId, toolCallId)
      : undefined;
  const successfulToolResultIndex =
    toolCallId && sourceTurnRange && messageToolCallIndex !== undefined
      ? findSuccessfulMessageToolResultIndex({
          messages: params.messages,
          sourceTurnRange,
          toolCallId,
          toolCallIndex: messageToolCallIndex,
        })
      : undefined;
  if (
    toolCallId &&
    sourceTurnId &&
    sourceTurnRange !== undefined &&
    messageToolCallIndex !== undefined &&
    !canReconcileTerminalDeliveryAtSourceTurnTail({
      messages: params.messages,
      sourceTurnId,
      sourceTurnRange,
      toolCallId,
      toolCallIndex: messageToolCallIndex,
      successfulToolResultIndex,
    })
  ) {
    return {
      outcome: "unsafe-transcript",
      reason:
        successfulToolResultIndex === undefined
          ? "terminal delivery would require an out-of-order transcript repair"
          : "terminal delivery result is followed by unfinished transcript work",
    };
  }
  if (
    toolCallId &&
    sourceTurnId &&
    sourceTurnRange !== undefined &&
    messageToolCallIndex !== undefined &&
    recoveryToolResultIdempotencyKey &&
    successfulToolResultIndex === undefined
  ) {
    const expectedSessionState: SessionTranscriptTurnExpectedState = {
      abortedLastRun: params.entry.abortedLastRun,
      restartRecoveryBeforeAgentReplyState: params.entry.restartRecoveryBeforeAgentReplyState,
      restartRecoveryDeliveryReceiptState: params.entry.restartRecoveryDeliveryReceiptState,
      restartRecoveryDeliveryToolCallId: params.entry.restartRecoveryDeliveryToolCallId,
      restartRecoveryDeliveryRequestFingerprint:
        params.entry.restartRecoveryDeliveryRequestFingerprint,
      restartRecoveryDeliveryRunId: params.entry.restartRecoveryDeliveryRunId,
      restartRecoveryDeliverySourceRunId: params.entry.restartRecoveryDeliverySourceRunId,
      restartRecoveryRequesterAccountId: params.entry.restartRecoveryRequesterAccountId,
      restartRecoveryRequesterSenderId: params.entry.restartRecoveryRequesterSenderId,
      restartRecoverySameChannelThreadRequired:
        params.entry.restartRecoverySameChannelThreadRequired,
      restartRecoverySourceIngress: params.entry.restartRecoverySourceIngress,
      restartRecoverySourceReplyDeliveryMode: params.entry.restartRecoverySourceReplyDeliveryMode,
      restartRecoveryTerminalRunIds: params.entry.restartRecoveryTerminalRunIds,
      status: params.entry.status,
      updatedAt: params.entry.updatedAt,
    };
    const persisted = await persistSessionTranscriptTurn(
      {
        agentId: resolveAgentIdFromSessionKey(params.sessionKey),
        sessionId: params.entry.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      {
        expectedSessionId: params.entry.sessionId,
        expectedSessionState,
        messages: [
          {
            idempotencyLookup: "scan",
            message: {
              role: "toolResult",
              toolCallId,
              toolName: "message",
              content: [{ type: "text", text: "Message delivered before gateway restart." }],
              idempotencyKey: recoveryToolResultIdempotencyKey,
              isError: false,
              timestamp: endedAt,
            },
          },
        ],
        sessionLifecyclePatch: lifecyclePatch,
        updateMode: "none",
      },
    );
    const completed = persisted.sessionEntry?.status === "done";
    if (completed) {
      log.info(`reconciled delivered terminal reply after restart: ${params.sessionKey}`);
    }
    return { outcome: completed ? "completed" : "changed" };
  }
  const marked = await applySessionEntryReplacements({
    sessionKeys: [params.sessionKey],
    storePath: params.storePath,
    update: (entries) => {
      const current = entries.find((candidate) => candidate.sessionKey === params.sessionKey);
      const entry = current?.entry;
      if (
        !entry ||
        entry.sessionId !== params.entry.sessionId ||
        entry.status !== "running" ||
        entry.abortedLastRun !== true ||
        normalizeOptionalString(entry.restartRecoveryDeliveryRunId) !== expectedRecoveryRunId ||
        normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) !==
          expectedRecoverySourceRunId
      ) {
        return { result: false };
      }
      Object.assign(entry, lifecyclePatch);
      return {
        result: true,
        replacements: [{ sessionKey: params.sessionKey, entry }],
      };
    },
  });
  if (marked) {
    log.info(
      params.reason === "delivered-terminal" || params.reason === "delivered-terminal-receipt"
        ? `reconciled delivered terminal reply after restart: ${params.sessionKey}`
        : `reconciled handled silent reply after restart: ${params.sessionKey}`,
    );
  }
  return { outcome: marked ? "completed" : "changed" };
}

async function sendUnresumableSessionNotice(params: {
  deliveryContext: DeliveryContext;
  entry: SessionEntry;
  reason: string;
  sessionKey: string;
  gatewayRuntime: GatewayRecoveryRuntime;
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
    await params.gatewayRuntime.sendRecoveryNotice(actionParams, 10_000);
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
      restartRecoveryBeforeAgentReplyState: params.entry.restartRecoveryBeforeAgentReplyState,
      restartRecoveryDeliveryReceiptState: params.entry.restartRecoveryDeliveryReceiptState,
      restartRecoveryDeliveryToolCallId: params.entry.restartRecoveryDeliveryToolCallId,
      restartRecoveryDeliveryRequestFingerprint:
        params.entry.restartRecoveryDeliveryRequestFingerprint,
      restartRecoveryDeliveryRunId: params.entry.restartRecoveryDeliveryRunId,
      restartRecoveryDeliverySourceRunId: params.entry.restartRecoveryDeliverySourceRunId,
      restartRecoveryRequesterAccountId: params.entry.restartRecoveryRequesterAccountId,
      restartRecoveryRequesterSenderId: params.entry.restartRecoveryRequesterSenderId,
      restartRecoverySameChannelThreadRequired:
        params.entry.restartRecoverySameChannelThreadRequired,
      restartRecoverySourceIngress: params.entry.restartRecoverySourceIngress,
      restartRecoverySourceReplyDeliveryMode: params.entry.restartRecoverySourceReplyDeliveryMode,
      restartRecoveryTerminalRunIds: params.entry.restartRecoveryTerminalRunIds,
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

async function failUnresumableMainSession(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  gatewayRuntime: GatewayRecoveryRuntime;
  observation: MainSessionRecoveryObservation;
  reason: string;
  sessionKey: string;
  storePath: string;
}): Promise<"failed" | "skipped"> {
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    includeSessionDeliveryFallback: true,
    sessionKey: params.sessionKey,
  });
  if (
    !deliveryContext &&
    !(await writeUnresumableSessionNotice({
      entry: params.entry,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    }))
  ) {
    // Keep ownership for another recovery attempt until its terminal notice is durable.
    return "failed";
  }
  const marked = await markSessionFailed({
    observation: params.observation,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    reason: params.reason,
  });
  if (!marked) {
    return "skipped";
  }
  if (deliveryContext) {
    await sendUnresumableSessionNotice({
      deliveryContext,
      entry: params.entry,
      gatewayRuntime: params.gatewayRuntime,
      reason: params.reason,
      sessionKey: params.sessionKey,
    });
  }
  return "failed";
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
        transitionMainSessionRecovery(entry, {
          kind: "mark_interrupted",
          cycleId: randomUUID(),
          now: Date.now(),
        });
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
  observationOnly?: boolean;
  onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
  storePath: string;
  resumedSessionKeys: Set<string>;
  expectedClaim?: ExpectedRestartRecoveryClaim;
  expectedTarget?: ExpectedRestartRecoveryTarget;
  sessionWorkAdmissionHandoffId?: string;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  gatewayRuntime: GatewayRecoveryRuntime;
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
    } else if (params.expectedTarget) {
      const entry = loadExpectedRestartRecoveryTarget({
        expected: params.expectedTarget,
        storePath: params.storePath,
      });
      entries = entry ? [{ sessionKey: params.expectedTarget.sessionKey, entry }] : [];
    } else {
      entries = listSessionEntriesByStatus({ storePath: params.storePath }, ["running"]);
    }
  } catch (err) {
    log.warn(`failed to load session store ${params.storePath}: ${String(err)}`);
    result.failed++;
    return result;
  }

  for (const { sessionKey, entry: loadedEntry } of entries.toSorted((a, b) =>
    a.sessionKey.localeCompare(b.sessionKey),
  )) {
    let entry = loadedEntry;
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
      params.expectedClaim?.canonicalSessionKey ??
      params.expectedTarget?.canonicalSessionKey ??
      resolvedDispatchSessionKey;
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

    const observed = await commitMainSessionRecovery({
      command: {
        kind: "observe",
        cycleId: randomUUID(),
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        sessionKey,
      },
      requireWriteSuccess: true,
      target: { sessionKey, storePath: params.storePath },
    });
    if (!observed.entry || observed.transition.kind !== "observed") {
      result.skipped++;
      continue;
    }
    entry = observed.entry;
    const recoveryView = observed.transition.view;
    if (
      recoveryView.status === "inactive" ||
      recoveryView.status === "blocked" ||
      recoveryView.status === "tombstoned"
    ) {
      result.skipped++;
      continue;
    }
    if (recoveryView.status === "exhausted") {
      const tombstone = await tombstoneMainRestartRecoveryWithNotice({
        cfg: params.cfg,
        entry,
        gatewayRuntime: params.gatewayRuntime,
        observation: recoveryView.observation,
        reason: recoveryView.reason,
        sessionKey,
        storePath: params.storePath,
      });
      if (tombstone === "notice_failed") {
        result.failed++;
      } else {
        result.skipped++;
      }
      continue;
    }
    if (params.observationOnly) {
      result.skipped++;
      continue;
    }
    const recordResumeResult = (resumeResult: Awaited<ReturnType<typeof resumeMainSession>>) => {
      if (resumeResult === "resumed") {
        params.resumedSessionKeys.add(resumeDedupeKey);
        result.recovered++;
      } else if (resumeResult === "skipped") {
        result.skipped++;
      } else {
        result.failed++;
        const current = loadExpectedRestartRecoveryTarget({
          expected: { sessionId: entry.sessionId, sessionKey },
          storePath: params.storePath,
        });
        if (
          current?.mainRestartRecovery?.chargedAttempts === MAX_RECOVERY_RETRIES &&
          !current.mainRestartRecovery.reservation
        ) {
          params.onExhaustedTarget?.({
            canonicalSessionKey: dispatchSessionKey,
            sessionId: entry.sessionId,
            sessionKey,
            storePath: params.storePath,
          });
        }
      }
    };

    if (
      requiresRestartRecoveryMessageActionAuthority(entry) &&
      !hasRestartRecoveryMessageActionAuthority(entry)
    ) {
      const disposition = await failUnresumableMainSession({
        cfg: params.cfg,
        entry,
        gatewayRuntime: params.gatewayRuntime,
        observation: recoveryView.observation,
        reason: "message-tool-only recovery authority is unavailable",
        sessionKey,
        storePath: params.storePath,
      });
      result[disposition]++;
      continue;
    }

    const expectedRecoverySourceRunId = normalizeOptionalString(
      entry.restartRecoveryDeliverySourceRunId,
    );
    let resumeBlockReason: string | undefined;
    let resumeSafetyResolved = false;
    const failBlockedResume = async (): Promise<boolean> => {
      if (!resumeSafetyResolved) {
        resumeSafetyResolved = true;
        resumeBlockReason = resolveRestartRecoveryResumeBlockReason({
          cfg: params.cfg,
          entry,
          sessionKey,
        });
      }
      if (!resumeBlockReason) {
        return false;
      }
      const disposition = await failUnresumableMainSession({
        cfg: params.cfg,
        entry,
        gatewayRuntime: params.gatewayRuntime,
        observation: recoveryView.observation,
        reason: resumeBlockReason,
        sessionKey,
        storePath: params.storePath,
      });
      result[disposition]++;
      return true;
    };

    if (
      entry.pendingFinalDelivery === true &&
      entry.pendingFinalDeliveryText &&
      entry.restartRecoveryForceSafeTools === true
    ) {
      if (await failBlockedResume()) {
        continue;
      }
      const resumed = await resumeMainSession({
        canonicalSessionKey: dispatchSessionKey,
        cfg: params.cfg,
        entry,
        observation: recoveryView.observation,
        recoveryAttempt: recoveryView.nextAttempt,
        storePath: params.storePath,
        sessionKey,
        pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
        forceRestartSafeTools: true,
        sessionWorkAdmissionHandoffId: params.sessionWorkAdmissionHandoffId,
        gatewayRuntime: params.gatewayRuntime,
      });
      recordResumeResult(resumed);
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
        if (await failBlockedResume()) {
          continue;
        }
        log.warn(
          `transcript unavailable for ${sessionKey}; resuming its durable pending final delivery`,
        );
        const resumed = await resumeMainSession({
          canonicalSessionKey: dispatchSessionKey,
          cfg: params.cfg,
          entry,
          observation: recoveryView.observation,
          recoveryAttempt: recoveryView.nextAttempt,
          storePath: params.storePath,
          sessionKey,
          pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
          sessionWorkAdmissionHandoffId: params.sessionWorkAdmissionHandoffId,
          gatewayRuntime: params.gatewayRuntime,
        });
        recordResumeResult(resumed);
        continue;
      }
      log.warn(`failed to read transcript for ${sessionKey}: ${String(err)}`);
      result.failed++;
      continue;
    }

    if (entry.pendingFinalDelivery === true && entry.pendingFinalDeliveryText) {
      if (await failBlockedResume()) {
        continue;
      }
      const resumed = await resumeMainSession({
        canonicalSessionKey: dispatchSessionKey,
        cfg: params.cfg,
        entry,
        observation: recoveryView.observation,
        recoveryAttempt: recoveryView.nextAttempt,
        storePath: params.storePath,
        sessionKey,
        pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
        forceRestartSafeTools: hasReplaySafeCodeModeCheckpointInCurrentTurn(messages),
        sessionWorkAdmissionHandoffId: params.sessionWorkAdmissionHandoffId,
        gatewayRuntime: params.gatewayRuntime,
      });
      recordResumeResult(resumed);
      continue;
    }

    const resumePolicy = resolveMainSessionResumePolicy(
      messages,
      entry.restartRecoveryForceSafeTools === true,
      expectedRecoverySourceRunId,
      entry.restartRecoveryBeforeAgentReplyState,
      entry.restartRecoveryDeliveryReceiptState,
      entry.restartRecoveryDeliveryToolCallId,
    );
    if (resumePolicy.action === "complete") {
      const completion = await markSessionCompletedAfterRecoveryCheckpoint({
        entry,
        messages,
        reason: resumePolicy.reason,
        storePath: params.storePath,
        sessionKey,
        sourceTurnId: expectedRecoverySourceRunId,
        ...(resumePolicy.reason === "handled-silent"
          ? {}
          : {
              toolCallId: resumePolicy.toolCallId,
            }),
      });
      if (completion.outcome === "completed") {
        params.resumedSessionKeys.add(resumeDedupeKey);
        result.recovered++;
      } else if (completion.outcome === "changed") {
        result.skipped++;
      } else {
        const disposition = await failUnresumableMainSession({
          cfg: params.cfg,
          entry,
          gatewayRuntime: params.gatewayRuntime,
          observation: recoveryView.observation,
          reason: completion.reason,
          sessionKey,
          storePath: params.storePath,
        });
        result[disposition]++;
      }
      continue;
    }
    if (resumePolicy.action === "fail") {
      const disposition = await failUnresumableMainSession({
        cfg: params.cfg,
        entry,
        gatewayRuntime: params.gatewayRuntime,
        observation: recoveryView.observation,
        reason: resumePolicy.reason,
        sessionKey,
        storePath: params.storePath,
      });
      result[disposition]++;
      continue;
    }

    if (await failBlockedResume()) {
      continue;
    }
    const resumed = await resumeMainSession({
      canonicalSessionKey: dispatchSessionKey,
      cfg: params.cfg,
      entry,
      observation: recoveryView.observation,
      recoveryAttempt: recoveryView.nextAttempt,
      storePath: params.storePath,
      sessionKey,
      pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
      forceRestartSafeTools:
        entry.restartRecoveryForceSafeTools === true || resumePolicy.forceRestartSafeTools,
      sessionWorkAdmissionHandoffId: params.sessionWorkAdmissionHandoffId,
      gatewayRuntime: params.gatewayRuntime,
    });
    recordResumeResult(resumed);
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

async function recoverRestartAbortedMainSessionsWithOptions(params: {
  cfg?: OpenClawConfig;
  onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
  stateDir?: string;
  resumedSessionKeys?: Set<string>;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const resumedSessionKeys = params.resumedSessionKeys ?? new Set<string>();

  for (const storePath of await resolveRestartRecoveryStorePaths(params)) {
    const storeResult = await recoverStore({
      cfg: params.cfg,
      onExhaustedTarget: params.onExhaustedTarget,
      storePath,
      resumedSessionKeys,
      activeSessionIds: params.activeSessionIds,
      activeSessionKeys: params.activeSessionKeys,
      gatewayRuntime: params.gatewayRuntime,
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

export async function recoverRestartAbortedMainSessions(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  resumedSessionKeys?: Set<string>;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  return await recoverRestartAbortedMainSessionsWithOptions(params);
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
  gatewayRuntime: GatewayRecoveryRuntime;
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
          gatewayRuntime: params.gatewayRuntime,
        }),
    );
  } finally {
    cancelSessionWorkAdmissionHandoff(handoffId);
    admission.release();
  }
}

/** Reconciles one interrupted row after its final foreground owner releases. */
export async function retryRestartAbortedMainSessionRecoveryAfterOwnerRelease(params: {
  cfg?: OpenClawConfig;
  expectedSessionId: string;
  sessionKey: string;
  storePath: string;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  return await recoverExpectedRestartRecoveryTarget(params);
}

async function recoverExpectedRestartRecoveryTarget(params: {
  canonicalSessionKey?: string;
  cfg?: OpenClawConfig;
  expectedSessionId: string;
  observationOnly?: boolean;
  sessionKey: string;
  storePath: string;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const expectedTarget: ExpectedRestartRecoveryTarget = {
    canonicalSessionKey: params.canonicalSessionKey,
    sessionId: params.expectedSessionId,
    sessionKey: params.sessionKey,
  };
  const assertTargetCurrent = () => {
    if (
      !loadExpectedRestartRecoveryTarget({ expected: expectedTarget, storePath: params.storePath })
    ) {
      throw new Error("restart recovery session ownership changed before owner-release retry");
    }
  };
  if (
    !loadExpectedRestartRecoveryTarget({ expected: expectedTarget, storePath: params.storePath })
  ) {
    return { recovered: 0, failed: 0, skipped: 0 };
  }
  const admission = await beginSessionWorkAdmission({
    scope: params.storePath,
    identities: [params.sessionKey, params.expectedSessionId],
    assertAllowed: assertTargetCurrent,
    revalidateAllowed: assertTargetCurrent,
  });
  const handoffId = admission.createHandoff();
  try {
    return await admission.run(
      async () =>
        await recoverStore({
          cfg: params.cfg,
          observationOnly: params.observationOnly,
          storePath: params.storePath,
          resumedSessionKeys: new Set<string>(),
          expectedTarget,
          sessionWorkAdmissionHandoffId: handoffId,
          gatewayRuntime: params.gatewayRuntime,
        }),
    );
  } finally {
    cancelSessionWorkAdmissionHandoff(handoffId);
    admission.release();
  }
}

export function scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease(params: {
  delayMs?: number;
  expectedSessionId: string;
  getConfig: () => OpenClawConfig;
  getGatewayRuntime: () => GatewayRecoveryRuntime | undefined;
  maxRetries?: number;
  sessionKey: string;
  storePath: string;
}): void {
  const retryDelayMs = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
  const scheduleAttempt = (attempt: number, delayMs: number) => {
    const run = () => {
      void runWithGatewayIndependentRootWorkAdmission(async () => {
        const gatewayRuntime = params.getGatewayRuntime();
        if (!gatewayRuntime) {
          throw new Error("Gateway recovery runtime is unavailable");
        }
        return await retryRestartAbortedMainSessionRecoveryAfterOwnerRelease({
          cfg: params.getConfig(),
          expectedSessionId: params.expectedSessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          gatewayRuntime,
        });
      })
        .then((result) => {
          const stillPending = loadExpectedRestartRecoveryTarget({
            expected: {
              sessionId: params.expectedSessionId,
              sessionKey: params.sessionKey,
            },
            storePath: params.storePath,
          });
          if (
            (result.failed > 0 || (result.recovered === 0 && stillPending)) &&
            attempt < maxRetries
          ) {
            scheduleAttempt(attempt + 1, retryDelayMs * 2 ** (attempt - 1));
          } else if (
            attempt === maxRetries &&
            stillPending?.mainRestartRecovery?.chargedAttempts === MAX_RECOVERY_RETRIES &&
            !stillPending.mainRestartRecovery.reservation
          ) {
            // The last ambiguous dispatch consumed the final durable charge.
            // One exact observation tombstones exhaustion without dispatching again.
            scheduleAttempt(attempt + 1, 0);
          }
        })
        .catch((error: unknown) => {
          if (attempt < maxRetries) {
            scheduleAttempt(attempt + 1, retryDelayMs * 2 ** (attempt - 1));
          } else {
            log.warn(`main-session owner-release recovery failed: ${String(error)}`);
          }
        });
    };
    if (delayMs <= 0) {
      run();
    } else {
      setTimeout(run, delayMs).unref?.();
    }
  };
  scheduleAttempt(1, 0);
}

async function recoverStartupOrphanedMainSessionsWithOptions(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  updatedBeforeMs?: number;
  resumedSessionKeys?: Set<string>;
  onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ marked: number; recovered: number; failed: number; skipped: number }> {
  const startupRecoveryCutoffMs = params.updatedBeforeMs ?? Date.now();
  const marked = await markStartupOrphanedMainSessionsForRecovery({
    cfg: params.cfg,
    stateDir: params.stateDir,
    activeSessionIds: params.activeSessionIds,
    activeSessionKeys: params.activeSessionKeys,
    updatedBeforeMs: startupRecoveryCutoffMs,
  });
  const recovered = await recoverRestartAbortedMainSessionsWithOptions({
    cfg: params.cfg,
    onExhaustedTarget: params.onExhaustedTarget,
    stateDir: params.stateDir,
    resumedSessionKeys: params.resumedSessionKeys,
    activeSessionIds: params.activeSessionIds,
    activeSessionKeys: params.activeSessionKeys,
    gatewayRuntime: params.gatewayRuntime,
  });
  return {
    marked: marked.marked,
    recovered: recovered.recovered,
    failed: recovered.failed,
    skipped: marked.skipped + recovered.skipped,
  };
}

export async function recoverStartupOrphanedMainSessions(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  updatedBeforeMs?: number;
  resumedSessionKeys?: Set<string>;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ marked: number; recovered: number; failed: number; skipped: number }> {
  return await recoverStartupOrphanedMainSessionsWithOptions(params);
}

export function scheduleRestartAbortedMainSessionRecovery(params: {
  cfg?: OpenClawConfig;
  delayMs?: number;
  maxRetries?: number;
  stateDir?: string;
  gatewayRuntime: GatewayRecoveryRuntime;
}): void {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
  const resumedSessionKeys = new Set<string>();
  // Only reconcile rows that existed before this startup recovery was scheduled.
  // Fresh runs started by this gateway are protected again by the active-run check.
  const startupRecoveryCutoffMs = Date.now();

  const runRecoveryAttempt = (attempt: number, delay: number) => {
    const exhaustedTargets = new Map<string, ExhaustedRestartRecoveryTarget>();
    const reconcileExhaustedTargets = async () => {
      const outcomes = await Promise.allSettled(
        [...exhaustedTargets.values()].map((target) =>
          runWithGatewayIndependentRootWorkAdmission(
            async () =>
              await recoverExpectedRestartRecoveryTarget({
                canonicalSessionKey: target.canonicalSessionKey,
                cfg: params.cfg,
                expectedSessionId: target.sessionId,
                observationOnly: true,
                sessionKey: target.sessionKey,
                storePath: target.storePath,
                gatewayRuntime: params.gatewayRuntime,
              }),
          ),
        ),
      );
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          log.warn(`main-session exhaustion reconciliation failed: ${String(outcome.reason)}`);
        }
      }
    };
    // Delayed retries outlive startup; each attempt must independently block
    // host suspension while it reads and rewrites recovery session state.
    void runWithGatewayIndependentRootWorkAdmission(
      async () =>
        await recoverStartupOrphanedMainSessionsWithOptions({
          cfg: params.cfg,
          onExhaustedTarget: (target) => {
            exhaustedTargets.set(`${target.storePath}\u0000${target.sessionKey}`, target);
          },
          stateDir: params.stateDir,
          resumedSessionKeys,
          updatedBeforeMs: startupRecoveryCutoffMs,
          gatewayRuntime: params.gatewayRuntime,
        }),
    )
      .then(async (result) => {
        if (result.failed > 0 && attempt < maxRetries) {
          scheduleAttempt(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
        } else if (result.failed > 0 && attempt === maxRetries && exhaustedTargets.size > 0) {
          // Reconcile only exact rows whose final dispatch retained its durable charge.
          await reconcileExhaustedTargets();
        }
      })
      .catch(async (err: unknown) => {
        if (attempt < maxRetries) {
          log.warn(`main-session restart recovery failed: ${String(err)}`);
          scheduleAttempt(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
        } else {
          log.warn(`main-session restart recovery gave up: ${String(err)}`);
          await reconcileExhaustedTargets();
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
