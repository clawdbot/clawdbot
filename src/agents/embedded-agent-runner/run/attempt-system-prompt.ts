/**
 * Builds the system prompt inputs for a single embedded-agent attempt.
 */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderTransformSystemPromptContext } from "../../../plugins/types.js";
import { buildEmbeddedSystemPrompt } from "../system-prompt.js";

type EmbeddedSystemPromptParams = Parameters<typeof buildEmbeddedSystemPrompt>[0];
type ProviderSystemPromptTransform = (params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir: string;
  context: ProviderTransformSystemPromptContext;
}) => string;

export type BuildAttemptSystemPromptParams = {
  isRawModelRun: boolean;
  embeddedSystemPrompt: EmbeddedSystemPromptParams;
  transformProviderSystemPrompt: ProviderSystemPromptTransform;
  providerTransform: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir: string;
    context: Omit<ProviderTransformSystemPromptContext, "systemPrompt">;
  };
};

/** System prompt pair used by an attempt: untransformed base plus provider-ready prompt. */
export type AttemptSystemPrompt = {
  baseSystemPrompt: string;
  systemPrompt: string;
};

/**
 * Builds the embedded system prompt and applies provider-specific transforms
 * unless this is a raw model run. Raw runs still keep `baseSystemPrompt` for
 * diagnostics/cache boundaries, but submit an empty provider prompt.
 */
export function buildAttemptSystemPrompt(
  params: BuildAttemptSystemPromptParams,
): AttemptSystemPrompt {
  const baseSystemPrompt = buildEmbeddedSystemPrompt(params.embeddedSystemPrompt);
  const systemPrompt = params.isRawModelRun
    ? ""
    : params.transformProviderSystemPrompt({
        provider: params.providerTransform.provider,
        config: params.providerTransform.config,
        workspaceDir: params.providerTransform.workspaceDir,
        context: {
          ...params.providerTransform.context,
          systemPrompt: baseSystemPrompt,
        },
      });

  return {
    baseSystemPrompt,
    systemPrompt,
  };
}
