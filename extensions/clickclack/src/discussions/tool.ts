import { textResult } from "openclaw/plugin-sdk/tool-results";
import type { ClickClackDiscussionService } from "./service.js";

const DEFAULT_MESSAGE_LIMIT = 30;
const MAX_MESSAGE_LIMIT = 200;

export function createClickClackDiscussionTool(params: {
  service: ClickClackDiscussionService;
  sessionKey?: string;
}) {
  return {
    name: "discussion",
    label: "Discussion",
    description: "Read the latest messages from the ClickClack discussion bound to this session.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_MESSAGE_LIMIT,
          description: `Maximum messages to return (default ${DEFAULT_MESSAGE_LIMIT}).`,
        },
      },
      additionalProperties: false,
    } as never,
    async execute(_toolCallId: string, input: unknown) {
      if (!params.sessionKey) {
        return textResult("No discussion is bound to this session.", { bound: false });
      }
      const requested =
        typeof input === "object" && input !== null && "limit" in input
          ? Number((input as { limit?: unknown }).limit)
          : DEFAULT_MESSAGE_LIMIT;
      const limit = Number.isInteger(requested)
        ? Math.max(1, Math.min(MAX_MESSAGE_LIMIT, requested))
        : DEFAULT_MESSAGE_LIMIT;
      const result = await params.service.readLatestMessages(params.sessionKey, limit);
      return textResult(result.text, {
        bound: Boolean(result.binding),
        limit,
        ...(result.binding ? { channelId: result.binding.channelId } : {}),
      });
    },
  };
}
