/** Process env key that marks child commands as launched by the OpenClaw CLI. */
export const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";

/** Stable marker value used for OpenClaw-launched subprocess detection. */
const OPENCLAW_CLI_ENV_VALUE = "1";
/** Universal advisory marker for tools that adapt behavior under AI agents. */
const AI_AGENT_ENV_VAR = "AI_AGENT";
const AI_AGENT_ENV_VALUE = "openclaw";

function normalizeAiAgentEnv(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): void {
  const agentKeys =
    platform === "win32"
      ? Object.keys(env)
          .filter((key) => key.toUpperCase() === AI_AGENT_ENV_VAR)
          .toSorted()
      : [AI_AGENT_ENV_VAR];
  const explicitAgent = env[agentKeys[0] ?? AI_AGENT_ENV_VAR];
  for (const key of platform === "win32" ? agentKeys : []) {
    delete env[key];
  }
  env[AI_AGENT_ENV_VAR] = explicitAgent?.trim() ? explicitAgent : AI_AGENT_ENV_VALUE;
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
