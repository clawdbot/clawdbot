// Slack plugin module adapts suggested prompts for Assistant View and Agent View.
import type { App } from "@slack/bolt";
import { WebAPIPlatformError } from "@slack/web-api";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatSlackError } from "../errors.js";

type SlackSuggestedPrompt = { title: string; message: string };

export type SlackSuggestedPromptsOutcome = "accepted" | "rejected" | "internal_error" | "failed";

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
  params: SlackSuggestedPromptsInput & { botToken: string; client: App["client"] },
): Promise<SlackSuggestedPromptsOutcome> {
  const prompts = params.prompts
    .map(({ title, message }) => ({ title: title.trim(), message: message.trim() }))
    .filter((prompt) => prompt.title && prompt.message)
    .slice(0, 4);
  if (prompts.length === 0) {
    logVerbose(
      `slack suggested prompts update failed for channel ${params.channelId}: failed (no prompts)`,
    );
    return "failed";
  }
  try {
    await params.client.assistant.threads.setSuggestedPrompts({
      token: params.botToken,
      channel_id: params.channelId,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
      ...(params.title?.trim() ? { title: params.title.trim() } : {}),
      prompts,
    });
    return "accepted";
  } catch (error) {
    // The threadless call discriminates Agent View: not_agent_app/missing_scope reject up front.
    // Agent apps answer ok or internal_error (live-verified 2026-09-02).
    // Transport failures prove nothing about Agent View.
    const code = error instanceof WebAPIPlatformError ? error.data.error : undefined;
    const outcome =
      code === "not_agent_app" || code === "missing_scope"
        ? "rejected"
        : code === "internal_error"
          ? "internal_error"
          : "failed";
    logVerbose(
      `slack suggested prompts update failed for channel ${params.channelId}: ${outcome}: ${formatSlackError(error)}`,
    );
    return outcome;
  }
}
