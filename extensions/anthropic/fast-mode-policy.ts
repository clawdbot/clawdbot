import {
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaudeFastMode,
} from "openclaw/plugin-sdk/claude-model-runtime";
import type { ProviderFastModePolicyContext } from "openclaw/plugin-sdk/provider-model-types";

export type AnthropicServiceTier = "auto" | "standard_only";

export function supportsAnthropicPriorityTier(model: {
  id: string;
  params?: Record<string, unknown>;
}): boolean {
  return !resolveClaudeOpus5ModelIdentity(model) && !resolveClaudeSonnet5ModelIdentity(model);
}

export function normalizeAnthropicServiceTier(value: unknown): AnthropicServiceTier | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  return normalized === "auto" || normalized === "standard_only" ? normalized : undefined;
}

/** The request wrapper and model controls share this plan; it does not claim vendor entitlement. */
export function resolveAnthropicFastModePlan(
  context: ProviderFastModePolicyContext,
): "native" | "service-tier" | false | undefined {
  if (
    context.provider.trim().toLowerCase() !== "anthropic" ||
    (context.runtimeId !== undefined &&
      context.runtimeId !== "auto" &&
      context.runtimeId !== "openclaw")
  ) {
    return undefined;
  }
  if (
    normalizeAnthropicServiceTier(context.params?.serviceTier ?? context.params?.service_tier) ||
    context.authMode === "oauth"
  ) {
    return false;
  }
  const model = { id: context.modelId, params: context.modelParams };
  const native = supportsClaudeFastMode(model);
  if (!native && !supportsAnthropicPriorityTier(model)) {
    return false;
  }
  if (!context.api) {
    return undefined;
  }
  const { endpointClass, allowsAnthropicServiceTier } = context.requestCapabilities;
  if (
    native
      ? context.api.trim().toLowerCase() !== "anthropic-messages" ||
        (endpointClass !== "default" && endpointClass !== "anthropic-public")
      : !allowsAnthropicServiceTier
  ) {
    return false;
  }
  if (context.authMode !== "api_key") {
    return undefined;
  }
  return native ? "native" : "service-tier";
}

export function resolveFastModeSupport(
  context: ProviderFastModePolicyContext,
): boolean | undefined {
  const plan = resolveAnthropicFastModePlan(context);
  return plan === undefined ? undefined : plan !== false;
}
