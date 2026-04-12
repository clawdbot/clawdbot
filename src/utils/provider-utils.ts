import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { resolveProviderReasoningOutputModeWithPlugin } from "../plugins/provider-runtime.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

const BUILTIN_REASONING_OUTPUT_MODES = {
  "google-generative-ai": "tagged",
} as const;

/**
 * Utility functions for provider-specific logic and capabilities.
 */

export function resolveReasoningOutputMode(params: {
  provider: string | undefined | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
}): "native" | "tagged" {
  const provider = normalizeOptionalString(params.provider);
  if (!provider) {
    return "native";
  }

  const normalized = normalizeOptionalLowercaseString(provider) ?? "";
  const pluginMode = resolveProviderReasoningOutputModeWithPlugin({
    provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    context: {
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      model: params.model,
    },
  });
  if (pluginMode) {
    return pluginMode;
  }

  const builtInMode =
    BUILTIN_REASONING_OUTPUT_MODES[normalized as keyof typeof BUILTIN_REASONING_OUTPUT_MODES];
  if (builtInMode) {
    return builtInMode;
  }

  // Keep a tiny built-in fallback for non-plugin Google surfaces.
  return "native";
}

/**
 * Returns true if the provider requires reasoning to be wrapped in tags
 * (e.g. <think> and <final>) in the text stream, rather than using native
 * API fields for reasoning/thinking.
 */
export function isReasoningTagProvider(
  provider: string | undefined | null,
  options?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    modelId?: string;
    modelApi?: string | null;
    model?: ProviderRuntimeModel;
  },
): boolean {
  return (
    resolveReasoningOutputMode({
      provider,
      config: options?.config,
      workspaceDir: options?.workspaceDir,
      env: options?.env,
      modelId: options?.modelId,
      modelApi: options?.modelApi,
      model: options?.model,
    }) === "tagged"
  );
}
