// Persists and resolves per-session model override choices.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasSessionAutoModelFallbackProvenance } from "../../agents/agent-scope.js";
import { resolveCliRuntimeCanonicalProvider } from "../../agents/cli-backends.js";
import {
  modelKey,
  normalizeModelRef,
  normalizeStoredOverrideModel,
  resolvePersistedOverrideModelRef,
} from "../../agents/model-selection.js";
import { RUNTIME_MODEL_VISIBILITY_NORMALIZATION } from "../../agents/model-visibility-policy.js";
import { resolveSessionParentSessionKey } from "../../channels/plugins/session-conversation.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Model override loaded from the current session or its parent session. */
export type StoredModelOverride = {
  provider?: string;
  model: string;
  source: "session" | "parent";
};

/** Normalizes a stored model ref, resolving runtime aliases only for CLI-bound sessions. */
export function normalizeStoredRuntimeModelRef(
  provider: string,
  model: string,
  cfg?: OpenClawConfig,
  sessionEntry?: SessionEntry,
) {
  const normalized = normalizeModelRef(provider, model, RUNTIME_MODEL_VISIBILITY_NORMALIZATION);
  const hasCliSessionBinding =
    sessionEntry?.cliSessionBindings?.[normalized.provider] !== undefined;
  const canonicalProvider =
    cfg && hasCliSessionBinding
      ? resolveCliRuntimeCanonicalProvider({
          runtime: normalized.provider,
          config: cfg,
          includeSetupRegistry: true,
        })
      : undefined;
  return canonicalProvider ? { ...normalized, provider: canonicalProvider } : normalized;
}

function resolveParentSessionKeyCandidate(params: {
  sessionKey?: string;
  parentSessionKey?: string;
}): string | null {
  const explicit = normalizeOptionalString(params.parentSessionKey);
  if (explicit && explicit !== params.sessionKey) {
    return explicit;
  }
  const derived = resolveSessionParentSessionKey(params.sessionKey);
  if (derived && derived !== params.sessionKey) {
    return derived;
  }
  return null;
}

/** Resolves the persisted model override visible to the current session. */
export function resolveStoredModelOverride(params: {
  loadSessionEntry?: (sessionKey: string) => SessionEntry | undefined;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  defaultProvider: string;
}): StoredModelOverride | null {
  const directOverride = normalizeStoredOverrideModel({
    providerOverride: params.sessionEntry?.providerOverride,
    modelOverride: params.sessionEntry?.modelOverride,
  });
  const direct = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: directOverride.providerOverride,
    overrideModel: directOverride.modelOverride,
  });
  if (direct) {
    return { ...direct, source: "session" };
  }
  const parentKey = resolveParentSessionKeyCandidate({
    sessionKey: params.sessionKey,
    parentSessionKey: params.parentSessionKey,
  });
  if (!parentKey) {
    return null;
  }
  const parentEntry = params.loadSessionEntry?.(parentKey) ?? params.sessionStore?.[parentKey];
  const normalizedParentOverride = normalizeStoredOverrideModel({
    providerOverride: parentEntry?.providerOverride,
    modelOverride: parentEntry?.modelOverride,
  });
  const parentOverride = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: normalizedParentOverride.providerOverride,
    overrideModel: normalizedParentOverride.modelOverride,
  });
  if (!parentOverride) {
    return null;
  }
  return { ...parentOverride, source: "parent" };
}

function resolveModelRefKey(params: {
  defaultProvider: string;
  overrideProvider?: string;
  overrideModel?: string;
}): string | null {
  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: params.overrideProvider,
    modelOverride: params.overrideModel,
  });
  const ref = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: normalizedOverride.providerOverride,
    overrideModel: normalizedOverride.modelOverride,
  });
  if (!ref) {
    return null;
  }
  const normalizedRef = normalizeModelRef(ref.provider, ref.model);
  return modelKey(normalizedRef.provider, normalizedRef.model);
}

/** Detects heartbeat auto-fallback overrides that no longer match the primary model. */
export function isStaleHeartbeatAutoFallbackOverride(params: {
  isHeartbeat?: boolean;
  hasResolvedHeartbeatModelOverride?: boolean;
  sessionEntry?: SessionEntry;
  storedOverride?: StoredModelOverride | null;
  defaultProvider: string;
  defaultModel: string;
  primaryProvider?: string;
  primaryModel?: string;
}): boolean {
  if (params.isHeartbeat !== true || params.hasResolvedHeartbeatModelOverride === true) {
    return false;
  }
  if (params.storedOverride?.source !== "session") {
    return false;
  }
  const entry = params.sessionEntry;
  const recoveredAutoFallbackOverride =
    entry !== undefined &&
    entry.modelOverrideSource === undefined &&
    hasSessionAutoModelFallbackProvenance(entry);
  // Older sessions may lack modelOverrideSource; provenance recovers the auto-fallback state.
  if (entry?.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) {
    return false;
  }
  if (!entry) {
    return false;
  }

  const primaryKey = resolveModelRefKey({
    defaultProvider: params.defaultProvider,
    overrideProvider: params.primaryProvider ?? params.defaultProvider,
    overrideModel: params.primaryModel ?? params.defaultModel,
  });
  if (!primaryKey) {
    return false;
  }

  const originKey = resolveModelRefKey({
    defaultProvider: params.defaultProvider,
    overrideProvider: entry.modelOverrideFallbackOriginProvider,
    overrideModel: entry.modelOverrideFallbackOriginModel,
  });
  if (originKey) {
    return originKey !== primaryKey;
  }

  const noticeSelectedKey = resolveModelRefKey({
    defaultProvider: params.defaultProvider,
    overrideModel: normalizeOptionalString(entry.fallbackNoticeSelectedModel),
  });
  if (noticeSelectedKey) {
    return noticeSelectedKey !== primaryKey;
  }

  const storedOverrideKey = resolveModelRefKey({
    defaultProvider: params.defaultProvider,
    overrideProvider: params.storedOverride.provider,
    overrideModel: params.storedOverride.model,
  });
  return storedOverrideKey !== null && storedOverrideKey !== primaryKey;
}
