import { completeSimple, type TextContent } from "@earendil-works/pi-ai";
import { requireApiKey } from "../../agents/model-auth.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { resolveModelAsync } from "../../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../../agents/simple-completion-transport.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { getRuntimeAuthForModel } from "../../plugins/runtime/runtime-model-auth.runtime.js";

const DEFAULT_MAX_LABEL_LENGTH = 128;
const TIMEOUT_MS = 15_000;

export type ConversationLabelParams = {
  userMessage: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  maxLength?: number;
};

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

function isCodexSimpleCompletionModel(model: { api?: string; provider?: string }): boolean {
  return model.provider === "openai-codex" || model.api === "openai-codex-responses";
}

function extractSimpleCompletionError(result: {
  stopReason?: string;
  errorMessage?: string;
}): string | null {
  if (result.stopReason !== "error") {
    return null;
  }
  return result.errorMessage?.trim() || "unknown error";
}

export async function generateConversationLabel(
  params: ConversationLabelParams,
): Promise<string | null> {
  const { userMessage, prompt, cfg, agentId, agentDir } = params;
  const maxLength =
    typeof params.maxLength === "number" &&
    Number.isFinite(params.maxLength) &&
    params.maxLength > 0
      ? Math.floor(params.maxLength)
      : DEFAULT_MAX_LABEL_LENGTH;
  const modelRef = resolveDefaultModelForAgent({ cfg, agentId });
  const resolved = await resolveModelAsync(modelRef.provider, modelRef.model, agentDir, cfg);
  if (!resolved.model) {
    logVerbose(
      `conversation-label-generator: failed to resolve model ${modelRef.provider}/${modelRef.model}`,
    );
    return null;
  }
  const completionModel = prepareModelForSimpleCompletion({ model: resolved.model, cfg });

  const apiKey = requireApiKey(
    await getRuntimeAuthForModel({
      model: completionModel,
      cfg,
      workspaceDir: agentDir,
    }),
    modelRef.provider,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const result = await completeSimple(
      completionModel,
      {
        systemPrompt: prompt,
        messages: [
          {
            role: "user",
            content: userMessage,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: 100,
        ...(isCodexSimpleCompletionModel(completionModel) ? {} : { temperature: 0.3 }),
        signal: controller.signal,
      },
    );
    const errorMessage = extractSimpleCompletionError(result);
    if (errorMessage) {
      logVerbose(`conversation-label-generator: completion failed: ${errorMessage}`);
      return null;
    }

    const text = result.content
      .filter(isTextContentBlock)
      .map((block) => block.text)
      .join("")
      .trim();

    if (!text) {
      return null;
    }

    return text.slice(0, maxLength);
  } finally {
    clearTimeout(timeout);
  }
}
