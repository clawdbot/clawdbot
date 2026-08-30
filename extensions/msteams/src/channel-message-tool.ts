import type {
  ChannelMessageActionAdapter,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import { Type } from "typebox";
import type { ChannelMessageActionName } from "../runtime-api.js";
import { resolveMSTeamsAccount } from "./accounts.js";

export function describeMSTeamsMessageTool({
  cfg,
  accountId,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const account = resolveMSTeamsAccount({ cfg, accountId });
  const enabled = account.enabled && account.configured && account.tokenStatus === "available";
  return {
    actions: enabled
      ? ([
          "upload-file",
          "poll",
          "edit",
          "delete",
          "pin",
          "unpin",
          "list-pins",
          "read",
          "react",
          "reactions",
          "search",
          "member-info",
          "channel-list",
          "channel-info",
          "addParticipant",
          "removeParticipant",
          "renameGroup",
        ] satisfies ChannelMessageActionName[])
      : [],
    capabilities: enabled ? ["presentation"] : [],
    schema: enabled
      ? {
          actions: ["unpin"],
          properties: {
            pinnedMessageId: Type.Optional(
              Type.String({
                description:
                  "Pinned message resource ID for unpin (from pin or list-pins, not the chat message ID).",
              }),
            ),
          },
        }
      : null,
  };
}
