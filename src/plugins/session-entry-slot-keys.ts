/** Reserves session-entry keys so plugin extension slots cannot collide with core session state. */
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";

const SESSION_ENTRY_RESERVED_SLOT_KEY_LIST = [
  "__proto__",
  "constructor",
  "prototype",
  "lastHeartbeatText",
  "lastHeartbeatSentAt",
  "heartbeatIsolatedBaseSessionKey",
  "heartbeatTaskState",
  "pluginExtensions",
  "initializationPending",
  "pluginExtensionSlotKeys",
  "pluginNextTurnInjections",
  "sessionId",
  "lifecycleRevision",
  "updatedAt",
  "incognito",
  "archivedAt",
  "archivedBy",
  "pinnedAt",
  "icon",
  "lastReadAt",
  "agentStatus",
  "observerDigest",
  "markedUnreadAt",
  "lastActivityAt",
  "sessionFile",
  "spawnedBy",
  "completionOwnerSessionKey",
  "spawnedWorkspaceDir",
  "spawnedCwd",
  "worktree",
  "parentSessionKey",
  "createdVia",
  "createdActor",
  "createdAt",
  "forkSource",
  "previousSessionId",
  "forkedFromParent",
  "spawnDepth",
  "swarmGroupId",
  "swarmCollector",
  "swarmOutputSchema",
  "subagentRole",
  "subagentControlScope",
  "inheritedToolPolicyVersion",
  "inheritedToolDeny",
  "inheritedToolAllow",
  "mainRestartRecovery",
  "subagentRecovery",
  "pluginOwnerId",
  "systemSent",
  "abortedLastRun",
  "restartRecoveryRuns",
  "restartRecoveryForceSafeTools",
  "goal",
  "pendingSkillSuggestion",
  "skillCaptureSignalHashes",
  "sessionStartedAt",
  "ambientTranscriptWatermarks",
  "lastInteractionAt",
  "startedAt",
  "endedAt",
  "runtimeMs",
  "status",
  "lastRunError",
  "abortCutoffMessageSid",
  "abortCutoffTimestamp",
  "chatType",
  "thinkingLevel",
  "cronRunContinuation",
  "fastMode",
  "verboseLevel",
  "traceLevel",
  "reasoningLevel",
  "elevatedLevel",
  "ttsAuto",
  "lastTtsReadLatestHash",
  "lastTtsReadLatestAt",
  "execHost",
  "execSecurity",
  "execAsk",
  "execNode",
  "execCwd",
  "responseUsage",
  "usageFamilyKey",
  "usageFamilySessionIds",
  "providerOverride",
  "modelOverride",
  "agentRuntimeOverride",
  "modelOverrideSource",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "modelFallback",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
  "liveModelSwitchPending",
  "groupActivation",
  "groupActivationNeedsSystemIntro",
  "sendPolicy",
  "queueMode",
  "queueDebounceMs",
  "queueCap",
  "queueDrop",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "pendingFinalDelivery",
  "pendingFinalDeliveryCreatedAt",
  "pendingFinalDeliveryLastAttemptAt",
  "pendingFinalDeliveryAttemptCount",
  "pendingFinalDeliveryLastError",
  "pendingFinalDeliveryText",
  "pendingFinalDeliveryContext",
  "pendingFinalDeliveryIntentId",
  "restartRecoveryDeliveryContext",
  "restartRecoveryDeliveryMediaUrls",
  "restartRecoveryDisableMessageTool",
  "restartRecoverySuppressTextDelivery",
  "restartRecoveryDeliveryRequestFingerprint",
  "restartRecoveryDeliveryRunId",
  "restartRecoveryDeliverySourceRunId",
  "restartRecoveryBeforeAgentReplyState",
  "restartRecoveryDeliveryReceiptState",
  "restartRecoveryDeliveryToolCallId",
  "restartRecoveryRequesterAccountId",
  "restartRecoveryRequesterSenderId",
  "restartRecoverySameChannelThreadRequired",
  "restartRecoverySourceIngress",
  "restartRecoverySourceReplyDeliveryMode",
  "restartRecoveryTerminalDeliveryEvidence",
  "restartRecoveryTerminalRunIds",
  "totalTokensFresh",
  "estimatedCostUsd",
  "cacheRead",
  "cacheWrite",
  "modelProvider",
  "model",
  "modelSelectionLocked",
  "agentHarnessId",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
  "contextTokens",
  "contextBudgetStatus",
  "compactionCount",
  "compactionCheckpoints",
  "memoryFlushAt",
  "memoryFlushCompactionCount",
  "memoryFlushContextHash",
  "memoryFlushFailureCount",
  "memoryFlushLastFailedAt",
  "memoryFlushLastFailureError",
  "cliSessionIds",
  "cliSessionBindings",
  "claudeCliSessionId",
  "label",
  "category",
  "displayName",
  "delivery",
  "groupId",
  "subject",
  "groupChannel",
  "space",
  "skillsSnapshot",
  "systemPromptReport",
  "pluginDebugEntries",
  "hookExternalContentSource",
  "acp",
  "quotaSuspension",
  "visibility",
] as const satisfies ReadonlyArray<keyof SessionEntry | "__proto__" | "constructor" | "prototype">;

type ReservedSessionEntrySlotKey = Extract<
  (typeof SESSION_ENTRY_RESERVED_SLOT_KEY_LIST)[number],
  keyof SessionEntry
>;
type MissingSessionEntryReservedSlotKey = Exclude<keyof SessionEntry, ReservedSessionEntrySlotKey>;
type SessionEntryReservedSlotSetValue = [MissingSessionEntryReservedSlotKey] extends [never]
  ? string
  : never;

// Keep the value type impossible if a new SessionEntry field is missing from the reserved list.
const SESSION_ENTRY_RESERVED_SLOT_KEYS = new Set<SessionEntryReservedSlotSetValue>(
  SESSION_ENTRY_RESERVED_SLOT_KEY_LIST,
);
const RETIRED_SESSION_DELIVERY_SLOT_KEYS = new Set<string>([
  "channel",
  "origin",
  "route",
  "deliveryContext",
  "lastChannel",
  "lastTo",
  "lastAccountId",
  "lastThreadId",
]);
const OBJECT_PROTOTYPE_RESERVED_SLOT_KEYS = new Set<string>([
  "prototype",
  ...Object.getOwnPropertyNames(Object.prototype),
]);

const SESSION_ENTRY_SLOT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/u;

export function normalizeSessionEntrySlotKey(
  value: unknown,
): { ok: true; key: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "sessionEntrySlotKey must be a string" };
  }
  const key = value.trim();
  if (!key) {
    return { ok: false, error: "sessionEntrySlotKey cannot be empty" };
  }
  if (!SESSION_ENTRY_SLOT_KEY_RE.test(key)) {
    return {
      ok: false,
      error: "sessionEntrySlotKey must be an identifier-style field name",
    };
  }
  if (SESSION_ENTRY_RESERVED_SLOT_KEYS.has(key) || RETIRED_SESSION_DELIVERY_SLOT_KEYS.has(key)) {
    return {
      ok: false,
      error: `sessionEntrySlotKey is reserved by SessionEntry: ${key}`,
    };
  }
  if (OBJECT_PROTOTYPE_RESERVED_SLOT_KEYS.has(key)) {
    return {
      ok: false,
      error: `sessionEntrySlotKey is reserved by Object: ${key}`,
    };
  }
  return { ok: true, key };
}
