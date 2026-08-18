// Resolves persisted per-session model choices across child and parent sessions.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelFallbackRouteResolution } from "../agents/model-fallback.types.js";
import {
  normalizeStoredOverrideModel,
  resolvePersistedOverrideModelRef,
} from "../agents/model-selection-persisted.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import { resolveSessionModelOverrideRouteResolution } from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";

/** Model override loaded from the current session or its parent session. */
export type StoredModelOverride = {
  provider?: string;
  model: string;
  source: "session" | "parent";
  routeResolution: ModelFallbackRouteResolution;
};

function resolveStoredOverrideFromEntry(params: {
  entry?: SessionEntry;
  defaultProvider: string;
  source: StoredModelOverride["source"];
}): StoredModelOverride | null {
  const normalized = normalizeStoredOverrideModel({
    providerOverride: params.entry?.providerOverride,
    modelOverride: params.entry?.modelOverride,
  });
  const ref = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: normalized.providerOverride,
    overrideModel: normalized.modelOverride,
  });
  return ref
    ? {
        ...ref,
        source: params.source,
        routeResolution: resolveSessionModelOverrideRouteResolution(params.entry),
      }
    : null;
}

/** Resolves only the current session's persisted model override. */
export function resolveDirectStoredModelOverride(params: {
  sessionEntry?: SessionEntry;
  defaultProvider: string;
}): StoredModelOverride | null {
  return resolveStoredOverrideFromEntry({
    entry: params.sessionEntry,
    defaultProvider: params.defaultProvider,
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
export function resolveStoredModelOverride(params: {
  loadSessionEntry?: (sessionKey: string) => SessionEntry | undefined;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  defaultProvider: string;
}): StoredModelOverride | null {
  const direct = resolveDirectStoredModelOverride({
    sessionEntry: params.sessionEntry,
    defaultProvider: params.defaultProvider,
  });
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
  return resolveStoredOverrideFromEntry({
    entry: params.loadSessionEntry?.(parentKey) ?? params.sessionStore?.[parentKey],
    defaultProvider: params.defaultProvider,
    source: "parent",
  });
}
