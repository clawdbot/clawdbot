import type { SessionEntry } from "../config/sessions/types.js";

const SESSION_ENTRY_RESERVED_SLOT_KEY_LIST = [
  "__proto__",
  "constructor",
  "prototype",
  "lastHeartbeatText",
  "lastHeartbeatSentAt",
  "heartbeatIsolatedBaseSessionKey",
  "heartbeatTaskState",
  "pluginExtensions",
  "pluginExtensionSlotKeys",
  "pluginNextTurnInjections",
  "sessionId",
  "updatedAt",
  "sessionFile",
  "spawnedBy",
  "spawnedWorkspaceDir",
  "parentSessionKey",
  "forkedFromParent",
  "spawnDepth",
  "subagentRole",
  "subagentControlScope",
  "subagentRecovery",
  "pluginOwnerId",
  "systemSent",
  "abortedLastRun",
  "sessionStartedAt",
  "lastInteractionAt",
  "startedAt",
  "endedAt",
  "runtimeMs",
  "status",
  "abortCutoffMessageSid",
  "abortCutoffTimestamp",
  "chatType",
  "thinkingLevel",
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
  "responseUsage",
  "usageFamilyKey",
  "usageFamilySessionIds",
  "providerOverride",
  "modelOverride",
  "agentRuntimeOverride",
  "modelOverrideSource",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
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
  "totalTokensFresh",
  "estimatedCostUsd",
  "cacheRead",
  "cacheWrite",
  "modelProvider",
  "model",
  "agentHarnessId",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
  "contextTokens",
  "compactionCount",
  "compactionCheckpoints",
  "memoryFlushAt",
  "memoryFlushCompactionCount",
  "memoryFlushContextHash",
  "cliSessionIds",
  "cliSessionBindings",
  "claudeCliSessionId",
  "label",
  "displayName",
  "channel",
  "groupId",
  "subject",
  "groupChannel",
  "space",
  "origin",
  "deliveryContext",
  "lastChannel",
  "lastTo",
  "lastAccountId",
  "lastThreadId",
  "skillsSnapshot",
  "systemPromptReport",
  "pluginDebugEntries",
  "acp",
  "quotaSuspension",
] as const satisfies ReadonlyArray<keyof SessionEntry | "__proto__" | "constructor" | "prototype">;

type ReservedSessionEntrySlotKey = Extract<
  (typeof SESSION_ENTRY_RESERVED_SLOT_KEY_LIST)[number],
  keyof SessionEntry
>;
type MissingSessionEntryReservedSlotKeys = Exclude<keyof SessionEntry, ReservedSessionEntrySlotKey>;
type AssertNever<T extends never> = T;
type _AssertAllSessionEntryKeysAreReserved = AssertNever<MissingSessionEntryReservedSlotKeys>;

const SESSION_ENTRY_RESERVED_SLOT_KEYS = new Set<string>(SESSION_ENTRY_RESERVED_SLOT_KEY_LIST);
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
  if (SESSION_ENTRY_RESERVED_SLOT_KEYS.has(key)) {
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
