import crypto from "node:crypto";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
} from "../../config/sessions/reset-policy.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const FRESH_CRON_CARRIED_PREFERENCE_FIELDS = [
  "heartbeatTaskState",
  "chatType",
  "thinkingLevel",
  "fastMode",
  "verboseLevel",
  "traceLevel",
  "reasoningLevel",
  "ttsAuto",
  "responseUsage",
  "label",
  "displayName",
] as const satisfies readonly (keyof SessionEntry)[];

const AMBIENT_SESSION_CONTEXT_FIELDS = [
  "elevatedLevel",
  "groupActivation",
  "groupActivationNeedsSystemIntro",
  "sendPolicy",
  "queueMode",
  "queueDebounceMs",
  "queueCap",
  "queueDrop",
  "channel",
  "groupId",
  "subject",
  "groupChannel",
  "space",
  "origin",
  "acp",
] as const satisfies readonly (keyof SessionEntry)[];

function cloneSessionField<T>(value: T): T {
  return globalThis.structuredClone(value);
}

function copySessionFields(
  target: SessionEntry,
  entry: SessionEntry,
  fields: readonly (keyof SessionEntry)[],
): void {
  for (const field of fields) {
    if (entry[field] !== undefined) {
      target[field] = cloneSessionField(entry[field]) as never;
    }
  }
}

function preserveNonAutoModelOverride(target: SessionEntry, entry: SessionEntry): void {
  if (entry.modelOverrideSource !== "auto") {
    if (entry.modelOverride !== undefined) {
      target.modelOverride = entry.modelOverride;
    }
    if (entry.providerOverride !== undefined) {
      target.providerOverride = entry.providerOverride;
    }
    if (entry.modelOverrideSource !== undefined) {
      target.modelOverrideSource = entry.modelOverrideSource;
    }
  }
}

function preserveUserAuthOverride(target: SessionEntry, entry: SessionEntry): void {
  if (entry.authProfileOverrideSource === "user") {
    if (entry.authProfileOverride !== undefined) {
      target.authProfileOverride = entry.authProfileOverride;
    }
    target.authProfileOverrideSource = entry.authProfileOverrideSource;
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      target.authProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
    }
  }
}

function sanitizeFreshCronSessionEntry(
  entry: SessionEntry,
  options: { preserveAmbientContext: boolean },
): SessionEntry {
  const next = {} as SessionEntry;

  copySessionFields(next, entry, FRESH_CRON_CARRIED_PREFERENCE_FIELDS);
  if (options.preserveAmbientContext) {
    copySessionFields(next, entry, AMBIENT_SESSION_CONTEXT_FIELDS);
  }
  preserveNonAutoModelOverride(next, entry);
  preserveUserAuthOverride(next, entry);

  return next;
}

export function resolveCronSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  nowMs: number;
  agentId: string;
  forceNew?: boolean;
}) {
  const sessionCfg = params.cfg.session;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];

  // Check if we can reuse an existing session
  let sessionId: string;
  let isNewSession: boolean;
  let systemSent: boolean;

  if (!params.forceNew && entry?.sessionId) {
    // Evaluate freshness using the configured reset policy
    // Cron/webhook sessions use "direct" reset type (1:1 conversation style)
    const resetPolicy = resolveSessionResetPolicy({
      sessionCfg,
      resetType: "direct",
    });
    const freshness = evaluateSessionFreshness({
      updatedAt: entry.updatedAt,
      now: params.nowMs,
      policy: resetPolicy,
    });

    if (freshness.fresh) {
      // Reuse existing session
      sessionId = entry.sessionId;
      isNewSession = false;
      systemSent = entry.systemSent ?? false;
    } else {
      // Session expired, create new
      sessionId = crypto.randomUUID();
      isNewSession = true;
      systemSent = false;
    }
  } else {
    // No existing session or forced new
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
  }

  const previousSessionId = isNewSession ? entry?.sessionId : undefined;
  clearBootstrapSnapshotOnSessionRollover({
    sessionKey: params.sessionKey,
    previousSessionId,
  });

  const baseEntry = entry
    ? isNewSession
      ? sanitizeFreshCronSessionEntry(entry, { preserveAmbientContext: !params.forceNew })
      : entry
    : undefined;

  const sessionEntry: SessionEntry = {
    // Preserve existing per-session overrides even when rolling to a new sessionId.
    ...baseEntry,
    // Always update these core fields
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession, previousSessionId };
}
