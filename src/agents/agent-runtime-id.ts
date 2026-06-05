/** Agent runtime id normalization and retired runtime-selection compatibility helpers. */
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

/**
 * @deprecated Whole-agent runtime environment selection is retired. Use
 * provider/model runtime policy or a registered agent harness instead.
 */
export function resolveEmbeddedAgentRuntime(
  _env: NodeJS.ProcessEnv = process.env,
): EmbeddedAgentRuntime {
  return OPENCLAW_AGENT_RUNTIME_ID;
}

/** Returns whether a runtime id should be treated as the default runtime selection. */
export function isDefaultAgentRuntimeId(runtime: string | undefined): boolean {
  return runtime === undefined || runtime === AUTO_AGENT_RUNTIME_ID || runtime === "default";
}
