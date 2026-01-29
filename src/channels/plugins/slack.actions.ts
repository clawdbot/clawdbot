import { createActionGate, readNumberParam, readStringParam } from "../../agents/tools/common.js";
import { handleSlackAction, type SlackActionContext } from "../../agents/tools/slack-actions.js";
import { listEnabledSlackAccounts } from "../../slack/accounts.js";
import { resolveSlackChannelId } from "../../slack/targets.js";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelToolSend,
} from "./types.js";

export function createSlackActions(providerId: string): ChannelMessageActionAdapter {
  return {
    listActions: ({ cfg }) => {
      const accounts = listEnabledSlackAccounts(cfg).filter(
        (account) => account.botTokenSource !== "none",
      );
      if (accounts.length === 0) return [];
      const isActionEnabled = (key: string, defaultValue = true) => {
        for (const account of accounts) {
          const gate = createActionGate(
            (account.actions ?? cfg.channels?.slack?.actions) as Record<
              string,
              boolean | undefined
            >,
          );
          if (gate(key, defaultValue)) return true;
        }
        return false;
      };

      const actions = new Set<ChannelMessageActionName>(["send"]);
      if (isActionEnabled("reactions")) {
        actions.add("react");
        actions.add("reactions");
      }
      if (isActionEnabled("messages")) {
        actions.add("read");
        actions.add("edit");
        actions.add("delete");
      }
      if (isActionEnabled("pins")) {
        actions.add("pin");
        actions.add("unpin");
        actions.add("list-pins");
      }
      if (isActionEnabled("memberInfo")) actions.add("member-info");
      if (isActionEnabled("emojiList")) actions.add("emoji-list");
      if (isActionEnabled("channelInfo")) {
        actions.add("channel-info");
        actions.add("mark-read");
      }
      return Array.from(actions);
    },
    extractToolSend: ({ args }): ChannelToolSend | null => {
      const action = typeof args.action === "string" ? args.action.trim() : "";
      if (action !== "sendMessage") return null;
      const to = typeof args.to === "string" ? args.to : undefined;
      if (!to) return null;
      const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
      return { to, accountId };
    },
    handleAction: async (ctx: ChannelMessageActionContext) => {
      const { action, params, cfg } = ctx;
      const accountId = ctx.accountId ?? undefined;
      const toolContext = ctx.toolContext as SlackActionContext | undefined;
      const resolveChannelId = () =>
        resolveSlackChannelId(
          readStringParam(params, "channelId") ?? readStringParam(params, "to", { required: true }),
        );

      if (action === "send") {
        const to = readStringParam(params, "to", { required: true });
        const content = readStringParam(params, "message", {
          required: true,
          allowEmpty: true,
        });
        const mediaUrl = readStringParam(params, "media", { trim: false });
        const threadId = readStringParam(params, "threadId");
        const replyTo = readStringParam(params, "replyTo");
        return await handleSlackAction(
          {
            action: "sendMessage",
            to,
            content,
            mediaUrl: mediaUrl ?? undefined,
            accountId: accountId ?? undefined,
            threadTs: threadId ?? replyTo ?? undefined,
          },
          cfg,
          toolContext,
        );
      }

      if (action === "react") {
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const emoji = readStringParam(params, "emoji", { allowEmpty: true });
        const remove = typeof params.remove === "boolean" ? params.remove : undefined;
        return await handleSlackAction(
          {
            action: "react",
            channelId: resolveChannelId(),
            messageId,
            emoji,
            remove,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      if (action === "reactions") {
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const limit = readNumberParam(params, "limit", { integer: true });
        return await handleSlackAction(
          {
            action: "reactions",
            channelId: resolveChannelId(),
            messageId,
            limit,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      if (action === "read") {
        const limit = readNumberParam(params, "limit", { integer: true });
        return await handleSlackAction(
          {
            action: "readMessages",
            channelId: resolveChannelId(),
            limit,
            before: readStringParam(params, "before"),
            after: readStringParam(params, "after"),
            threadId: readStringParam(params, "threadId"),
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      if (action === "edit") {
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const content = readStringParam(params, "message", { required: true });
        return await handleSlackAction(
          {
            action: "editMessage",
            channelId: resolveChannelId(),
            messageId,
            content,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      if (action === "delete") {
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        return await handleSlackAction(
          {
            action: "deleteMessage",
            channelId: resolveChannelId(),
            messageId,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      if (action === "pin" || action === "unpin" || action === "list-pins") {
        const messageId =
          action === "list-pins"
            ? undefined
            : readStringParam(params, "messageId", { required: true });
        return await handleSlackAction(
          {
            action:
              action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
            channelId: resolveChannelId(),
            messageId,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      if (action === "member-info") {
        const userId = readStringParam(params, "userId", { required: true });
        return await handleSlackAction(
          { action: "memberInfo", userId, accountId: accountId ?? undefined },
          cfg,
        );
      }

      if (action === "emoji-list") {
        return await handleSlackAction(
          { action: "emojiList", accountId: accountId ?? undefined },
          cfg,
        );
      }

      if (action === "channel-info") {
        return await handleSlackAction(
          {
            action: "channelInfo",
            channelId: resolveChannelId(),
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      if (action === "mark-read") {
        const timestamp = readStringParam(params, "timestamp", { required: true });
        return await handleSlackAction(
          {
            action: "markRead",
            channelId: resolveChannelId(),
            timestamp,
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
    },
  };
}
