/** Process env key that marks child commands as launched by the OpenClaw CLI. */
export const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";

/** Stable marker value used for OpenClaw-launched subprocess detection. */
const OPENCLAW_CLI_ENV_VALUE = "1";
/** Universal advisory marker for tools that adapt behavior under AI agents. */
const AI_AGENT_ENV_VAR = "AI_AGENT";
const AI_AGENT_ENV_VALUE = "openclaw";

export type AiAgentEnvPlan = {
  baseEnv: Record<string, string>;
  configuredEnv: Record<string, string>;
  overrideEnv: Record<string, string>;
  clearEnv: string[];
  preserveEnv: string[];
  forceClearBeforeOverrides: boolean;
};

function normalizeAiAgentEnvValue(value: string | undefined): string {
  return value?.trim() ? value : AI_AGENT_ENV_VALUE;
}

function listAiAgentEnvKeys(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string[] {
  return platform === "win32"
    ? Object.keys(env).filter((key) => key.toUpperCase() === AI_AGENT_ENV_VAR)
    : [AI_AGENT_ENV_VAR];
}

/** Retains only AI_AGENT aliases for later target-platform resolution. */
export function pickAiAgentEnvAliases(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[0].toUpperCase() === AI_AGENT_ENV_VAR && entry[1] !== undefined,
    ),
  );
}

function normalizeAiAgentEnv(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  defaultWhenMissing = true,
): void {
  const agentKeys = listAiAgentEnvKeys(env, platform);
  if (!defaultWhenMissing && !agentKeys.some((key) => Object.hasOwn(env, key))) {
    return;
  }
  const explicitAgent = env[agentKeys.at(-1) ?? AI_AGENT_ENV_VAR];
  for (const key of platform === "win32" ? agentKeys : []) {
    delete env[key];
  }
  env[AI_AGENT_ENV_VAR] = normalizeAiAgentEnvValue(explicitAgent);
}

/** Returns cloned overrides with present agent markers normalized without adding a missing marker. */
export function canonicalizeAiAgentEnvOverrides<T extends Record<string, string | undefined>>(
  env: T,
  platform: NodeJS.Platform = process.platform,
): T {
  const canonical = { ...env };
  normalizeAiAgentEnv(canonical, platform, false);
  return canonical;
}

function hasAiAgentEnvKey(keys: readonly string[], platform: NodeJS.Platform): boolean {
  return keys.some((key) =>
    platform === "win32" ? key.toUpperCase() === AI_AGENT_ENV_VAR : key === AI_AGENT_ENV_VAR,
  );
}

function resolveAiAgentEnvValue(
  env: Record<string, string>,
  platform: NodeJS.Platform,
): string | undefined {
  return canonicalizeAiAgentEnvOverrides(env, platform)[AI_AGENT_ENV_VAR];
}

/** Resolves layered marker inputs using the target process platform's env-key semantics. */
export function resolveAiAgentEnvPlan(
  input: AiAgentEnvPlan,
  platform: NodeJS.Platform,
): { value?: string; clear: boolean } {
  const clearRequested = hasAiAgentEnvKey(input.clearEnv, platform);
  const clearPreserved = hasAiAgentEnvKey(input.preserveEnv, platform);
  const clear = clearRequested && (!clearPreserved || input.forceClearBeforeOverrides);
  const configured =
    clearRequested && input.forceClearBeforeOverrides
      ? undefined
      : resolveAiAgentEnvValue(input.configuredEnv, platform);
  const override = resolveAiAgentEnvValue(input.overrideEnv, platform) ?? configured;
  const value = override ?? (clear ? undefined : resolveAiAgentEnvValue(input.baseEnv, platform));
  return {
    ...(value !== undefined && (value !== AI_AGENT_ENV_VALUE || override !== undefined)
      ? { value }
      : {}),
    clear,
  };
}

/** Reasserts the canonical OpenClaw CLI marker without changing AI_AGENT. */
export function ensureOpenClawCliExecMarker(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === OPENCLAW_CLI_ENV_VAR) {
        delete env[key];
      }
    }
  }
  env[OPENCLAW_CLI_ENV_VAR] = OPENCLAW_CLI_ENV_VALUE;
}

/** Returns a cloned env object with OpenClaw-specific and universal execution markers. */
export function markOpenClawExecEnv<T extends Record<string, string | undefined>>(
  /** Source environment to clone before adding the subprocess marker. */
  env: T,
  platform: NodeJS.Platform = process.platform,
): T {
  const marked = { ...env };
  ensureOpenClawCliExecMarker(marked, platform);
  normalizeAiAgentEnv(marked, platform);
  return marked;
}

/** Mutates a process env object so current-process children inherit execution markers. */
export function ensureOpenClawExecMarkerOnProcess(
  /** Process env object to mutate; defaults to the current process environment. */
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  ensureOpenClawCliExecMarker(env, platform);
  normalizeAiAgentEnv(env, platform);
  return env;
}
