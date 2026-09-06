// Normalizes stored reply models and detects stale heartbeat fallback pins.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasSessionAutoModelFallbackProvenance } from "../../agents/agent-scope.js";
import { resolveCliRuntimeCanonicalProvider } from "../../agents/cli-backends.js";
import {
  normalizeStoredOverrideModel,
  resolvePersistedOverrideModelRef,
} from "../../agents/model-selection-persisted.js";
import { modelKey, normalizeModelRef } from "../../agents/model-selection.js";
import { RUNTIME_MODEL_VISIBILITY_NORMALIZATION } from "../../agents/model-visibility-policy.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { StoredModelOverride } from "../../sessions/stored-model-overrides.js";
import type { RuntimeModelNormalization } from "./model-runtime-normalization.js";

/** Normalizes a stored model ref, resolving runtime aliases only for CLI-bound sessions. */
export function normalizeStoredRuntimeModelRef(
  provider: string,
  model: string,
  cfg?: OpenClawConfig,
  sessionEntry?: SessionEntry,
  normalization: RuntimeModelNormalization = RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
) {
  const normalized = normalizeModelRef(provider, model, normalization);
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
    overrideModel: normalizeOptionalString(entry.fallbackNotice?.selectedModel),
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
