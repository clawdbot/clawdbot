import {
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "../runtime-api.js";
import { discordMessagingActionRuntime } from "./runtime.messaging.runtime.js";
import type { DiscordMessagingActionContext } from "./runtime.messaging.shared.js";

export async function handleDiscordReactionMessagingAction(ctx: DiscordMessagingActionContext) {
  switch (ctx.action) {
    case "react": {
      if (!ctx.isActionEnabled("reactions")) {
        throw new Error("Discord reactions are disabled.");
      }
      const channelId = await ctx.resolveReactionChannelId();
      const messageId = readStringParam(ctx.params, "messageId", {
        required: true,
      });
      const { emoji, remove, isEmpty } = readReactionParams(ctx.params, {
        removeErrorMessage: "Emoji is required to remove a Discord reaction.",
      });
      if (remove) {
        await discordMessagingActionRuntime.removeReactionDiscord(
          channelId,
          messageId,
          emoji,
          ctx.withReactionRuntimeOptions(),
        );
        return jsonResult({ ok: true, removed: emoji });
      }
      if (isEmpty) {
        const removed = await discordMessagingActionRuntime.removeOwnReactionsDiscord(
          channelId,
          messageId,
          ctx.withReactionRuntimeOptions(),
        );
        return jsonResult({ ok: true, removed: removed.removed });
      }
      await discordMessagingActionRuntime.reactMessageDiscord(
        channelId,
        messageId,
        emoji,
        ctx.withReactionRuntimeOptions(),
      );
      return jsonResult({ ok: true, added: emoji });
    }
    case "reactions": {
      if (!ctx.isActionEnabled("reactions")) {
        throw new Error("Discord reactions are disabled.");
      }
      const channelId = await ctx.resolveReactionChannelId();
      const messageId = readStringParam(ctx.params, "messageId", {
        required: true,
      });
      const limit = readNumberParam(ctx.params, "limit");
      const reactions = await discordMessagingActionRuntime.fetchReactionsDiscord(
        channelId,
        messageId,
        ctx.withReactionRuntimeOptions({ limit }),
      );
      return jsonResult({ ok: true, reactions });
    }
    default:
      return undefined;
  }
}
