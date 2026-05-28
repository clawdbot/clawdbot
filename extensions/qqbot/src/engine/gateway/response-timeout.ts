/**
 * QQBot outbound response watchdog timeout resolver.
 *
 * Background — issue #85267:
 *   The reporter ran openclaw + ollama + `qwen3.5:27b` (a slow local model)
 *   with `models.providers.ollama.timeoutSeconds: 1800` and saw the
 *   QQBot reply path abort at ~5 minutes with "LLM request timed out",
 *   despite the direct ollama call to the same model working. The
 *   embedded-runner / idle-timeout layer already honors longer
 *   provider timeouts (see `src/agents/embedded-agent-runner/run/llm-idle-timeout.ts`),
 *   but the QQBot outbound dispatcher held an independent hardcoded
 *   `RESPONSE_TIMEOUT = 300_000` watchdog that quietly undercut the
 *   configured ceiling.
 *
 * Fix shape (clawsweeper `clawsweeper:fix-shape-clear`):
 *   Don't add a new QQBot-only knob. Instead derive the QQBot wait
 *   budget from the existing agent/provider timeout settings the user
 *   already configured:
 *     - `agents.defaults.timeoutSeconds`
 *     - `models.providers.<id>.timeoutSeconds` (max across configured providers)
 *   Take the maximum and clamp to `[DEFAULT_RESPONSE_TIMEOUT_MS, MAX_SAFE_TIMEOUT_MS]`.
 *   The default floor preserves the existing 5-minute guard for users
 *   that have not configured any longer ceiling — i.e. a no-op for
 *   typical cloud-model deployments.
 */

/**
 * Default QQBot outbound response watchdog when no config override is
 * present. Preserves the historical 5-minute guard for unconfigured
 * deployments.
 */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 300_000;

/**
 * Upper bound to keep the watchdog inside the safe `setTimeout` range
 * (approximately 24.8 days). Mirrors `MAX_SAFE_TIMEOUT_MS` in
 * `src/agents/embedded-agent-runner/run/llm-idle-timeout.ts`.
 */
const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

interface AgentsDefaultsLike {
  timeoutSeconds?: unknown;
}

interface AgentsBlockLike {
  defaults?: AgentsDefaultsLike;
}

interface ProviderEntryLike {
  timeoutSeconds?: unknown;
}

interface ModelsBlockLike {
  providers?: Record<string, ProviderEntryLike | undefined> | undefined;
}

interface CfgShape {
  agents?: AgentsBlockLike;
  models?: ModelsBlockLike;
}

function positiveSecondsToMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value * 1000);
}

/**
 * Resolve the QQBot outbound response watchdog (ms).
 *
 * The watchdog is the longest of:
 *   - `DEFAULT_RESPONSE_TIMEOUT_MS` (5 min, historical floor)
 *   - `cfg.agents.defaults.timeoutSeconds` converted to ms
 *   - the maximum `cfg.models.providers.<id>.timeoutSeconds` across
 *     configured providers, converted to ms
 *
 * Returns at most `MAX_SAFE_TIMEOUT_MS` so the chosen value is always
 * a safe `setTimeout` argument.
 */
export function resolveResponseTimeoutMs(cfg: unknown): number {
  const candidates: number[] = [DEFAULT_RESPONSE_TIMEOUT_MS];

  const typed = (cfg ?? {}) as CfgShape;

  const agentDefaultMs = positiveSecondsToMs(typed.agents?.defaults?.timeoutSeconds);
  if (agentDefaultMs !== undefined) {
    candidates.push(agentDefaultMs);
  }

  const providers = typed.models?.providers;
  if (providers && typeof providers === "object") {
    for (const entry of Object.values(providers)) {
      const providerMs = positiveSecondsToMs(entry?.timeoutSeconds);
      if (providerMs !== undefined) {
        candidates.push(providerMs);
      }
    }
  }

  const chosen = Math.max(...candidates);
  return Math.min(chosen, MAX_SAFE_TIMEOUT_MS);
}
