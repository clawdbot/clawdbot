// Slack plugin module adapts suggested prompts for Assistant View and Agent View.
import type { App } from "@slack/bolt";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatSlackError } from "../errors.js";

type SlackSuggestedPrompt = {
  title: string;
  message: string;
};

export type SlackSuggestedPromptsInput = {
  channelId: string;
  threadTs?: string;
  title?: string;
  prompts: SlackSuggestedPrompt[];
};

export const DEFAULT_SLACK_SUGGESTED_PROMPTS: SlackSuggestedPrompt[] = [
  { title: "What can you do?", message: "What can you help me with?" },
  { title: "Summarize this channel", message: "Summarize the recent activity in this channel." },
  { title: "Draft a reply", message: "Help me draft a reply." },
];

export async function updateSlackSuggestedPrompts(
  params: SlackSuggestedPromptsInput & {
    botToken: string;
    client: App["client"];
  },
): Promise<boolean> {
  const prompts = params.prompts
    .map((prompt) => ({
      title: prompt.title.trim(),
      message: prompt.message.trim(),
    }))
    .filter((prompt) => prompt.title && prompt.message)
    .slice(0, 4);
  if (prompts.length === 0) {
    return false;
  }
  try {
    await params.client.assistant.threads.setSuggestedPrompts({
      token: params.botToken,
      channel_id: params.channelId,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
      ...(params.title?.trim() ? { title: params.title.trim() } : {}),
      prompts,
    });
    return true;
  } catch (error) {
    logVerbose(
      `slack suggested prompts update failed for channel ${params.channelId}: ${formatSlackError(error)}`,
    );
    return false;
  }
}
