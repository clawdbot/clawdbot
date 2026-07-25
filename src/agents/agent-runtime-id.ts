/** Agent runtime id normalization and retired runtime-selection compatibility helpers. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

export type EmbeddedAgentRuntime = "openclaw" | "auto" | (string & {});

export const OPENCLAW_AGENT_RUNTIME_ID = "openclaw";
export const AUTO_AGENT_RUNTIME_ID = "auto";

/** Normalizes configured runtime aliases to the current embedded-agent runtime id vocabulary. */
export function normalizeEmbeddedAgentRuntime(raw: string | undefined): EmbeddedAgentRuntime {
  const value = raw?.trim();
  if (!value) {
    return OPENCLAW_AGENT_RUNTIME_ID;
  }
  if (value === "openclaw" || value === "pi") {
    return OPENCLAW_AGENT_RUNTIME_ID;
  }
  if (value === "auto") {
    return AUTO_AGENT_RUNTIME_ID;
  }
  if (value === "codex-app-server") {
    return "codex";
  }
  return value;
}

/** Normalizes an optional unknown runtime id value, returning undefined when absent/invalid. */
export function normalizeOptionalAgentRuntimeId(raw: unknown): EmbeddedAgentRuntime | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  return value ? normalizeEmbeddedAgentRuntime(value) : undefined;
}

/** Resolves the deprecated explicit whole-agent runtime override, when present. */
export function resolveAgentScopedRuntimeOverride(params: {
  config?: OpenClawConfig;
  agentId?: string;
}): EmbeddedAgentRuntime | undefined {
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const agentRuntime = agentId
    ? params.config?.agents?.list?.find((entry) => normalizeAgentId(entry.id) === agentId)
        ?.agentRuntime?.id
    : undefined;
  return normalizeOptionalAgentRuntimeId(
    agentRuntime ?? params.config?.agents?.defaults?.agentRuntime?.id,
  );
}

/** Returns whether a runtime id should be treated as the default runtime selection. */
export function isDefaultAgentRuntimeId(runtime: string | undefined): boolean {
  return runtime === undefined || runtime === AUTO_AGENT_RUNTIME_ID || runtime === "default";
}
