// Discord plugin module implements runtime.messaging.send behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createReusableDiscordReplyReference } from "../reply-reference.js";
import {
  assertMediaNotDataUrl,
  jsonResult,
  readBooleanParam,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
  resolvePollMaxSelections,
} from "../runtime-api.js";
import { DiscordThreadInitialMessageError } from "../send.js";
import { isThreadChannelType } from "../send.permissions.js";
import type { DiscordSendComponents, DiscordSendEmbeds } from "../send.shared.js";
import { discordMessagingActionRuntime } from "./runtime.messaging.runtime.js";
import type { DiscordMessagingActionContext } from "./runtime.messaging.shared.js";
import { readDiscordAutoArchiveDurationParam } from "./runtime.shared.js";

function hasDiscordComponentObjectKeys(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0,
  );
}

function readDiscordThreadArchiveTimestamp(thread: unknown): string | undefined {
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
    return undefined;
  }
  const record = thread as Record<string, unknown>;
  const metadata = record.thread_metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const archiveTimestamp = (metadata as Record<string, unknown>).archive_timestamp;
    if (typeof archiveTimestamp === "string" && archiveTimestamp.trim()) {
      return archiveTimestamp;
    }
  }
  return undefined;
}

type DiscordThreadListActionResult = {
  ok: true;
  threads: unknown;
  complete: boolean;
  hasMore: boolean;
  returnedCount: number;
  source: "discord.threadList.archived" | "discord.threadList.active";
  query: {
    guildId: string;
    channelId?: string;
    includeArchived: boolean;
    before?: string;
    limit?: number;
  };
  nextBefore?: string;
};

function normalizeDiscordThreadListActionResult(params: {
  value: unknown;
  includeArchived: boolean;
  channelId?: string;
  guildId: string;
  limit?: number;
  before?: string;
}): DiscordThreadListActionResult {
  const record =
    params.value && typeof params.value === "object" && !Array.isArray(params.value)
      ? (params.value as Record<string, unknown>)
      : undefined;
  const threadItems = Array.isArray(record?.threads) ? record.threads : [];
  const hasMore = record?.has_more === true;
  const nextBefore =
    params.includeArchived && hasMore
      ? readDiscordThreadArchiveTimestamp(threadItems[threadItems.length - 1])
      : undefined;

  return {
    ok: true,
    threads: params.value,
    complete: !hasMore,
    hasMore,
    returnedCount: threadItems.length,
    source: params.includeArchived ? "discord.threadList.archived" : "discord.threadList.active",
    query: {
      guildId: params.guildId,
      ...(params.channelId ? { channelId: params.channelId } : {}),
      includeArchived: params.includeArchived,
      ...(params.before ? { before: params.before } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    },
    ...(nextBefore ? { nextBefore } : {}),
  };
}

async function appendDiscordThreadRenameResult(
  ctx: DiscordMessagingActionContext,
  params: {
    payload: Record<string, unknown>;
    target: string;
    threadName?: string;
  },
) {
  const threadName = params.threadName?.trim();
  if (!threadName) {
    return params.payload;
  }
  if (!ctx.isActionEnabled("channels")) {
    return {
      ...params.payload,
      warning: "Discord threadName was ignored because Discord channel management is disabled.",
    };
  }

  let channelId: string;
  try {
    channelId = discordMessagingActionRuntime.resolveDiscordChannelId(params.target);
  } catch {
    return {
      ...params.payload,
      warning: "Discord threadName was ignored because the send target is not a channel/thread.",
    };
  }

  try {
    const channel = await discordMessagingActionRuntime.fetchChannelInfoDiscord(
      channelId,
      ctx.withOpts(),
    );
    if (!isThreadChannelType(channel.type)) {
      return {
        ...params.payload,
        warning: "Discord threadName was ignored because the send target is not a thread.",
      };
    }
    const renamed = await discordMessagingActionRuntime.editChannelDiscord(
      {
        channelId,
        name: threadName,
      },
      ctx.withOpts(),
    );
    return {
      ...params.payload,
      threadRename: {
        ok: true,
        channelId,
        name: renamed.name ?? threadName,
      },
    };
  } catch (error) {
    return {
      ...params.payload,
      warning: `Discord message was sent, but thread rename failed: ${formatErrorMessage(error)}`,
    };
  }
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
      const durationHours = readPositiveIntegerParam(ctx.params, "durationHours");
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
      const suppressEmbeds =
        ctx.params.suppressEmbeds === undefined ? undefined : ctx.params.suppressEmbeds === true;
      const rawComponents = ctx.params.components;
      const componentSpec = hasDiscordComponentObjectKeys(rawComponents)
        ? discordMessagingActionRuntime.readDiscordComponentSpec(rawComponents)
        : null;
      const components: DiscordSendComponents | undefined =
        Array.isArray(rawComponents) || typeof rawComponents === "function"
          ? (rawComponents as DiscordSendComponents)
          : undefined;
      const mediaUrl =
        readStringParam(ctx.params, "mediaUrl", { trim: false }) ??
        readStringParam(ctx.params, "path", { trim: false }) ??
        readStringParam(ctx.params, "filePath", { trim: false });
      const content = readStringParam(ctx.params, "content", {
        required: !asVoice && !componentSpec && !components && !mediaUrl,
        allowEmpty: true,
      });
      const filename = readStringParam(ctx.params, "filename");
      const replyTo = readStringParam(ctx.params, "replyTo");
      const threadName = readStringParam(ctx.params, "threadName");
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
            reply: createReusableDiscordReplyReference(replyTo),
            sessionKey: sessionKey ?? undefined,
            agentId: agentId ?? undefined,
            mediaUrl: mediaUrl ?? undefined,
            filename: filename ?? undefined,
            mediaAccess: ctx.options?.mediaAccess,
            mediaLocalRoots: ctx.options?.mediaLocalRoots,
            mediaReadFile: ctx.options?.mediaReadFile,
            ...(suppressEmbeds === undefined ? {} : { suppressEmbeds }),
          },
        );
        return jsonResult(
          await appendDiscordThreadRenameResult(ctx, {
            payload: { ok: true, result, components: true },
            target: to,
            threadName,
          }),
        );
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
          reply: createReusableDiscordReplyReference(replyTo),
          silent,
        });
        return jsonResult(
          await appendDiscordThreadRenameResult(ctx, {
            payload: { ok: true, result, voiceMessage: true },
            target: to,
            threadName,
          }),
        );
      }

      const result = await discordMessagingActionRuntime.sendMessageDiscord(to, content ?? "", {
        ...ctx.withOpts(),
        mediaAccess: ctx.options?.mediaAccess,
        mediaUrl,
        filename: filename ?? undefined,
        mediaLocalRoots: ctx.options?.mediaLocalRoots,
        mediaReadFile: ctx.options?.mediaReadFile,
        reply: createReusableDiscordReplyReference(replyTo),
        components,
        embeds,
        silent,
        ...(suppressEmbeds === undefined ? {} : { suppressEmbeds }),
      });
      return jsonResult(
        await appendDiscordThreadRenameResult(ctx, {
          payload: { ok: true, result },
          target: to,
          threadName,
        }),
      );
    }
    case "threadCreate": {
      if (!ctx.isActionEnabled("threads")) {
        throw new Error("Discord threads are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      const name = readStringParam(ctx.params, "name", { required: true });
      const messageId = readStringParam(ctx.params, "messageId");
      const content = readStringParam(ctx.params, "content");
      const autoArchiveMinutes = readDiscordAutoArchiveDurationParam(
        ctx.params,
        "autoArchiveMinutes",
      );
      const appliedTags = readStringArrayParam(ctx.params, "appliedTags");
      const payload = {
        name,
        messageId,
        autoArchiveMinutes,
        content,
        appliedTags: appliedTags ?? undefined,
      };
      try {
        const thread = await discordMessagingActionRuntime.createThreadDiscord(
          channelId,
          payload,
          ctx.withOpts(),
        );
        return jsonResult({ ok: true, thread });
      } catch (error) {
        if (error instanceof DiscordThreadInitialMessageError) {
          return jsonResult({
            ok: true,
            partial: true,
            thread: error.thread,
            warning: "Discord thread was created, but sending the initial message failed.",
            initialMessageError: error.initialMessageError,
          });
        }
        throw error;
      }
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
      const limit = readPositiveIntegerParam(ctx.params, "limit");
      if (channelId && includeArchived === true) {
        await ctx.assertReadTargetAllowed({ guildId, channelId });
      } else {
        await ctx.assertGuildReadTargetAllowed({
          guildId,
          channelTargetRequiredMessage:
            "Discord active thread lists require a wildcard channel allowlist so each read target can be authorized.",
        });
      }
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
      return jsonResult(
        normalizeDiscordThreadListActionResult({
          value: threads,
          guildId,
          channelId,
          includeArchived: includeArchived === true,
          before,
          limit,
        }),
      );
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
          reply: createReusableDiscordReplyReference(replyTo),
        },
      );
      return jsonResult({ ok: true, result });
    }
    default:
      return undefined;
  }
}
