import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  parseAvailableTags,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/agent-runtime";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { handleDiscordAction } from "../../action-runtime-api.js";
import {
  isDiscordModerationAction,
  readDiscordModerationCommand,
} from "./runtime.moderation-shared.js";

type Ctx = Pick<
  ChannelMessageActionContext,
  "action" | "params" | "cfg" | "accountId" | "requesterSenderId" | "mediaLocalRoots"
>;

export async function tryHandleDiscordMessageActionGuildAdmin(params: {
  ctx: Ctx;
  resolveChannelId: () => string;
  readParentIdParam: (params: Record<string, unknown>) => string | null | undefined;
}): Promise<AgentToolResult<unknown> | undefined> {
  const { ctx, resolveChannelId, readParentIdParam } = params;
  const { action, params: actionParams, cfg } = ctx;
  const accountId = ctx.accountId ?? readStringParam(actionParams, "accountId");

  if (action === "member-info") {
    const userId = readStringParam(actionParams, "userId", { required: true });
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    return await handleDiscordAction(
      { action: "memberInfo", accountId: accountId ?? undefined, guildId, userId },
      cfg,
    );
  }

  if (action === "role-info") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    return await handleDiscordAction(
      { action: "roleInfo", accountId: accountId ?? undefined, guildId },
      cfg,
    );
  }

  if (action === "emoji-list") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    return await handleDiscordAction(
      { action: "emojiList", accountId: accountId ?? undefined, guildId },
      cfg,
    );
  }

  if (action === "emoji-upload") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const name = readStringParam(actionParams, "emojiName", { required: true });
    const mediaUrl = readStringParam(actionParams, "media", {
      required: true,
      trim: false,
    });
    const roleIds = readStringArrayParam(actionParams, "roleIds");
    return await handleDiscordAction(
      {
        action: "emojiUpload",
        accountId: accountId ?? undefined,
        guildId,
        name,
        mediaUrl,
        roleIds,
      },
      cfg,
    );
  }

  if (action === "sticker-upload") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const name = readStringParam(actionParams, "stickerName", {
      required: true,
    });
    const description = readStringParam(actionParams, "stickerDesc", {
      required: true,
    });
    const tags = readStringParam(actionParams, "stickerTags", {
      required: true,
    });
    const mediaUrl = readStringParam(actionParams, "media", {
      required: true,
      trim: false,
    });
    return await handleDiscordAction(
      {
        action: "stickerUpload",
        accountId: accountId ?? undefined,
        guildId,
        name,
        description,
        tags,
        mediaUrl,
      },
      cfg,
    );
  }

  if (action === "role-add" || action === "role-remove") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const userId = readStringParam(actionParams, "userId", { required: true });
    const roleId = readStringParam(actionParams, "roleId", { required: true });
    return await handleDiscordAction(
      {
        action: action === "role-add" ? "roleAdd" : "roleRemove",
        accountId: accountId ?? undefined,
        guildId,
        userId,
        roleId,
      },
      cfg,
    );
  }

  if (action === "channel-info") {
    const channelId = readStringParam(actionParams, "channelId", {
      required: true,
    });
    return await handleDiscordAction(
      { action: "channelInfo", accountId: accountId ?? undefined, channelId },
      cfg,
    );
  }

  if (action === "channel-list") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    return await handleDiscordAction(
      { action: "channelList", accountId: accountId ?? undefined, guildId },
      cfg,
    );
  }

  if (action === "channel-create") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const name = readStringParam(actionParams, "name", { required: true });
    const type = readNumberParam(actionParams, "type", { integer: true });
    const parentId = readParentIdParam(actionParams);
    const topic = readStringParam(actionParams, "topic");
    const position = readNumberParam(actionParams, "position", {
      integer: true,
    });
    const nsfw = typeof actionParams.nsfw === "boolean" ? actionParams.nsfw : undefined;
    return await handleDiscordAction(
      {
        action: "channelCreate",
        accountId: accountId ?? undefined,
        guildId,
        name,
        type: type ?? undefined,
        parentId: parentId ?? undefined,
        topic: topic ?? undefined,
        position: position ?? undefined,
        nsfw,
      },
      cfg,
    );
  }

  if (action === "channel-edit") {
    const channelId = readStringParam(actionParams, "channelId", {
      required: true,
    });
    const name = readStringParam(actionParams, "name");
    const topic = readStringParam(actionParams, "topic");
    const position = readNumberParam(actionParams, "position", {
      integer: true,
    });
    const parentId = readParentIdParam(actionParams);
    const nsfw = typeof actionParams.nsfw === "boolean" ? actionParams.nsfw : undefined;
    const rateLimitPerUser = readNumberParam(actionParams, "rateLimitPerUser", {
      integer: true,
    });
    const archived = typeof actionParams.archived === "boolean" ? actionParams.archived : undefined;
    const locked = typeof actionParams.locked === "boolean" ? actionParams.locked : undefined;
    const autoArchiveDuration = readNumberParam(actionParams, "autoArchiveDuration", {
      integer: true,
    });
    const availableTags = parseAvailableTags(actionParams.availableTags);
    return await handleDiscordAction(
      {
        action: "channelEdit",
        accountId: accountId ?? undefined,
        channelId,
        name: name ?? undefined,
        topic: topic ?? undefined,
        position: position ?? undefined,
        parentId: parentId === undefined ? undefined : parentId,
        nsfw,
        rateLimitPerUser: rateLimitPerUser ?? undefined,
        archived,
        locked,
        autoArchiveDuration: autoArchiveDuration ?? undefined,
        availableTags,
      },
      cfg,
    );
  }

  if (action === "channel-delete") {
    const channelId = readStringParam(actionParams, "channelId", {
      required: true,
    });
    return await handleDiscordAction(
      { action: "channelDelete", accountId: accountId ?? undefined, channelId },
      cfg,
    );
  }

  if (action === "channel-move") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const channelId = readStringParam(actionParams, "channelId", {
      required: true,
    });
    const parentId = readParentIdParam(actionParams);
    const position = readNumberParam(actionParams, "position", {
      integer: true,
    });
    return await handleDiscordAction(
      {
        action: "channelMove",
        accountId: accountId ?? undefined,
        guildId,
        channelId,
        parentId: parentId === undefined ? undefined : parentId,
        position: position ?? undefined,
      },
      cfg,
    );
  }

  if (action === "category-create") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const name = readStringParam(actionParams, "name", { required: true });
    const position = readNumberParam(actionParams, "position", {
      integer: true,
    });
    return await handleDiscordAction(
      {
        action: "categoryCreate",
        accountId: accountId ?? undefined,
        guildId,
        name,
        position: position ?? undefined,
      },
      cfg,
    );
  }

  if (action === "category-edit") {
    const categoryId = readStringParam(actionParams, "categoryId", {
      required: true,
    });
    const name = readStringParam(actionParams, "name");
    const position = readNumberParam(actionParams, "position", {
      integer: true,
    });
    return await handleDiscordAction(
      {
        action: "categoryEdit",
        accountId: accountId ?? undefined,
        categoryId,
        name: name ?? undefined,
        position: position ?? undefined,
      },
      cfg,
    );
  }

  if (action === "category-delete") {
    const categoryId = readStringParam(actionParams, "categoryId", {
      required: true,
    });
    return await handleDiscordAction(
      { action: "categoryDelete", accountId: accountId ?? undefined, categoryId },
      cfg,
    );
  }

  if (action === "voice-status") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const userId = readStringParam(actionParams, "userId", { required: true });
    return await handleDiscordAction(
      { action: "voiceStatus", accountId: accountId ?? undefined, guildId, userId },
      cfg,
    );
  }

  if (action === "event-list") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    return await handleDiscordAction(
      { action: "eventList", accountId: accountId ?? undefined, guildId },
      cfg,
    );
  }

  if (action === "event-create") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const name = readStringParam(actionParams, "eventName", { required: true });
    const startTime = readStringParam(actionParams, "startTime", {
      required: true,
    });
    const endTime = readStringParam(actionParams, "endTime");
    const description = readStringParam(actionParams, "desc");
    const channelId = readStringParam(actionParams, "channelId");
    const location = readStringParam(actionParams, "location");
    const entityType = readStringParam(actionParams, "eventType");
    const image = readStringParam(actionParams, "image", { trim: false });
    return await handleDiscordAction(
      {
        action: "eventCreate",
        accountId: accountId ?? undefined,
        guildId,
        name,
        startTime,
        endTime,
        description,
        channelId,
        location,
        entityType,
        image,
      },
      cfg,
      { mediaLocalRoots: ctx.mediaLocalRoots },
    );
  }

  if (isDiscordModerationAction(action)) {
    const moderation = readDiscordModerationCommand(action, {
      ...actionParams,
      durationMinutes: readNumberParam(actionParams, "durationMin", { integer: true }),
      deleteMessageDays: readNumberParam(actionParams, "deleteDays", {
        integer: true,
      }),
    });
    const senderUserId = normalizeOptionalString(ctx.requesterSenderId);
    return await handleDiscordAction(
      {
        action: moderation.action,
        accountId: accountId ?? undefined,
        guildId: moderation.guildId,
        userId: moderation.userId,
        durationMinutes: moderation.durationMinutes,
        until: moderation.until,
        reason: moderation.reason,
        deleteMessageDays: moderation.deleteMessageDays,
        senderUserId,
      },
      cfg,
    );
  }

  // Some actions are conceptually "admin", but still act on a resolved channel.
  if (action === "thread-list") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const channelId = readStringParam(actionParams, "channelId");
    const includeArchived =
      typeof actionParams.includeArchived === "boolean" ? actionParams.includeArchived : undefined;
    const before = readStringParam(actionParams, "before");
    const limit = readNumberParam(actionParams, "limit", { integer: true });
    return await handleDiscordAction(
      {
        action: "threadList",
        accountId: accountId ?? undefined,
        guildId,
        channelId,
        includeArchived,
        before,
        limit,
      },
      cfg,
    );
  }

  if (action === "thread-reply") {
    const content = readStringParam(actionParams, "message", {
      required: true,
    });
    const mediaUrl = readStringParam(actionParams, "media", { trim: false });
    const replyTo = readStringParam(actionParams, "replyTo");

    // `message.thread-reply` (tool) uses `threadId`, while the CLI historically used `to`/`channelId`.
    // Prefer `threadId` when present to avoid accidentally replying in the parent channel.
    const threadId = readStringParam(actionParams, "threadId");
    const channelId = threadId ?? resolveChannelId();

    return await handleDiscordAction(
      {
        action: "threadReply",
        accountId: accountId ?? undefined,
        channelId,
        content,
        mediaUrl: mediaUrl ?? undefined,
        replyTo: replyTo ?? undefined,
      },
      cfg,
    );
  }

  if (action === "search") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const query = readStringParam(actionParams, "query", { required: true });
    return await handleDiscordAction(
      {
        action: "searchMessages",
        accountId: accountId ?? undefined,
        guildId,
        content: query,
        channelId: readStringParam(actionParams, "channelId"),
        channelIds: readStringArrayParam(actionParams, "channelIds"),
        authorId: readStringParam(actionParams, "authorId"),
        authorIds: readStringArrayParam(actionParams, "authorIds"),
        limit: readNumberParam(actionParams, "limit", { integer: true }),
      },
      cfg,
    );
  }

  return undefined;
}
