/**
 * Session runtime compatibility helpers.
 *
 * Resolves persisted runtime overrides without leaking provider-specific CLI runtime bindings across model routes.
 */
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { isCliRuntimeAliasForProvider } from "./model-runtime-aliases.js";

/** Persisted runtime fields used to recover session runtime compatibility. */
type SessionRuntimeCompatEntry = Pick<
  SessionEntry,
  "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked"
>;
type SessionRuntimeOverrideEntry = Pick<
  SessionEntry,
  "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked"
>;

/** Resolves the persisted runtime id, preserving locked transcript ownership. */
export function resolvePersistedSessionRuntimeId(
  entry?: SessionRuntimeCompatEntry,
): string | undefined {
  const harnessRuntime = normalizeOptionalAgentRuntimeId(entry?.agentHarnessId);
  if (
    entry?.modelSelectionLocked === true &&
    harnessRuntime &&
    !isDefaultAgentRuntimeId(harnessRuntime)
  ) {
    return harnessRuntime;
  }
  const runtimeOverride = normalizeOptionalAgentRuntimeId(entry?.agentRuntimeOverride);
  if (runtimeOverride && !isDefaultAgentRuntimeId(runtimeOverride)) {
    return runtimeOverride;
  }
  return harnessRuntime;
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
  entry?: SessionRuntimeOverrideEntry;
  cfg?: OpenClawConfig;
}): string | undefined {
  const lockedHarness = normalizeOptionalAgentRuntimeId(params.entry?.agentHarnessId);
  if (
    params.entry?.modelSelectionLocked === true &&
    lockedHarness &&
    !isDefaultAgentRuntimeId(lockedHarness)
  ) {
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
