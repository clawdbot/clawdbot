import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { generateConversationLabel } from "openclaw/plugin-sdk/reply-runtime";
export {
  AUTO_TOPIC_LABEL_DEFAULT_PROMPT,
  resolveAutoTopicLabelConfig,
} from "./auto-topic-label-config.js";

export async function generateTelegramTopicLabel(params: {
  userMessage: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
}): Promise<string | null> {
  return await generateConversationLabel({
    ...params,
    maxLength: 128,
  });
}
