import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderTransformSystemPromptContext } from "../../../plugins/types.js";
import {
  appendAgentBootstrapSystemPromptSupplement,
  appendModelIdentitySystemPrompt,
} from "../../system-prompt.js";
import { buildEmbeddedSystemPrompt, createSystemPromptOverride } from "../system-prompt.js";

type EmbeddedSystemPromptParams = Parameters<typeof buildEmbeddedSystemPrompt>[0];
type ProviderSystemPromptTransform = (params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir: string;
  context: ProviderTransformSystemPromptContext;
}) => string;

export type BuildAttemptSystemPromptParams = {
  isRawModelRun: boolean;
  systemPromptOverrideText?: string;
  embeddedSystemPrompt: EmbeddedSystemPromptParams;
  transformProviderSystemPrompt: ProviderSystemPromptTransform;
  providerTransform: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir: string;
    context: Omit<ProviderTransformSystemPromptContext, "systemPrompt">;
  };
};

export type AttemptSystemPrompt = {
  baseSystemPrompt: string;
  systemPrompt: string;
  systemPromptOverride: (defaultPrompt?: string) => string;
};

function appendRuntimeExtraSystemPrompt(params: {
  systemPrompt: string;
  extraSystemPrompt?: string;
  promptMode?: EmbeddedSystemPromptParams["promptMode"];
}): string {
  const extraSystemPrompt = params.extraSystemPrompt?.trim();
  if (!extraSystemPrompt || params.promptMode === "none") {
    return params.systemPrompt;
  }
  const contextHeader =
    params.promptMode === "minimal" ? "## Subagent Context" : "## Group Chat Context";
  return `${params.systemPrompt.trimEnd()}\n\n${contextHeader}\n${extraSystemPrompt}\n`;
}

export function buildAttemptSystemPrompt(
  params: BuildAttemptSystemPromptParams,
): AttemptSystemPrompt {
  const baseSystemPrompt = params.systemPromptOverrideText
    ? appendModelIdentitySystemPrompt({
        systemPrompt: appendRuntimeExtraSystemPrompt({
          systemPrompt: appendAgentBootstrapSystemPromptSupplement({
            systemPrompt: params.systemPromptOverrideText,
            bootstrapMode: params.embeddedSystemPrompt.bootstrapMode,
            bootstrapTruncationNotice: params.embeddedSystemPrompt.bootstrapTruncationNotice,
            contextFiles: params.embeddedSystemPrompt.contextFiles,
          }),
          extraSystemPrompt: params.embeddedSystemPrompt.extraSystemPrompt,
          promptMode: params.embeddedSystemPrompt.promptMode,
        }),
        model: params.embeddedSystemPrompt.runtimeInfo.model,
      })
    : buildEmbeddedSystemPrompt(params.embeddedSystemPrompt);

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
    systemPromptOverride: createSystemPromptOverride(systemPrompt),
  };
}
