import {
  assertMediaNotDataUrl,
  jsonResult,
  readBooleanParam,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
  resolvePollMaxSelections,
} from "../runtime-api.js";
import type { DiscordSendComponents, DiscordSendEmbeds } from "../send.shared.js";
import { discordMessagingActionRuntime } from "./runtime.messaging.runtime.js";
import type { DiscordMessagingActionContext } from "./runtime.messaging.shared.js";

function hasDiscordComponentObjectKeys(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0,
  );
}

export async function handleDiscordMessageSendAction(ctx: DiscordMessagingActionContext) {
  switch (ctx.action) {
    case "sticker": {
      if (!ctx.isActionEnabled("stickers")) {
        throw new Error("Discord stickers are disabled.");
      }
      const to = readStringParam(ctx.params, "to", { required: true });
      const content = readStringParam(ctx.params, "content");
      const stickerIds = readStringArrayParam(ctx.params, "stickerIds", {
        required: true,
        label: "stickerIds",
      });
      await discordMessagingActionRuntime.sendStickerDiscord(
        to,
        stickerIds,
        ctx.withOpts({ content }),
      );
      return jsonResult({ ok: true });
    }
    case "poll": {
      if (!ctx.isActionEnabled("polls")) {
        throw new Error("Discord polls are disabled.");
      }
      const to = readStringParam(ctx.params, "to", { required: true });
      const content = readStringParam(ctx.params, "content");
      const question = readStringParam(ctx.params, "question", {
        required: true,
      });
      const answers = readStringArrayParam(ctx.params, "answers", {
        required: true,
        label: "answers",
      });
      const allowMultiselect = readBooleanParam(ctx.params, "allowMultiselect");
      const durationHours = readNumberParam(ctx.params, "durationHours");
      const maxSelections = resolvePollMaxSelections(answers.length, allowMultiselect);
      await discordMessagingActionRuntime.sendPollDiscord(
        to,
        { question, options: answers, maxSelections, durationHours },
        ctx.withOpts({ content }),
      );
      return jsonResult({ ok: true });
    }
    case "sendMessage": {
      if (!ctx.isActionEnabled("messages")) {
        throw new Error("Discord message sends are disabled.");
      }
      const to = readStringParam(ctx.params, "to", { required: true });
      const asVoice = ctx.params.asVoice === true;
      const silent = ctx.params.silent === true;
      const rawComponents = ctx.params.components;
      const componentSpec = hasDiscordComponentObjectKeys(rawComponents)
        ? discordMessagingActionRuntime.readDiscordComponentSpec(rawComponents)
        : null;
      const components: DiscordSendComponents | undefined =
        Array.isArray(rawComponents) || typeof rawComponents === "function"
          ? (rawComponents as DiscordSendComponents)
          : undefined;
      const content = readStringParam(ctx.params, "content", {
        required: !asVoice && !componentSpec && !components,
        allowEmpty: true,
      });
      const mediaUrl =
        readStringParam(ctx.params, "mediaUrl", { trim: false }) ??
        readStringParam(ctx.params, "path", { trim: false }) ??
        readStringParam(ctx.params, "filePath", { trim: false });
      const filename = readStringParam(ctx.params, "filename");
      const replyTo = readStringParam(ctx.params, "replyTo");
      const rawEmbeds = ctx.params.embeds;
      const embeds: DiscordSendEmbeds | undefined = Array.isArray(rawEmbeds)
        ? (rawEmbeds as DiscordSendEmbeds)
        : undefined;
      const sessionKey = readStringParam(ctx.params, "__sessionKey");
      const agentId = readStringParam(ctx.params, "__agentId");

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
            ...ctx.withOpts(),
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
          ...ctx.withOpts(),
          replyTo,
          silent,
        });
        return jsonResult({ ok: true, result, voiceMessage: true });
      }

      const result = await discordMessagingActionRuntime.sendMessageDiscord(to, content ?? "", {
        ...ctx.withOpts(),
        mediaUrl,
        filename: filename ?? undefined,
        mediaLocalRoots: ctx.options?.mediaLocalRoots,
        mediaReadFile: ctx.options?.mediaReadFile,
        replyTo,
        components,
        embeds,
        silent,
      });
      return jsonResult({ ok: true, result });
    }
    case "threadCreate": {
      if (!ctx.isActionEnabled("threads")) {
        throw new Error("Discord threads are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      const name = readStringParam(ctx.params, "name", { required: true });
      const messageId = readStringParam(ctx.params, "messageId");
      const content = readStringParam(ctx.params, "content");
      const autoArchiveMinutes = readNumberParam(ctx.params, "autoArchiveMinutes");
      const appliedTags = readStringArrayParam(ctx.params, "appliedTags");
      const payload = {
        name,
        messageId,
        autoArchiveMinutes,
        content,
        appliedTags: appliedTags ?? undefined,
      };
      const thread = await discordMessagingActionRuntime.createThreadDiscord(
        channelId,
        payload,
        ctx.withOpts(),
      );
      return jsonResult({ ok: true, thread });
    }
    case "threadList": {
      if (!ctx.isActionEnabled("threads")) {
        throw new Error("Discord threads are disabled.");
      }
      const guildId = readStringParam(ctx.params, "guildId", {
        required: true,
      });
      const channelId = readStringParam(ctx.params, "channelId");
      const includeArchived = readBooleanParam(ctx.params, "includeArchived");
      const before = readStringParam(ctx.params, "before");
      const limit = readNumberParam(ctx.params, "limit");
      const threads = await discordMessagingActionRuntime.listThreadsDiscord(
        {
          guildId,
          channelId,
          includeArchived,
          before,
          limit,
        },
        ctx.withOpts(),
      );
      return jsonResult({ ok: true, threads });
    }
    case "threadReply": {
      if (!ctx.isActionEnabled("threads")) {
        throw new Error("Discord threads are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      const content = readStringParam(ctx.params, "content", {
        required: true,
      });
      const mediaUrl = readStringParam(ctx.params, "mediaUrl");
      const replyTo = readStringParam(ctx.params, "replyTo");
      const result = await discordMessagingActionRuntime.sendMessageDiscord(
        `channel:${channelId}`,
        content,
        {
          ...ctx.withOpts(),
          mediaUrl,
          mediaLocalRoots: ctx.options?.mediaLocalRoots,
          mediaReadFile: ctx.options?.mediaReadFile,
          replyTo,
        },
      );
      return jsonResult({ ok: true, result });
    }
    default:
      return undefined;
  }
}
