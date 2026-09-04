/**
 * Session runtime compatibility helpers.
 *
 * Resolves persisted runtime overrides without leaking provider-specific CLI runtime bindings across model routes.
 */
import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
import { getCliSessionBinding } from "../config/sessions/cli-session-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionPinnedHarnessId } from "../sessions/agent-harness-session-key.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { isCliRuntimeAliasForProvider } from "./model-runtime-aliases.js";

/** Persisted runtime fields used to recover session runtime compatibility. */
type SessionRuntimeCompatEntry = Pick<
  SessionEntry,
  "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked" | "pluginOwnerId"
>;
type ManualCompactionRuntimeEntry = Pick<
  SessionEntry,
  | "agentHarnessId"
  | "agentRuntimeOverride"
  | "cliSessionBindings"
  | "claudeCliSessionId"
  | "cliSessionIds"
  | "modelSelectionLocked"
  | "pluginOwnerId"
>;

type ManualCompactionCliTarget = {
  agentHarnessId?: string;
  cliSessionBinding?: CliSessionBinding;
  cliSessionId?: string;
};

/** Resolves the persisted runtime id, preserving locked transcript ownership. */
export function resolvePersistedSessionRuntimeId(
  entry?: SessionRuntimeCompatEntry,
): string | undefined {
  const pinnedHarness = resolveSessionPinnedHarnessId(entry);
  if (pinnedHarness && !isDefaultAgentRuntimeId(pinnedHarness)) {
    return pinnedHarness;
  }
  const runtimeOverride = normalizeOptionalAgentRuntimeId(entry?.agentRuntimeOverride);
  if (runtimeOverride && !isDefaultAgentRuntimeId(runtimeOverride)) {
    return runtimeOverride;
  }
  return normalizeOptionalAgentRuntimeId(entry?.agentHarnessId);
}
/** Resolves a runtime id only when it can serve the selected provider. */
export function resolveCompatibleAgentRuntimeForProvider(params: {
  provider?: string | null;
  runtime?: string | null;
  cfg?: OpenClawConfig;
}): string | undefined {
  const runtime = normalizeOptionalAgentRuntimeId(params.runtime);
  if (!runtime || isDefaultAgentRuntimeId(runtime)) {
    return undefined;
  }
  if (runtime === "openclaw") {
    return runtime;
  }
  const provider = params.provider?.trim().toLowerCase() ?? "";
  // The Codex harness owns both OpenClaw's virtual Codex namespace and canonical OpenAI routes.
  if (runtime === "codex" && (provider === "codex" || provider === "openai")) {
    return runtime;
  }
  return isCliRuntimeAliasForProvider({ provider, runtime, cfg: params.cfg }) ? runtime : undefined;
}
/** Resolves a persisted runtime override only when it can serve the selected provider. */
export function resolveSessionRuntimeOverrideForProvider(params: {
  provider?: string | null;
  entry?: SessionRuntimeCompatEntry;
  cfg?: OpenClawConfig;
}): string | undefined {
  const lockedHarness = resolveSessionPinnedHarnessId(params.entry);
  if (lockedHarness && !isDefaultAgentRuntimeId(lockedHarness)) {
    // A locked transcript stays with its creating harness; provider metadata on
    // internal turns must not reinterpret that runtime as a CLI backend.
    return lockedHarness;
  }

  // agentHarnessId records the runtime that produced the existing transcript;
  // it must not override the runtime selected for the next turn.
  return resolveCompatibleAgentRuntimeForProvider({
    provider: params.provider,
    runtime: params.entry?.agentRuntimeOverride,
    cfg: params.cfg,
  });
}

/** Resolves the native CLI transcript that owns manual compaction for a session. */
export function resolveManualCompactionCliTarget(params: {
  provider?: string | null;
  entry?: ManualCompactionRuntimeEntry;
  cfg?: OpenClawConfig;
}): ManualCompactionCliTarget {
  const runtimeOverride = normalizeOptionalAgentRuntimeId(params.entry?.agentRuntimeOverride);
  const runtimeConfig =
    runtimeOverride && getCliSessionBinding(params.entry, runtimeOverride) ? params.cfg : undefined;
  const historicalRuntime = normalizeOptionalAgentRuntimeId(params.entry?.agentHarnessId);
  const historicalRuntimeConfig =
    historicalRuntime && getCliSessionBinding(params.entry, historicalRuntime)
      ? params.cfg
      : undefined;
  const selectedRuntime = resolveSessionRuntimeOverrideForProvider({
    provider: params.provider,
    entry: params.entry,
    // Setup discovery is only relevant when this runtime owns a native transcript.
    // Model-picker overrides without a binding must stay on the generic compaction path.
    cfg: runtimeConfig,
  });
  const persistedRuntime =
    params.entry?.modelSelectionLocked === true
      ? resolvePersistedSessionRuntimeId(params.entry)
      : (selectedRuntime ??
        (params.entry?.agentRuntimeOverride
          ? undefined
          : resolveCompatibleAgentRuntimeForProvider({
              provider: params.provider,
              runtime: historicalRuntime,
              cfg: historicalRuntimeConfig,
            })));
  if (persistedRuntime) {
    const cliSessionBinding = getCliSessionBinding(params.entry, persistedRuntime);
    return {
      agentHarnessId: persistedRuntime,
      cliSessionBinding,
      cliSessionId: cliSessionBinding?.sessionId,
    };
  }

  // Implicit CLI selections have no runtime override. Recover ownership from
  // the native bindings themselves, but only when exactly one runtime can
  // serve the selected provider; ambiguity must not compact the wrong history.
  const boundRuntimeIds = new Set([
    ...Object.keys(params.entry?.cliSessionBindings ?? {}),
    ...Object.keys(params.entry?.cliSessionIds ?? {}),
    ...(params.entry?.claudeCliSessionId ? ["claude-cli"] : []),
  ]);
  const compatibleBindings = [...boundRuntimeIds].flatMap((runtime) => {
    const compatibleRuntime = resolveCompatibleAgentRuntimeForProvider({
      provider: params.provider,
      runtime,
      cfg: params.cfg,
    });
    const binding = compatibleRuntime
      ? getCliSessionBinding(params.entry, compatibleRuntime)
      : undefined;
    return compatibleRuntime && binding ? [{ runtime: compatibleRuntime, binding }] : [];
  });
  const compatibleBinding = compatibleBindings.length === 1 ? compatibleBindings[0] : undefined;
  if (!compatibleBinding) {
    return {};
  }
  return {
    agentHarnessId: compatibleBinding.runtime,
    cliSessionBinding: compatibleBinding.binding,
    cliSessionId: compatibleBinding.binding.sessionId,
  };
}
