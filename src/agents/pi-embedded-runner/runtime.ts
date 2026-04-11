export type EmbeddedAgentRuntime = "pi" | "auto" | (string & {});
export type EmbeddedAgentHarnessFallback = "pi" | "none";

export function normalizeEmbeddedAgentRuntime(raw: string | undefined): EmbeddedAgentRuntime {
  const value = raw?.trim();
  if (!value) {
    return "auto";
  }
  if (value === "pi") {
    return "pi";
  }
  if (value === "auto") {
    return "auto";
  }
  return value;
}

export function resolveEmbeddedAgentRuntime(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddedAgentRuntime {
  return normalizeEmbeddedAgentRuntime(env.OPENCLAW_AGENT_RUNTIME?.trim());
}

export function resolveEmbeddedAgentHarnessFallback(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddedAgentHarnessFallback | undefined {
  const raw = env.OPENCLAW_AGENT_HARNESS_FALLBACK?.trim().toLowerCase();
  if (raw === "pi" || raw === "none") {
    return raw;
  }
  return undefined;
}
