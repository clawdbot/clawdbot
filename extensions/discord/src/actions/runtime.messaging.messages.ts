// Discord plugin module implements runtime.messaging.messages behavior.
import {
  jsonResult,
  readPositiveIntegerParam,
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

function describeDiscordMessageListResult(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).toSorted();
    return keys.length ? `object with keys ${keys.join(", ")}` : "object";
  }
  return typeof value;
}

function assertDiscordMessageListResult(value: unknown): Array<unknown> {
  if (Array.isArray(value)) {
    return value;
  }
  throw new Error(
    `Discord message read returned ${describeDiscordMessageListResult(value)} instead of an array.`,
  );
}

export async function handleDiscordMessageManagementAction(ctx: DiscordMessagingActionContext) {
  switch (ctx.action) {
    case "permissions": {
      if (!ctx.isActionEnabled("permissions")) {
        throw new Error("Discord permissions are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      await ctx.assertReadTargetAllowed({ channelId });
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
      await ctx.assertReadTargetAllowed({ guildId, channelId });
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
      await ctx.assertReadTargetAllowed({ channelId });
      const query = {
        limit: readPositiveIntegerParam(ctx.params, "limit"),
        before: readStringParam(ctx.params, "before"),
        after: readStringParam(ctx.params, "after"),
        around: readStringParam(ctx.params, "around"),
      };
      const messages = assertDiscordMessageListResult(
        await discordMessagingActionRuntime.readMessagesDiscord(channelId, query, ctx.withOpts()),
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
      await ctx.assertReadTargetAllowed({ channelId });
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
      await ctx.assertReadTargetAllowed({ channelId });
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
      await ctx.assertReadTargetAllowed({ channelId });
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
      await ctx.assertReadTargetAllowed({ channelId });
      await discordMessagingActionRuntime.unpinMessageDiscord(channelId, messageId, ctx.withOpts());
      return jsonResult({ ok: true });
    }
    case "listPins": {
      if (!ctx.isActionEnabled("pins")) {
        throw new Error("Discord pins are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      await ctx.assertReadTargetAllowed({ channelId });
      const pins = await discordMessagingActionRuntime.listPinsDiscord(channelId, ctx.withOpts());
      return jsonResult({ ok: true, pins: pins.map((pin) => ctx.normalizeMessage(pin)) });
    }
    case "searchMessages": {
      if (!ctx.isActionEnabled("search")) {
        throw new Error("Discord search is disabled.");
      }
      let guildId = readStringParam(ctx.params, "guildId");
      const content =
        readStringParam(ctx.params, "content") ?? readStringParam(ctx.params, "query");
      if (!content) {
        throw new Error("Discord search requires content or query text.");
      }
      const channelId = readStringParam(ctx.params, "channelId");
      const channelIds = readStringArrayParam(ctx.params, "channelIds");
      // Resolve guildId from channel info when not explicitly provided.
      if (!guildId) {
        const rawInferChannelId = channelId ?? channelIds?.[0];
        if (rawInferChannelId) {
          try {
            const inferChannelId =
              discordMessagingActionRuntime.resolveDiscordChannelId(rawInferChannelId);
            const channelInfo = await discordMessagingActionRuntime.fetchChannelInfoDiscord(
              inferChannelId,
              ctx.withOpts(),
            );
            if (channelInfo && typeof channelInfo === "object") {
              const record = channelInfo as unknown as Record<string, unknown>;
              const resolved = record.guild_id ?? record.guildId;
              if (typeof resolved === "string" && resolved.trim()) {
                guildId = resolved.trim();
              }
            }
          } catch {
            // Channel info fetch failed; fall through to descriptive error.
          }
        }
      }
      if (!guildId) {
        throw new Error(
          "Discord search requires guildId. Provide guildId explicitly, or provide channelId so the guild can be resolved from the channel.",
        );
      }
      const authorId = readStringParam(ctx.params, "authorId");
      const authorIds = readStringArrayParam(ctx.params, "authorIds");
      const limit = readPositiveIntegerParam(ctx.params, "limit");
      const channelIdList = [
        ...(channelIds ?? []).map((id) =>
          discordMessagingActionRuntime.resolveDiscordChannelId(id),
        ),
        ...(channelId ? [discordMessagingActionRuntime.resolveDiscordChannelId(channelId)] : []),
      ];
      if (channelIdList.length > 0) {
        for (const targetChannelId of channelIdList) {
          await ctx.assertReadTargetAllowed({ guildId, channelId: targetChannelId });
        }
      } else {
        await ctx.assertGuildReadTargetAllowed({ guildId });
      }
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
      const messages = results.messages;
      const normalizedMessages = Array.isArray(messages)
        ? messages.map((group) =>
            Array.isArray(group) ? group.map((msg) => ctx.normalizeMessage(msg)) : group,
          )
        : messages;
      return jsonResult({
        ok: true,
        results: {
          ...results,
          messages: normalizedMessages,
        },
      });
    }
    default:
      return undefined;
  }
}
