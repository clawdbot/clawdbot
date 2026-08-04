/** Process env key that marks child commands as launched by the OpenClaw CLI. */
export const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";

/** Stable marker value used for OpenClaw-launched subprocess detection. */
const OPENCLAW_CLI_ENV_VALUE = "1";
/** Universal advisory marker for tools that adapt behavior under AI agents. */
const AI_AGENT_ENV_VAR = "AI_AGENT";
const AI_AGENT_ENV_VALUE = "openclaw";

/** Returns a cloned env object with OpenClaw-specific and universal execution markers. */
export function markOpenClawExecEnv<T extends Record<string, string | undefined>>(
  /** Source environment to clone before adding the subprocess marker. */
  env: T,
): T {
  const explicitAgent = env[AI_AGENT_ENV_VAR];
  return {
    ...env,
    [OPENCLAW_CLI_ENV_VAR]: OPENCLAW_CLI_ENV_VALUE,
    [AI_AGENT_ENV_VAR]: explicitAgent?.trim() ? explicitAgent : AI_AGENT_ENV_VALUE,
  };
}

/** Mutates a process env object so current-process children inherit execution markers. */
export function ensureOpenClawExecMarkerOnProcess(
  /** Process env object to mutate; defaults to the current process environment. */
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[OPENCLAW_CLI_ENV_VAR] = OPENCLAW_CLI_ENV_VALUE;
  if (!env[AI_AGENT_ENV_VAR]?.trim()) {
    env[AI_AGENT_ENV_VAR] = AI_AGENT_ENV_VALUE;
  }
  return env;
}
