// Xai plugin module implements x search tool shared behavior.
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";

export const X_SEARCH_HANDLE_LIMIT = 20;

export function buildMissingXSearchApiKeyPayload() {
  return {
    error: "missing_xai_api_key",
    message:
      "x_search needs xAI credentials. Run `openclaw onboard --auth-choice xai-oauth` to sign in with Grok, run `openclaw onboard --auth-choice xai-api-key`, set `XAI_API_KEY` in the Gateway environment, or configure `plugins.entries.xai.config.webSearch.apiKey`.",
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

export function createXSearchToolDefinition(
  execute: (toolCallId: string, args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>,
) {
  return {
    label: "X Search",
    name: "x_search",
    description:
      "Search X (formerly Twitter) using xAI, including targeted post or thread lookups. For per-post stats like reposts, replies, bookmarks, or views, prefer the exact post URL or status ID.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Natural-language instruction sent to the Grok X-search agent. Must be meaningful and non-empty.",
      }),
      allowed_x_handles: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description:
            "Only include posts from these X handles (max 20). Cannot be combined with excluded_x_handles.",
          maxItems: X_SEARCH_HANDLE_LIMIT,
        }),
      ),
      excluded_x_handles: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description:
            "Exclude posts from these X handles (max 20). Cannot be combined with allowed_x_handles.",
          maxItems: X_SEARCH_HANDLE_LIMIT,
        }),
      ),
      from_date: Type.Optional(
        Type.String({ description: "Only include posts on or after this date (YYYY-MM-DD)." }),
      ),
      to_date: Type.Optional(
        Type.String({ description: "Only include posts on or before this date (YYYY-MM-DD)." }),
      ),
      enable_image_understanding: Type.Optional(
        Type.Boolean({ description: "Allow xAI to inspect images attached to matching posts." }),
      ),
      enable_video_understanding: Type.Optional(
        Type.Boolean({ description: "Allow xAI to inspect videos attached to matching posts." }),
      ),
    }),
    execute,
  };
}
