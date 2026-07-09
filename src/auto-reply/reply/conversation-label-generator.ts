// Generates short labels for sessions from conversation context.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import type { TextContent } from "../../llm/types.js";

const DEFAULT_MAX_LABEL_LENGTH = 128;
// Reasoning models spend output tokens before emitting the short visible label.
// A tiny cap can leave no text, so keep the bounded title budget large enough
// for reasoning while respecting models with a lower output limit.
const CONVERSATION_LABEL_MAX_TOKENS = 4_096;
const TIMEOUT_MS = 15_000;

/** Inputs for generating a short conversation label from the configured utility model. */
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
  return model.api === "openai-chatgpt-responses";
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

/** Generates a bounded human-readable label for a session, or null on failure. */
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
  let prepared: Awaited<ReturnType<typeof prepareSimpleCompletionModelForAgent>>;
  try {
    prepared = await prepareSimpleCompletionModelForAgent({
      cfg,
      agentId: agentId ?? resolveDefaultAgentId(cfg),
      agentDir,
      useUtilityModel: true,
      useAsyncModelResolution: true,
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  } catch (err) {
    logVerbose(`conversation-label-generator: model preparation failed: ${String(err)}`);
    return null;
  }
  if ("error" in prepared) {
    logVerbose(`conversation-label-generator: ${prepared.error}`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const maxTokens = Math.min(CONVERSATION_LABEL_MAX_TOKENS, Math.floor(prepared.model.maxTokens));
    // Label generation should never block normal reply handling for long.
    const result = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      cfg,
      context: {
        systemPrompt: prompt,
        messages: [
          {
            role: "user",
            content: userMessage,
            timestamp: Date.now(),
          },
        ],
      },
      options: {
        maxTokens,
        ...(isCodexSimpleCompletionModel(prepared.model) ? {} : { temperature: 0.3 }),
        signal: controller.signal,
      },
    });
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

    return truncateUtf16Safe(text, maxLength) || null;
  } catch (err) {
    logVerbose(`conversation-label-generator: completion failed: ${String(err)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
