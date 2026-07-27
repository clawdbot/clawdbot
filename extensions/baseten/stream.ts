/** Baseten request payload policy for models with opt-in chat-template reasoning. */
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { usesBasetenChatTemplateThinking } from "./models.js";

const BASETEN_DEEPSEEK_V4_MODEL_ID = "deepseek-ai/deepseek-v4-pro";

function isThinkingEnabled(level: ProviderWrapStreamFnContext["thinkingLevel"]): boolean {
  return level !== undefined && level !== "off";
}

function isBasetenDeepSeekV4ModelId(modelId: string): boolean {
  return modelId.trim().toLowerCase() === BASETEN_DEEPSEEK_V4_MODEL_ID;
}

function patchBasetenDeepSeekV4Replay(
  payload: Record<string, unknown>,
  thinkingEnabled: boolean,
): void {
  if (!Array.isArray(payload.messages)) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") {
      continue;
    }
    // DeepSeek V4 requires reasoning_content on replayed assistant turns.
    // Cross-provider turns lack it, so backfill while thinking is enabled.
    if (thinkingEnabled) {
      record.reasoning_content ??= "";
    } else {
      delete record.reasoning_content;
    }
  }
}

/** Adds Baseten's `chat_template_args.enable_thinking` without dropping caller args. */
export function createBasetenThinkingWrapper(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  return createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload, model }) => {
    if (model.provider !== "baseten" || model.api !== "openai-completions") {
      return;
    }
    if (isBasetenDeepSeekV4ModelId(model.id)) {
      // DeepSeek reasoning defaults on when no level is supplied. Only an
      // explicit `off` may remove its required replay metadata.
      patchBasetenDeepSeekV4Replay(payload, ctx.thinkingLevel !== "off");
    }
    if (!usesBasetenChatTemplateThinking(model.id)) {
      return;
    }
    const existing =
      payload.chat_template_args &&
      typeof payload.chat_template_args === "object" &&
      !Array.isArray(payload.chat_template_args)
        ? (payload.chat_template_args as Record<string, unknown>)
        : {};
    payload.chat_template_args = {
      ...existing,
      enable_thinking: isThinkingEnabled(ctx.thinkingLevel),
    };
  });
}
