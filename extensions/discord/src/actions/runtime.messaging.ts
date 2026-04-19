import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveDefaultDiscordAccountId } from "../accounts.js";
import { createDiscordRuntimeAccountContext } from "../client.js";
import { readDiscordComponentSpec } from "../components.js";
import {
  assertMediaNotDataUrl,
  type ActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringArrayParam,
  readStringParam,
  resolvePollMaxSelections,
  type DiscordActionConfig,
  type OpenClawConfig,
  withNormalizedTimestamp,
  readBooleanParam,
} from "../runtime-api.js";
import { sendDiscordComponentMessage } from "../send.components.js";
import {
  createThreadDiscord,
  deleteMessageDiscord,
  editMessageDiscord,
  fetchChannelPermissionsDiscord,
  fetchMessageDiscord,
  fetchReactionsDiscord,
  listPinsDiscord,
  listThreadsDiscord,
  pinMessageDiscord,
  reactMessageDiscord,
  readMessagesDiscord,
  removeOwnReactionsDiscord,
  removeReactionDiscord,
  searchMessagesDiscord,
  sendMessageDiscord,
  sendPollDiscord,
  sendStickerDiscord,
  sendVoiceMessageDiscord,
  unpinMessageDiscord,
} from "../send.js";
import type { DiscordSendComponents, DiscordSendEmbeds } from "../send.shared.js";
import { resolveDiscordChannelId } from "../targets.js";

export const discordMessagingActionRuntime = {
  createThreadDiscord,
  deleteMessageDiscord,
  editMessageDiscord,
  fetchChannelPermissionsDiscord,
  fetchMessageDiscord,
  fetchReactionsDiscord,
  listPinsDiscord,
  listThreadsDiscord,
  pinMessageDiscord,
  reactMessageDiscord,
  readDiscordComponentSpec,
  readMessagesDiscord,
  removeOwnReactionsDiscord,
  removeReactionDiscord,
  resolveDiscordChannelId,
  searchMessagesDiscord,
  sendDiscordComponentMessage,
  sendMessageDiscord,
  sendPollDiscord,
  sendStickerDiscord,
  sendVoiceMessageDiscord,
  unpinMessageDiscord,
};

function hasDiscordComponentObjectKeys(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0,
  );
}

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

export async function handleDiscordMessagingAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
  options?: {
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
  },
  cfg?: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const resolveChannelId = () =>
    discordMessagingActionRuntime.resolveDiscordChannelId(
      readStringParam(params, "channelId", {
        required: true,
      }),
    );
  const accountId = readStringParam(params, "accountId");
  const cfgOptions = cfg ? { cfg } : {};
  const reactionRuntimeOptions = cfg
    ? createDiscordRuntimeAccountContext({
        cfg,
        accountId: accountId ?? resolveDefaultDiscordAccountId(cfg),
      })
    : accountId
      ? { accountId }
      : undefined;
  const withReactionRuntimeOptions = (extra?: Record<string, unknown>) => ({
    ...(reactionRuntimeOptions ?? cfgOptions),
    ...extra,
  });
  const normalizeMessage = (message: unknown) => {
    if (!message || typeof message !== "object") {
      return message;
    }
    return withNormalizedTimestamp(
      message as Record<string, unknown>,
      (message as { timestamp?: unknown }).timestamp,
    );
  };
  switch (action) {
    case "react": {
      if (!isActionEnabled("reactions")) {
        throw new Error("Discord reactions are disabled.");
      }
      const channelId = resolveChannelId();
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Discord reaction.",
      });
      if (remove) {
        await discordMessagingActionRuntime.removeReactionDiscord(
          channelId,
          messageId,
          emoji,
          withReactionRuntimeOptions(),
        );
        return jsonResult({ ok: true, removed: emoji });
      }
      if (isEmpty) {
        const removed = await discordMessagingActionRuntime.removeOwnReactionsDiscord(
          channelId,
          messageId,
          withReactionRuntimeOptions(),
        );
        return jsonResult({ ok: true, removed: removed.removed });
      }
      await discordMessagingActionRuntime.reactMessageDiscord(
        channelId,
        messageId,
        emoji,
        withReactionRuntimeOptions(),
      );
      return jsonResult({ ok: true, added: emoji });
    }
    case "reactions": {
      if (!isActionEnabled("reactions")) {
        throw new Error("Discord reactions are disabled.");
      }
      const channelId = resolveChannelId();
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const limit = readNumberParam(params, "limit");
      const reactions = await discordMessagingActionRuntime.fetchReactionsDiscord(
        channelId,
        messageId,
        withReactionRuntimeOptions({ limit }),
      );
      return jsonResult({ ok: true, reactions });
    }
    case "sticker": {
      if (!isActionEnabled("stickers")) {
        throw new Error("Discord stickers are disabled.");
      }
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "content");
      const stickerIds = readStringArrayParam(params, "stickerIds", {
        required: true,
        label: "stickerIds",
      });
      await discordMessagingActionRuntime.sendStickerDiscord(to, stickerIds, {
        ...cfgOptions,
        ...(accountId ? { accountId } : {}),
        content,
      });
      return jsonResult({ ok: true });
    }
    case "poll": {
      if (!isActionEnabled("polls")) {
        throw new Error("Discord polls are disabled.");
      }
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "content");
      const question = readStringParam(params, "question", {
        required: true,
      });
      const answers = readStringArrayParam(params, "answers", {
        required: true,
        label: "answers",
      });
      const allowMultiselect = readBooleanParam(params, "allowMultiselect");
      const durationHours = readNumberParam(params, "durationHours");
      const maxSelections = resolvePollMaxSelections(answers.length, allowMultiselect);
      await discordMessagingActionRuntime.sendPollDiscord(
        to,
        { question, options: answers, maxSelections, durationHours },
        { ...cfgOptions, ...(accountId ? { accountId } : {}), content },
      );
      return jsonResult({ ok: true });
    }
    case "permissions": {
      if (!isActionEnabled("permissions")) {
        throw new Error("Discord permissions are disabled.");
      }
      const channelId = resolveChannelId();
      const permissions = accountId
        ? await discordMessagingActionRuntime.fetchChannelPermissionsDiscord(channelId, {
            ...cfgOptions,
            accountId,
          })
        : await discordMessagingActionRuntime.fetchChannelPermissionsDiscord(channelId, cfgOptions);
      return jsonResult({ ok: true, permissions });
    }
    case "fetchMessage": {
      if (!isActionEnabled("messages")) {
        throw new Error("Discord message reads are disabled.");
      }
      const messageLink = readStringParam(params, "messageLink");
      let guildId = readStringParam(params, "guildId");
      let channelId = readStringParam(params, "channelId");
      let messageId = readStringParam(params, "messageId");
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
      const message = accountId
        ? await discordMessagingActionRuntime.fetchMessageDiscord(channelId, messageId, {
            ...cfgOptions,
            accountId,
          })
        : await discordMessagingActionRuntime.fetchMessageDiscord(channelId, messageId, cfgOptions);
      return jsonResult({
        ok: true,
        message: normalizeMessage(message),
        guildId,
        channelId,
        messageId,
      });
    }
    case "readMessages": {
      if (!isActionEnabled("messages")) {
        throw new Error("Discord message reads are disabled.");
      }
      const channelId = resolveChannelId();
      const query = {
        limit: readNumberParam(params, "limit"),
        before: readStringParam(params, "before"),
        after: readStringParam(params, "after"),
        around: readStringParam(params, "around"),
      };
      const messages = accountId
        ? await discordMessagingActionRuntime.readMessagesDiscord(channelId, query, {
            ...cfgOptions,
            accountId,
          })
        : await discordMessagingActionRuntime.readMessagesDiscord(channelId, query, cfgOptions);
      return jsonResult({
        ok: true,
        messages: messages.map((message) => normalizeMessage(message)),
      });
    }
    case "sendMessage": {
      if (!isActionEnabled("messages")) {
        throw new Error("Discord message sends are disabled.");
      }
      const to = readStringParam(params, "to", { required: true });
      const asVoice = params.asVoice === true;
      const silent = params.silent === true;
      const rawComponents = params.components;
      const componentSpec = hasDiscordComponentObjectKeys(rawComponents)
        ? discordMessagingActionRuntime.readDiscordComponentSpec(rawComponents)
        : null;
      const components: DiscordSendComponents | undefined =
        Array.isArray(rawComponents) || typeof rawComponents === "function"
          ? (rawComponents as DiscordSendComponents)
          : undefined;
      const content = readStringParam(params, "content", {
        required: !asVoice && !componentSpec && !components,
        allowEmpty: true,
      });
      const mediaUrl =
        readStringParam(params, "mediaUrl", { trim: false }) ??
        readStringParam(params, "path", { trim: false }) ??
        readStringParam(params, "filePath", { trim: false });
      const filename = readStringParam(params, "filename");
      const replyTo = readStringParam(params, "replyTo");
      const rawEmbeds = params.embeds;
      const embeds: DiscordSendEmbeds | undefined = Array.isArray(rawEmbeds)
        ? (rawEmbeds as DiscordSendEmbeds)
        : undefined;
      const sessionKey = readStringParam(params, "__sessionKey");
      const agentId = readStringParam(params, "__agentId");

      if (componentSpec) {
        if (asVoice) {
          throw new Error("Discord components cannot be sent as voice messages.");
        }
        if (embeds?.length) {
          throw new Error("Discord components cannot include embeds.");
        }
        const normalizedContent = content?.trim() ? content : undefined;
        const payload = componentSpec.text
          ? componentSpec
          : { ...componentSpec, text: normalizedContent };
        const result = await discordMessagingActionRuntime.sendDiscordComponentMessage(
          to,
          payload,
          {
            ...cfgOptions,
            ...(accountId ? { accountId } : {}),
            silent,
            replyTo: replyTo ?? undefined,
            sessionKey: sessionKey ?? undefined,
            agentId: agentId ?? undefined,
            mediaUrl: mediaUrl ?? undefined,
            filename: filename ?? undefined,
          },
        );
        return jsonResult({ ok: true, result, components: true });
      }

      // Handle voice message sending
      if (asVoice) {
        if (!mediaUrl) {
          throw new Error(
            "Voice messages require a media file reference (mediaUrl, path, or filePath).",
          );
        }
        if (content && content.trim()) {
          throw new Error(
            "Voice messages cannot include text content (Discord limitation). Remove the content parameter.",
          );
        }
        assertMediaNotDataUrl(mediaUrl);
        const result = await discordMessagingActionRuntime.sendVoiceMessageDiscord(to, mediaUrl, {
          ...cfgOptions,
          ...(accountId ? { accountId } : {}),
          replyTo,
          silent,
        });
        return jsonResult({ ok: true, result, voiceMessage: true });
      }

      const result = await discordMessagingActionRuntime.sendMessageDiscord(to, content ?? "", {
        ...cfgOptions,
        ...(accountId ? { accountId } : {}),
        mediaUrl,
        filename: filename ?? undefined,
        mediaLocalRoots: options?.mediaLocalRoots,
        mediaReadFile: options?.mediaReadFile,
        replyTo,
        components,
        embeds,
        silent,
      });
      return jsonResult({ ok: true, result });
    }
    case "editMessage": {
      if (!isActionEnabled("messages")) {
        throw new Error("Discord message edits are disabled.");
      }
      const channelId = resolveChannelId();
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const content = readStringParam(params, "content", {
        required: true,
      });
      const message = accountId
        ? await discordMessagingActionRuntime.editMessageDiscord(
            channelId,
            messageId,
            { content },
            { ...cfgOptions, accountId },
          )
        : await discordMessagingActionRuntime.editMessageDiscord(
            channelId,
            messageId,
            { content },
            cfgOptions,
          );
      return jsonResult({ ok: true, message });
    }
    case "deleteMessage": {
      if (!isActionEnabled("messages")) {
        throw new Error("Discord message deletes are disabled.");
      }
      const channelId = resolveChannelId();
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      if (accountId) {
        await discordMessagingActionRuntime.deleteMessageDiscord(channelId, messageId, {
          ...cfgOptions,
          accountId,
        });
      } else {
        await discordMessagingActionRuntime.deleteMessageDiscord(channelId, messageId, cfgOptions);
      }
      return jsonResult({ ok: true });
    }
    case "threadCreate": {
      if (!isActionEnabled("threads")) {
        throw new Error("Discord threads are disabled.");
      }
      const channelId = resolveChannelId();
      const name = readStringParam(params, "name", { required: true });
      const messageId = readStringParam(params, "messageId");
      const content = readStringParam(params, "content");
      const autoArchiveMinutes = readNumberParam(params, "autoArchiveMinutes");
      const appliedTags = readStringArrayParam(params, "appliedTags");
      const payload = {
        name,
        messageId,
        autoArchiveMinutes,
        content,
        appliedTags: appliedTags ?? undefined,
      };
      const thread = accountId
        ? await discordMessagingActionRuntime.createThreadDiscord(channelId, payload, {
            ...cfgOptions,
            accountId,
          })
        : await discordMessagingActionRuntime.createThreadDiscord(channelId, payload, cfgOptions);
      return jsonResult({ ok: true, thread });
    }
    case "threadList": {
      if (!isActionEnabled("threads")) {
        throw new Error("Discord threads are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const channelId = readStringParam(params, "channelId");
      const includeArchived = readBooleanParam(params, "includeArchived");
      const before = readStringParam(params, "before");
      const limit = readNumberParam(params, "limit");
      const threads = accountId
        ? await discordMessagingActionRuntime.listThreadsDiscord(
            {
              guildId,
              channelId,
              includeArchived,
              before,
              limit,
            },
            { ...cfgOptions, accountId },
          )
        : await discordMessagingActionRuntime.listThreadsDiscord(
            {
              guildId,
              channelId,
              includeArchived,
              before,
              limit,
            },
            cfgOptions,
          );
      return jsonResult({ ok: true, threads });
    }
    case "threadReply": {
      if (!isActionEnabled("threads")) {
        throw new Error("Discord threads are disabled.");
      }
      const channelId = resolveChannelId();
      const content = readStringParam(params, "content", {
        required: true,
      });
      const mediaUrl = readStringParam(params, "mediaUrl");
      const replyTo = readStringParam(params, "replyTo");
      const result = await discordMessagingActionRuntime.sendMessageDiscord(
        `channel:${channelId}`,
        content,
        {
          ...cfgOptions,
          ...(accountId ? { accountId } : {}),
          mediaUrl,
          mediaLocalRoots: options?.mediaLocalRoots,
          mediaReadFile: options?.mediaReadFile,
          replyTo,
        },
      );
      return jsonResult({ ok: true, result });
    }
    case "pinMessage": {
      if (!isActionEnabled("pins")) {
        throw new Error("Discord pins are disabled.");
      }
      const channelId = resolveChannelId();
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      if (accountId) {
        await discordMessagingActionRuntime.pinMessageDiscord(channelId, messageId, {
          ...cfgOptions,
          accountId,
        });
      } else {
        await discordMessagingActionRuntime.pinMessageDiscord(channelId, messageId, cfgOptions);
      }
      return jsonResult({ ok: true });
    }
    case "unpinMessage": {
      if (!isActionEnabled("pins")) {
        throw new Error("Discord pins are disabled.");
      }
      const channelId = resolveChannelId();
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      if (accountId) {
        await discordMessagingActionRuntime.unpinMessageDiscord(channelId, messageId, {
          ...cfgOptions,
          accountId,
        });
      } else {
        await discordMessagingActionRuntime.unpinMessageDiscord(channelId, messageId, cfgOptions);
      }
      return jsonResult({ ok: true });
    }
    case "listPins": {
      if (!isActionEnabled("pins")) {
        throw new Error("Discord pins are disabled.");
      }
      const channelId = resolveChannelId();
      const pins = accountId
        ? await discordMessagingActionRuntime.listPinsDiscord(channelId, {
            ...cfgOptions,
            accountId,
          })
        : await discordMessagingActionRuntime.listPinsDiscord(channelId, cfgOptions);
      return jsonResult({ ok: true, pins: pins.map((pin) => normalizeMessage(pin)) });
    }
    case "searchMessages": {
      if (!isActionEnabled("search")) {
        throw new Error("Discord search is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const content = readStringParam(params, "content", {
        required: true,
      });
      const channelId = readStringParam(params, "channelId");
      const channelIds = readStringArrayParam(params, "channelIds");
      const authorId = readStringParam(params, "authorId");
      const authorIds = readStringArrayParam(params, "authorIds");
      const limit = readNumberParam(params, "limit");
      const channelIdList = [...(channelIds ?? []), ...(channelId ? [channelId] : [])];
      const authorIdList = [...(authorIds ?? []), ...(authorId ? [authorId] : [])];
      const results = accountId
        ? await discordMessagingActionRuntime.searchMessagesDiscord(
            {
              guildId,
              content,
              channelIds: channelIdList.length ? channelIdList : undefined,
              authorIds: authorIdList.length ? authorIdList : undefined,
              limit,
            },
            { ...cfgOptions, accountId },
          )
        : await discordMessagingActionRuntime.searchMessagesDiscord(
            {
              guildId,
              content,
              channelIds: channelIdList.length ? channelIdList : undefined,
              authorIds: authorIdList.length ? authorIdList : undefined,
              limit,
            },
            cfgOptions,
          );
      if (!results || typeof results !== "object") {
        return jsonResult({ ok: true, results });
      }
      const resultsRecord = results as Record<string, unknown>;
      const messages = resultsRecord.messages;
      const normalizedMessages = Array.isArray(messages)
        ? messages.map((group) =>
            Array.isArray(group) ? group.map((msg) => normalizeMessage(msg)) : group,
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
      throw new Error(`Unknown action: ${action}`);
  }
}
