import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";
import { parseModelRefProvider } from "./openai-codex-routing.js";

export const GITHUB_COPILOT_PROVIDER_ID = "github-copilot";

/**
 * Canonical id of the Copilot agent runtime plugin
 * (see `extensions/copilot/index.ts`, which registers as `id: "copilot"`).
 */
export const COPILOT_RUNTIME_ID = "copilot";

function parseModelRefId(model: string | undefined): string | undefined {
  if (typeof model !== "string") {
    return undefined;
  }
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return undefined;
  }
  return trimmed.slice(slash + 1);
}

/**
 * Returns true when the selected model should trigger the on-demand
 * install of `@github/copilot-sdk` for the Copilot agent runtime.
 *
 * Gating contract (review #2, P1):
 *   - Model ref must use the `github-copilot/*` provider prefix.
 *   - The user's config must explicitly opt in by setting
 *     `agentRuntime.id: "copilot"` at the provider, model, or agent scope
 *     (resolved via `resolveModelRuntimePolicy`).
 *
 * Without the explicit opt-in we fall through to the built-in GitHub
 * Copilot provider, which has shipped support for `github-copilot/*`
 * models for a long time and must not surface a 260 MB SDK install
 * prompt to users who never asked for the runtime.
 */
export function modelSelectionShouldEnsureCopilotSdk(params: {
  model?: string;
  config?: OpenClawConfig;
}): boolean {
  if (parseModelRefProvider(params.model) !== GITHUB_COPILOT_PROVIDER_ID) {
    return false;
  }
  const modelId = parseModelRefId(params.model);
  const resolved = resolveModelRuntimePolicy({
    config: params.config,
    provider: GITHUB_COPILOT_PROVIDER_ID,
    modelId,
  });
  const runtimeId = resolved.policy?.id?.trim().toLowerCase();
  return runtimeId === COPILOT_RUNTIME_ID;
}
