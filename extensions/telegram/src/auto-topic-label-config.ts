import type { TelegramAccountConfig, TelegramDirectConfig } from "openclaw/plugin-sdk/config-types";

export const AUTO_TOPIC_LABEL_DEFAULT_PROMPT =
  "Generate a very short topic label (2-4 words, max 25 chars) for a chat conversation based on the user's first message below. No emoji. Use the same language as the message. Be concise and descriptive. Return ONLY the topic name, nothing else.";

export function resolveAutoTopicLabelConfig(
  directConfig?: TelegramDirectConfig["autoTopicLabel"],
  accountConfig?: TelegramAccountConfig["autoTopicLabel"],
): { enabled: true; prompt: string } | null {
  const config = directConfig ?? accountConfig;
  if (config === undefined || config === true) {
    return { enabled: true, prompt: AUTO_TOPIC_LABEL_DEFAULT_PROMPT };
  }
  if (config === false || config.enabled === false) {
    return null;
  }
  return {
    enabled: true,
    prompt: config.prompt?.trim() || AUTO_TOPIC_LABEL_DEFAULT_PROMPT,
  };
}
