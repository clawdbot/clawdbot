/** Process env key that marks child commands as launched by the OpenClaw CLI. */
export const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";

/** Stable marker value used for OpenClaw-launched subprocess detection. */
const OPENCLAW_CLI_ENV_VALUE = "1";
/** Universal advisory marker for tools that adapt behavior under AI agents. */
const AI_AGENT_ENV_VAR = "AI_AGENT";
export const AI_AGENT_ENV_VALUE = "openclaw";

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

/** Returns a cloned env object with OpenClaw-specific and universal execution markers. */
export function markOpenClawExecEnv<T extends Record<string, string | undefined>>(
  /** Source environment to clone before adding the subprocess marker. */
  env: T,
  platform: NodeJS.Platform = process.platform,
): T {
  const marked = {
    ...env,
    [OPENCLAW_CLI_ENV_VAR]: OPENCLAW_CLI_ENV_VALUE,
  };
  normalizeAiAgentEnv(marked, platform);
  return marked;
}

/** Mutates a process env object so current-process children inherit execution markers. */
export function ensureOpenClawExecMarkerOnProcess(
  /** Process env object to mutate; defaults to the current process environment. */
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  env[OPENCLAW_CLI_ENV_VAR] = OPENCLAW_CLI_ENV_VALUE;
  normalizeAiAgentEnv(env, platform);
  return env;
}
