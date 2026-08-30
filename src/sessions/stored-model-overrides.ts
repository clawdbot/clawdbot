// Resolves persisted per-session model choices across child and parent sessions.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelFallbackRouteResolution } from "../agents/model-fallback.types.js";
import { resolveDefaultModelProviderForAgent } from "../agents/model-selection-config.js";
import { resolvePersistedOverrideModelRef } from "../agents/model-selection-persisted.js";
import {
  createModelManifestPluginContext,
  type ModelSelectionNormalizationContext,
} from "../agents/model-selection-shared.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import {
  hasSessionActiveAutoModelFallback,
  resolveSessionModelOverrideRouteResolution,
} from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Model override loaded from the current session or its parent session. */
export type StoredModelOverride = {
  provider?: string;
  model: string;
  source: "session" | "parent";
  routeResolution: ModelFallbackRouteResolution;
};

type StoredModelOverrideContext = ModelSelectionNormalizationContext & {
  agentId?: string;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
} & ({ defaultProvider: string } | { config: OpenClawConfig; defaultProvider?: undefined });

function resolveStoredOverrideFromEntry(
  params: {
    entry?: SessionEntry;
    source: StoredModelOverride["source"];
  } & StoredModelOverrideContext,
): StoredModelOverride | null {
  const overrideModel = normalizeOptionalString(params.entry?.modelOverride);
  if (!overrideModel) {
    return null;
  }
  // Only a selected stored model needs defaults or metadata. Prepared callers keep
  // their exact owner; explicit SDK defaults retain precedence.
  const manifestPluginContext =
    params.manifestPluginContext ??
    (params.config
      ? createModelManifestPluginContext({ ...params, cfg: params.config })
      : undefined);
  const defaultProvider =
    params.defaultProvider !== undefined
      ? params.defaultProvider
      : resolveDefaultModelProviderForAgent({
          ...params,
          cfg: params.config,
          manifestPluginContext,
        });
  const routeResolution = resolveSessionModelOverrideRouteResolution(params.entry);
  const ref = resolvePersistedOverrideModelRef({
    ...params,
    ...manifestPluginContext?.getContext(),
    defaultProvider,
    overrideProvider: params.entry?.providerOverride,
    overrideModel,
    overrideRouteResolution: routeResolution,
  });
  return ref
    ? {
        ...ref,
        source: params.source,
        routeResolution,
      }
    : null;
}

/** Resolves only the current session's persisted model override. */
export function resolveDirectStoredModelOverride(
  params: {
    sessionEntry?: SessionEntry;
  } & StoredModelOverrideContext,
): StoredModelOverride | null {
  return resolveStoredOverrideFromEntry({
    ...params,
    entry: params.sessionEntry,
    source: "session",
  });
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
export function resolveStoredModelOverride(
  params: {
    loadSessionEntry?: (sessionKey: string) => SessionEntry | undefined;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    parentSessionKey?: string;
  } & StoredModelOverrideContext,
): StoredModelOverride | null {
  const direct = resolveDirectStoredModelOverride(params);
  if (direct) {
    return direct;
  }
  const parentKey = resolveParentSessionKeyCandidate({
    sessionKey: params.sessionKey,
    parentSessionKey: params.parentSessionKey,
  });
  if (!parentKey) {
    return null;
  }
  const parentEntry = params.loadSessionEntry?.(parentKey) ?? params.sessionStore?.[parentKey];
  if (hasSessionActiveAutoModelFallback(parentEntry)) {
    return null;
  }
  return resolveStoredOverrideFromEntry({
    ...params,
    entry: parentEntry,
    source: "parent",
  });
}
