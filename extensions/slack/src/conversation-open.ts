import type { WebClient } from "@slack/web-api";
import { z } from "zod";
import { formatSlackTarget } from "./target-parsing.js";

export function parseSlackConversationOpenInput(userIds: unknown, teamId?: string) {
  // Slack opens one conversation for 1-8 other users and includes the caller.
  // Reject malformed/duplicate recipients instead of silently changing the audience.
  const users = z
    .array(
      z
        .string()
        .trim()
        .regex(/^[UW][A-Z0-9]+$/),
    )
    .min(1)
    .max(8)
    .parse(userIds);
  if (new Set(users).size !== users.length) {
    throw new Error("Slack conversation-open requires distinct userIds.");
  }
  return {
    users,
    teamId:
      teamId === undefined
        ? undefined
        : z
            .string()
            .trim()
            .regex(/^T[A-Z0-9]+$/i)
            .parse(teamId),
  };
}

export async function openSlackConversationWithClient(
  client: WebClient,
  input: ReturnType<typeof parseSlackConversationOpenInput>,
) {
  // Request only the ID: opening a conversation does not authorize reading its history.
  const result = await client.conversations.open({ users: input.users.join(",") });
  const channelId = result.channel?.id?.trim();
  if (!channelId || !/^[CDG][A-Z0-9]+$/i.test(channelId)) {
    throw new Error("Slack conversations.open did not return a valid conversation ID.");
  }
  return {
    channelId,
    target: formatSlackTarget({
      teamId: input.teamId,
      kind: "channel",
      id: channelId,
      explicitKind: true,
    }),
  };
}
