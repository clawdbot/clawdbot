import {
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../runtime-api.js";
import { discordMessagingActionRuntime } from "./runtime.messaging.runtime.js";
import type { DiscordMessagingActionContext } from "./runtime.messaging.shared.js";

function parseDiscordMessageLink(link: string) {
  const normalized = link.trim();
  const match = normalized.match(
    /^(?:https?:\/\/)?(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)(?:\/?|\?.*)$/i,
  );
  if (!match) {
    throw new Error(
      "Invalid Discord message link. Expected https://discord.com/channels/<guildId>/<channelId>/<messageId>.",
    );
  }
  return {
    guildId: match[1],
    channelId: match[2],
    messageId: match[3],
  };
}

export async function handleDiscordMessageManagementAction(ctx: DiscordMessagingActionContext) {
  switch (ctx.action) {
    case "permissions": {
      if (!ctx.isActionEnabled("permissions")) {
        throw new Error("Discord permissions are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      const permissions = await discordMessagingActionRuntime.fetchChannelPermissionsDiscord(
        channelId,
        ctx.withOpts(),
      );
      return jsonResult({ ok: true, permissions });
    }
    case "fetchMessage": {
      if (!ctx.isActionEnabled("messages")) {
        throw new Error("Discord message reads are disabled.");
      }
      const messageLink = readStringParam(ctx.params, "messageLink");
      let guildId = readStringParam(ctx.params, "guildId");
      let channelId = readStringParam(ctx.params, "channelId");
      let messageId = readStringParam(ctx.params, "messageId");
      if (messageLink) {
        const parsed = parseDiscordMessageLink(messageLink);
        guildId = parsed.guildId;
        channelId = parsed.channelId;
        messageId = parsed.messageId;
      }
      if (!guildId || !channelId || !messageId) {
        throw new Error(
          "Discord message fetch requires guildId, channelId, and messageId (or a valid messageLink).",
        );
      }
      const message = await discordMessagingActionRuntime.fetchMessageDiscord(
        channelId,
        messageId,
        ctx.withOpts(),
      );
      return jsonResult({
        ok: true,
        message: ctx.normalizeMessage(message),
        guildId,
        channelId,
        messageId,
      });
    }
    case "readMessages": {
      if (!ctx.isActionEnabled("messages")) {
        throw new Error("Discord message reads are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      const query = {
        limit: readNumberParam(ctx.params, "limit"),
        before: readStringParam(ctx.params, "before"),
        after: readStringParam(ctx.params, "after"),
        around: readStringParam(ctx.params, "around"),
      };
      const messages = await discordMessagingActionRuntime.readMessagesDiscord(
        channelId,
        query,
        ctx.withOpts(),
      );
      return jsonResult({
        ok: true,
        messages: messages.map((message) => ctx.normalizeMessage(message)),
      });
    }
    case "editMessage": {
      if (!ctx.isActionEnabled("messages")) {
        throw new Error("Discord message edits are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      const messageId = readStringParam(ctx.params, "messageId", {
        required: true,
      });
      const content = readStringParam(ctx.params, "content", {
        required: true,
      });
      const message = await discordMessagingActionRuntime.editMessageDiscord(
        channelId,
        messageId,
        { content },
        ctx.withOpts(),
      );
      return jsonResult({ ok: true, message });
    }
    case "deleteMessage": {
      if (!ctx.isActionEnabled("messages")) {
        throw new Error("Discord message deletes are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      const messageId = readStringParam(ctx.params, "messageId", {
        required: true,
      });
      await discordMessagingActionRuntime.deleteMessageDiscord(
        channelId,
        messageId,
        ctx.withOpts(),
      );
      return jsonResult({ ok: true });
    }
    case "pinMessage": {
      if (!ctx.isActionEnabled("pins")) {
        throw new Error("Discord pins are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      const messageId = readStringParam(ctx.params, "messageId", {
        required: true,
      });
      await discordMessagingActionRuntime.pinMessageDiscord(channelId, messageId, ctx.withOpts());
      return jsonResult({ ok: true });
    }
    case "unpinMessage": {
      if (!ctx.isActionEnabled("pins")) {
        throw new Error("Discord pins are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      const messageId = readStringParam(ctx.params, "messageId", {
        required: true,
      });
      await discordMessagingActionRuntime.unpinMessageDiscord(channelId, messageId, ctx.withOpts());
      return jsonResult({ ok: true });
    }
    case "listPins": {
      if (!ctx.isActionEnabled("pins")) {
        throw new Error("Discord pins are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      const pins = await discordMessagingActionRuntime.listPinsDiscord(channelId, ctx.withOpts());
      return jsonResult({ ok: true, pins: pins.map((pin) => ctx.normalizeMessage(pin)) });
    }
    case "searchMessages": {
      if (!ctx.isActionEnabled("search")) {
        throw new Error("Discord search is disabled.");
      }
      const guildId = readStringParam(ctx.params, "guildId", {
        required: true,
      });
      const content = readStringParam(ctx.params, "content", {
        required: true,
      });
      const channelId = readStringParam(ctx.params, "channelId");
      const channelIds = readStringArrayParam(ctx.params, "channelIds");
      const authorId = readStringParam(ctx.params, "authorId");
      const authorIds = readStringArrayParam(ctx.params, "authorIds");
      const limit = readNumberParam(ctx.params, "limit");
      const channelIdList = [...(channelIds ?? []), ...(channelId ? [channelId] : [])];
      const authorIdList = [...(authorIds ?? []), ...(authorId ? [authorId] : [])];
      const results = await discordMessagingActionRuntime.searchMessagesDiscord(
        {
          guildId,
          content,
          channelIds: channelIdList.length ? channelIdList : undefined,
          authorIds: authorIdList.length ? authorIdList : undefined,
          limit,
        },
        ctx.withOpts(),
      );
      if (!results || typeof results !== "object") {
        return jsonResult({ ok: true, results });
      }
      const resultsRecord = results as Record<string, unknown>;
      const messages = resultsRecord.messages;
      const normalizedMessages = Array.isArray(messages)
        ? messages.map((group) =>
            Array.isArray(group) ? group.map((msg) => ctx.normalizeMessage(msg)) : group,
          )
        : messages;
      return jsonResult({
        ok: true,
        results: {
          ...resultsRecord,
          messages: normalizedMessages,
        },
      });
    }
    default:
      return undefined;
  }
}
