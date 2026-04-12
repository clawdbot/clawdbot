import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { resolveModelAsync } from "../../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../../agents/simple-completion-transport.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";

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
    await getApiKeyForModel({ model: completionModel, cfg, agentDir }),
    modelRef.provider,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const result = await completeSimple(
      completionModel,
      {
        messages: [
          {
            role: "user",
            content: `${prompt}\n\n${userMessage}`,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: 100,
        temperature: 0.3,
        signal: controller.signal,
      },
    );

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
