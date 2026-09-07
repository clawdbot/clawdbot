// Vercel Ai Gateway setup module handles plugin onboarding behavior.
import {
  createAliasOnlyPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF = "vercel-ai-gateway/anthropic/claude-opus-4.6";
const vercelAiGatewayPresetAppliers = createAliasOnlyPresetAppliers({
  modelRef: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
  alias: "Vercel AI Gateway",
});

export function applyVercelAiGatewayConfig(cfg: OpenClawConfig): OpenClawConfig {
  return vercelAiGatewayPresetAppliers.applyConfig(cfg);
}
