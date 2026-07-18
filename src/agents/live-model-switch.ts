/**
 * Resolves and persists live-session model switch requests.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionEntry, patchSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  normalizeStoredOverrideModel,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "./model-selection.js";
import { resolveSessionRuntimeOverrideForProvider } from "./session-runtime-compat.js";
export { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
export type LiveSessionModelSelection = {
  provider: string;
  model: string;
  agentRuntimeOverride?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_PROVIDER_ID = "openai";

function resolveLiveSessionModelSelection(params: {
  cfg?: OpenClawConfig | undefined;
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
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId,
  });
  const entry = loadSessionEntry({
    storePath,
    sessionKey,
    hydrateSkillPromptRefs: false,
    readConsistency: "latest",
  });
  return resolveSelectionFromSessionEntry({
    cfg,
    entry,
    agentId,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
}

/**
 * Entry-snapshot variant of the selection resolver, so atomic patch callbacks
 * can evaluate the persisted selection against the exact row they may rewrite.
 */
function resolveSelectionFromSessionEntry(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry | undefined;
  agentId?: string;
  defaultProvider: string;
  defaultModel: string;
}): LiveSessionModelSelection {
  const { cfg, entry } = params;
  const agentId = normalizeOptionalString(params.agentId);
  const defaultModelRef = agentId
    ? resolveDefaultModelForAgent({
        cfg,
        agentId,
      })
    : { provider: params.defaultProvider, model: params.defaultModel };
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
  const agentRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
    provider,
    entry,
    cfg,
  });
  const authProfileId = normalizeOptionalString(entry?.authProfileOverride);
  return {
    provider,
    model,
    ...(agentRuntimeOverride ? { agentRuntimeOverride } : {}),
    authProfileId,
    authProfileIdSource: authProfileId ? entry?.authProfileOverrideSource : undefined,
  };
}

function isAlreadyAppliedOpenAICodexRuntimePromotion(
  current: { provider: string; model: string },
  next: LiveSessionModelSelection,
): boolean {
  // The embedded Codex runtime reports openai after applying a canonical
  // openai selection. Other runtime aliases remain real live-switch targets.
  return (
    normalizeProviderId(current.provider) === OPENAI_CODEX_PROVIDER_ID &&
    normalizeProviderId(next.provider) === OPENAI_PROVIDER_ID &&
    current.model === next.model
  );
}

function hasDifferentLiveSessionModelSelection(
  current: {
    provider: string;
    model: string;
    agentRuntimeOverride?: string;
    authProfileId?: string;
    authProfileIdSource?: string;
  },
  next: LiveSessionModelSelection | null | undefined,
): next is LiveSessionModelSelection {
  if (!next) {
    return false;
  }
  const modelSelectionDiffers =
    (current.provider !== next.provider || current.model !== next.model) &&
    !isAlreadyAppliedOpenAICodexRuntimePromotion(current, next);
  return (
    modelSelectionDiffers ||
    normalizeOptionalString(current.agentRuntimeOverride) !== next.agentRuntimeOverride ||
    normalizeOptionalString(current.authProfileId) !== next.authProfileId ||
    (normalizeOptionalString(current.authProfileId) ? current.authProfileIdSource : undefined) !==
      next.authProfileIdSource
  );
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
 * This replaces the previous approach that used an in-memory run-state map,
 * which could not distinguish between
 * user-initiated `/model` switches and system-initiated fallback rotations.
 */
export function shouldSwitchToLiveModel(params: {
  cfg?: OpenClawConfig | undefined;
  sessionKey?: string;
  agentId?: string;
  defaultProvider: string;
  defaultModel: string;
  currentProvider: string;
  currentModel: string;
  currentAgentRuntimeOverride?: string;
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
  const entry = loadSessionEntry({
    storePath,
    sessionKey,
    hydrateSkillPromptRefs: false,
    clone: false,
    readConsistency: "latest",
  });
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
        agentRuntimeOverride: params.currentAgentRuntimeOverride,
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
 * Post-run consolidation: once a completed run has actually executed the
 * persisted selection, the pending live-switch flag is spent. CLI harness runs
 * never pass through the embedded attempt-recovery clear, so without this the
 * flag survives forever and `/status` keeps reporting a switch that already
 * happened. Unlike `shouldSwitchToLiveModel`, runtime/auth-profile drift is
 * ignored here: the selected model demonstrably ran, so keeping the flag would
 * only re-arm mid-run restarts that have nothing left to apply. Compare and
 * clear happen inside one atomic patch so a concurrent `/model` that persists
 * a newer selection is never consumed by this run's result.
 */
export async function consolidateLiveModelSwitchAfterRun(params: {
  cfg?: OpenClawConfig | undefined;
  sessionKey?: string;
  agentId?: string;
  providerUsed?: string;
  modelUsed?: string;
}): Promise<void> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const cfg = params.cfg;
  const providerUsed = normalizeOptionalString(params.providerUsed);
  const modelUsed = normalizeOptionalString(params.modelUsed);
  if (!cfg || !sessionKey || !providerUsed || !modelUsed) {
    return;
  }
  // Store selection and default-model resolution both need the owning agent;
  // derive it from the session key when the caller has none, so agent-scoped
  // stores are targeted correctly and a completed /model default still
  // consolidates when config overrides the library-wide defaults.
  const agentId = resolveSessionAgentId({
    sessionKey,
    config: cfg,
    agentId: params.agentId,
  });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  if (!storePath) {
    return;
  }
  await patchSessionEntry(
    { storePath, sessionKey },
    (entry) => {
      if (!entry.liveModelSwitchPending) {
        return null;
      }
      const persisted = resolveSelectionFromSessionEntry({
        cfg,
        entry,
        agentId,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const selectionApplied =
        (providerUsed === persisted.provider && modelUsed === persisted.model) ||
        isAlreadyAppliedOpenAICodexRuntimePromotion(
          { provider: providerUsed, model: modelUsed },
          persisted,
        );
      if (!selectionApplied) {
        return null;
      }
      const next = { ...entry };
      delete next.liveModelSwitchPending;
      return next;
    },
    { replaceEntry: true },
  );
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
  await patchSessionEntry(
    { storePath, sessionKey },
    (entry) => {
      const next = { ...entry };
      delete next.liveModelSwitchPending;
      return next;
    },
    { replaceEntry: true },
  );
}
