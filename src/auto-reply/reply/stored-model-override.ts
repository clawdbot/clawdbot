import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
// Normalizes stored reply models and detects stale heartbeat fallback pins.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasSessionAutoModelFallbackProvenance } from "../../agents/agent-scope.js";
import { resolveCliRuntimeCanonicalProvider } from "../../agents/cli-backends.js";
import { resolvePersistedOverrideModelRef } from "../../agents/model-selection-persisted.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { StoredModelOverride } from "../../sessions/stored-model-overrides.js";
import {
  resolvePreparedReplyModelRef,
  type PreparedReplyModelRef,
  type RuntimeModelNormalization,
} from "./model-runtime-normalization.js";

/** Applies CLI provider routing to an already parsed stored model ref. */
export function resolveStoredRuntimeModelRef(
  provider: string,
  model: string,
  cfg?: OpenClawConfig,
  sessionEntry?: SessionEntry,
) {
  const hasCliSessionBinding = sessionEntry?.cliSessionBindings?.[provider] !== undefined;
  const canonicalProvider =
    cfg && hasCliSessionBinding
      ? resolveCliRuntimeCanonicalProvider({
          runtime: provider,
          config: cfg,
          includeSetupRegistry: true,
        })
      : undefined;
  return { provider: canonicalProvider || provider, model };
}

function resolveModelRefKey(
  params: {
    defaultProvider: string;
    overrideProvider?: string;
    overrideModel?: string;
  } & RuntimeModelNormalization,
): string | null {
  const ref = resolvePersistedOverrideModelRef(params);
  return ref ? buildModelCatalogRef(ref.provider, ref.model) : null;
}

/** Detects heartbeat auto-fallback overrides that no longer match the primary model. */
export function isStaleHeartbeatAutoFallbackOverride(params: {
  isHeartbeat?: boolean;
  hasResolvedHeartbeatModelOverride?: boolean;
  sessionEntry?: SessionEntry;
  storedOverride?: StoredModelOverride | null;
  defaultProvider: string;
  preparedPrimaryModel: PreparedReplyModelRef;
  normalization: RuntimeModelNormalization | undefined;
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

  const normalization = {
    ...params.normalization,
    ...params.normalization?.manifestPluginContext?.getContext(),
  };
  const primary = resolvePreparedReplyModelRef(params.preparedPrimaryModel);
  const primaryKey = buildModelCatalogRef(primary.provider, primary.model);

  const originKey = resolveModelRefKey({
    ...normalization,
    defaultProvider: params.defaultProvider,
    overrideProvider: entry.modelOverrideFallbackOriginProvider,
    overrideModel: entry.modelOverrideFallbackOriginModel,
  });
  if (originKey) {
    return originKey !== primaryKey;
  }

  const noticeSelectedKey = resolveModelRefKey({
    ...normalization,
    defaultProvider: params.defaultProvider,
    overrideModel: normalizeOptionalString(entry.fallbackNotice?.selectedModel),
  });
  if (noticeSelectedKey) {
    return noticeSelectedKey !== primaryKey;
  }

  // The stored-model owner already normalized this selection.
  const storedOverrideKey = buildModelCatalogRef(
    params.storedOverride.provider ?? params.defaultProvider,
    params.storedOverride.model,
  );
  return storedOverrideKey !== primaryKey;
}
