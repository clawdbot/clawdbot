import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  normalizeStoredOverrideModel,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "./model-selection.js";
import {
  abortEmbeddedPiRun,
  consumeEmbeddedRunModelSwitch,
  requestEmbeddedRunModelSwitch,
  type EmbeddedRunModelSwitchRequest,
} from "./pi-embedded-runner/runs.js";
export { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
export type LiveSessionModelSelection = EmbeddedRunModelSwitchRequest;
import { normalizeOptionalString } from "../shared/string-coerce.js";
export function resolveLiveSessionModelSelection(params: {
  cfg?: { session?: { store?: string } } | undefined;
  sessionKey?: string;
  agentId?: string;
  defaultProvider: string;
  defaultModel: string;
}): LiveSessionModelSelection | null {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const cfg = params.cfg;
  if (!cfg || !sessionKey) {
    return null;
  }
  const agentId = normalizeOptionalString(params.agentId);
  const defaultModelRef = agentId
    ? resolveDefaultModelForAgent({
        cfg,
        agentId,
      })
    : { provider: params.defaultProvider, model: params.defaultModel };
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId,
  });
  const entry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
  const normalizedSelection = normalizeStoredOverrideModel({
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
  });
  const persisted = resolvePersistedSelectedModelRef({
    defaultProvider: defaultModelRef.provider,
    runtimeProvider: entry?.modelProvider,
    runtimeModel: entry?.model,
    overrideProvider: normalizedSelection.providerOverride,
    overrideModel: normalizedSelection.modelOverride,
  });
  const provider =
    persisted?.provider ??
    normalizedSelection.providerOverride ??
    entry?.providerOverride?.trim() ??
    defaultModelRef.provider;
  const model = persisted?.model ?? defaultModelRef.model;
  const authProfileId = normalizeOptionalString(entry?.authProfileOverride);
  return {
    provider,
    model,
    authProfileId,
    authProfileIdSource: authProfileId ? entry?.authProfileOverrideSource : undefined,
  };
}

export function requestLiveSessionModelSwitch(params: {
  sessionEntry?: Pick<SessionEntry, "sessionId">;
  selection: LiveSessionModelSelection;
}): boolean {
  const sessionId = normalizeOptionalString(params.sessionEntry?.sessionId);
  if (!sessionId) {
    return false;
  }
  const aborted = abortEmbeddedPiRun(sessionId);
  if (!aborted) {
    return false;
  }
  requestEmbeddedRunModelSwitch(sessionId, params.selection);
  return true;
}

export function consumeLiveSessionModelSwitch(
  sessionId: string,
): LiveSessionModelSelection | undefined {
  return consumeEmbeddedRunModelSwitch(sessionId);
}

export function hasDifferentLiveSessionModelSelection(
  current: {
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: string;
  },
  next: LiveSessionModelSelection | null | undefined,
): next is LiveSessionModelSelection {
  if (!next) {
    return false;
  }
  return (
    current.provider !== next.provider ||
    current.model !== next.model ||
    normalizeOptionalString(current.authProfileId) !== next.authProfileId ||
    (normalizeOptionalString(current.authProfileId) ? current.authProfileIdSource : undefined) !==
      next.authProfileIdSource
  );
}

export function shouldTrackPersistedLiveSessionModelSelection(
  current: {
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: string;
  },
  persisted: LiveSessionModelSelection | null | undefined,
): boolean {
  return !hasDifferentLiveSessionModelSelection(current, persisted);
}

/**
 * Check whether a user-initiated live model switch is pending for the given
 * session.  Returns the persisted model selection when the session's
 * `liveModelSwitchPending` flag is `true` AND the persisted selection differs
 * from the currently running model; otherwise returns `undefined`.
 *
 * When the flag is set but the current model already matches the persisted
 * selection (e.g. the switch was applied as an override and the current
 * attempt is already using the new model), the flag is consumed (cleared)
 * eagerly to prevent it from persisting as stale state.
 *
 * **Deferral semantics:** The caller in `run.ts` only acts on the returned
 * selection when `canRestartForLiveSwitch` is `true`.  If the run cannot
 * restart (e.g. a tool call is in progress), the flag intentionally remains
 * set so the switch fires on the next clean retry opportunity — even if that
 * falls into a subsequent user turn.
 *
 * This replaces the previous approach that used an in-memory map
 * (`consumeEmbeddedRunModelSwitch`) which could not distinguish between
 * user-initiated `/model` switches and system-initiated fallback rotations.
 */
export function shouldSwitchToLiveModel(params: {
  cfg?: { session?: { store?: string } } | undefined;
  sessionKey?: string;
  agentId?: string;
  defaultProvider: string;
  defaultModel: string;
  currentProvider: string;
  currentModel: string;
  currentAuthProfileId?: string;
  currentAuthProfileIdSource?: string;
}): LiveSessionModelSelection | undefined {
  const sessionKey = params.sessionKey?.trim();
  const cfg = params.cfg;
  if (!cfg || !sessionKey) {
    return undefined;
  }
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: params.agentId?.trim(),
  });
  const entry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
  if (!entry?.liveModelSwitchPending) {
    return undefined;
  }
  const persisted = resolveLiveSessionModelSelection({
    cfg,
    sessionKey,
    agentId: params.agentId,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  if (
    !hasDifferentLiveSessionModelSelection(
      {
        provider: params.currentProvider,
        model: params.currentModel,
        authProfileId: params.currentAuthProfileId,
        authProfileIdSource: params.currentAuthProfileIdSource,
      },
      persisted,
    )
  ) {
    // Current model already matches the persisted selection — the switch has
    // effectively been applied.  Clear the stale flag so subsequent fallback
    // iterations don't re-evaluate it.
    clearLiveModelSwitchPending({
      cfg,
      sessionKey,
      agentId: params.agentId,
    }).catch(() => {
      /* best-effort — fs/lock errors are non-fatal here */
    });
    return undefined;
  }
  return persisted ?? undefined;
}

/**
 * Clear the `liveModelSwitchPending` flag from the session entry on disk so
 * subsequent retry iterations do not re-trigger the switch.
 */
export async function clearLiveModelSwitchPending(params: {
  cfg?: { session?: { store?: string } } | undefined;
  sessionKey?: string;
  agentId?: string;
}): Promise<void> {
  const sessionKey = params.sessionKey?.trim();
  const cfg = params.cfg;
  if (!cfg || !sessionKey) {
    return;
  }
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: params.agentId?.trim(),
  });
  if (!storePath) {
    return;
  }
  await updateSessionStore(storePath, (store) => {
    const entry = store[sessionKey];
    if (entry) {
      delete entry.liveModelSwitchPending;
    }
  });
}
