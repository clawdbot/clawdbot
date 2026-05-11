import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/agent-runtime";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  normalizeInteractiveReply,
  normalizeMessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeOptionalStringifiedId } from "openclaw/plugin-sdk/string-coerce-runtime";
import { handleDiscordAction } from "../../action-runtime-api.js";
import {
  buildDiscordInteractiveComponents,
  buildDiscordPresentationComponents,
} from "../shared-interactive.js";
import { resolveDiscordChannelId } from "../targets.js";
import { tryHandleDiscordMessageActionGuildAdmin } from "./handle-action.guild-admin.js";

const providerId = "discord";

function readCurrentDiscordTarget(
  toolContext: Pick<ChannelMessageActionContext, "toolContext">["toolContext"],
): string | undefined {
  const provider = toolContext?.currentChannelProvider?.trim().toLowerCase();
  if (provider && provider !== providerId) {
    return undefined;
  }
  const target = toolContext?.currentChannelId?.trim();
  return target || undefined;
}

export async function handleDiscordMessageAction(
  ctx: Pick<
    ChannelMessageActionContext,
    | "action"
    | "params"
    | "cfg"
    | "accountId"
    | "requesterSenderId"
    | "toolContext"
    | "mediaAccess"
    | "mediaLocalRoots"
    | "mediaReadFile"
  >,
): Promise<AgentToolResult<unknown>> {
  const { action, params, cfg } = ctx;
  const accountId = ctx.accountId ?? readStringParam(params, "accountId");
  const actionOptions = {
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
  } as const;

  const readTarget = () => {
    const target =
      readStringParam(params, "channelId") ??
      readStringParam(params, "to") ??
      readCurrentDiscordTarget(ctx.toolContext);
    if (!target) {
      throw new Error("Discord channel target is required (use channel:<id>).");
    }
    return target;
  };
  const resolveChannelId = () => resolveDiscordChannelId(readTarget());
  const readSendTarget = () => {
    const target =
      readStringParam(params, "to") ??
      readStringParam(params, "target") ??
      readCurrentDiscordTarget(ctx.toolContext);
    if (!target) {
      throw new Error("Discord channel target is required (use channel:<id>).");
    }
    return target;
  };

  if (action === "send") {
    const to = readSendTarget();
    const asVoice = readBooleanParam(params, "asVoice") === true;
    const rawComponents =
      params.components ??
      buildDiscordPresentationComponents(normalizeMessagePresentation(params.presentation)) ??
      buildDiscordInteractiveComponents(normalizeInteractiveReply(params.interactive));
    const hasComponents =
      Boolean(rawComponents) &&
      (typeof rawComponents === "function" || typeof rawComponents === "object");
    const components = hasComponents ? rawComponents : undefined;
    // Support media, path, and filePath for media URL
    const mediaUrl =
      readStringParam(params, "media", { trim: false }) ??
      readStringParam(params, "path", { trim: false }) ??
      readStringParam(params, "filePath", { trim: false });
    const content = readStringParam(params, "message", {
      required: !asVoice && !hasComponents && !mediaUrl,
      allowEmpty: true,
    });
    const filename = readStringParam(params, "filename");
    const replyTo = readStringParam(params, "replyTo");
    const rawEmbeds = params.embeds;
    const embeds = Array.isArray(rawEmbeds) ? rawEmbeds : undefined;
    const silent = readBooleanParam(params, "silent") === true;
    const sessionKey = readStringParam(params, "__sessionKey");
    const agentId = readStringParam(params, "__agentId");
    return await handleDiscordAction(
      {
        action: "sendMessage",
        accountId: accountId ?? undefined,
        to,
        content: content ?? "",
        mediaUrl: mediaUrl ?? undefined,
        filename: filename ?? undefined,
        replyTo: replyTo ?? undefined,
        components,
        embeds,
        asVoice,
        silent,
        __sessionKey: sessionKey ?? undefined,
        __agentId: agentId ?? undefined,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "upload-file") {
    const to = readSendTarget();
    const mediaUrl =
      readStringParam(params, "filePath", { trim: false }) ??
      readStringParam(params, "path", { trim: false }) ??
      readStringParam(params, "media", { trim: false });
    if (!mediaUrl) {
      throw new Error("upload-file requires filePath, path, or media.");
    }
    const content =
      readStringParam(params, "message", { allowEmpty: true }) ??
      readStringParam(params, "content", { allowEmpty: true });
    const filename = readStringParam(params, "filename");
    const replyTo = readStringParam(params, "replyTo");
    const silent = readBooleanParam(params, "silent") === true;
    const sessionKey = readStringParam(params, "__sessionKey");
    const agentId = readStringParam(params, "__agentId");
    return await handleDiscordAction(
      {
        action: "sendMessage",
        accountId: accountId ?? undefined,
        to,
        content: content ?? "",
        mediaUrl,
        filename: filename ?? undefined,
        replyTo: replyTo ?? undefined,
        silent,
        __sessionKey: sessionKey ?? undefined,
        __agentId: agentId ?? undefined,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "poll") {
    const to = readStringParam(params, "to", { required: true });
    const question = readStringParam(params, "pollQuestion", {
      required: true,
    });
    const answers = readStringArrayParam(params, "pollOption", { required: true });
    const allowMultiselect = readBooleanParam(params, "pollMulti");
    const durationHours = readNumberParam(params, "pollDurationHours", {
      integer: true,
      strict: true,
    });
    return await handleDiscordAction(
      {
        action: "poll",
        accountId: accountId ?? undefined,
        to,
        question,
        answers,
        allowMultiselect,
        durationHours: durationHours ?? undefined,
        content: readStringParam(params, "message"),
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "react") {
    const messageIdRaw = resolveReactionMessageId({ args: params, toolContext: ctx.toolContext });
    const messageId = normalizeOptionalStringifiedId(messageIdRaw) ?? "";
    if (!messageId) {
      throw new Error(
        "messageId required. Provide messageId explicitly or react to the current inbound message.",
      );
    }
    const emoji = readStringParam(params, "emoji", { allowEmpty: true });
    const remove = readBooleanParam(params, "remove");
    return await handleDiscordAction(
      {
        action: "react",
        accountId: accountId ?? undefined,
        channelId: readTarget(),
        messageId,
        emoji,
        remove,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "reactions") {
    const messageId = readStringParam(params, "messageId", { required: true });
    const limit = readNumberParam(params, "limit", { integer: true });
    return await handleDiscordAction(
      {
        action: "reactions",
        accountId: accountId ?? undefined,
        channelId: readTarget(),
        messageId,
        limit,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "read") {
    const limit = readNumberParam(params, "limit", { integer: true });
    return await handleDiscordAction(
      {
        action: "readMessages",
        accountId: accountId ?? undefined,
        channelId: resolveChannelId(),
        limit,
        before: readStringParam(params, "before"),
        after: readStringParam(params, "after"),
        around: readStringParam(params, "around"),
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "edit") {
    const messageId = readStringParam(params, "messageId", { required: true });
    const content = readStringParam(params, "message", { required: true });
    return await handleDiscordAction(
      {
        action: "editMessage",
        accountId: accountId ?? undefined,
        channelId: resolveChannelId(),
        messageId,
        content,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "delete") {
    const messageId = readStringParam(params, "messageId", { required: true });
    return await handleDiscordAction(
      {
        action: "deleteMessage",
        accountId: accountId ?? undefined,
        channelId: resolveChannelId(),
        messageId,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "pin" || action === "unpin" || action === "list-pins") {
    const messageId =
      action === "list-pins" ? undefined : readStringParam(params, "messageId", { required: true });
    return await handleDiscordAction(
      {
        action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
        accountId: accountId ?? undefined,
        channelId: resolveChannelId(),
        messageId,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "permissions") {
    return await handleDiscordAction(
      {
        action: "permissions",
        accountId: accountId ?? undefined,
        channelId: resolveChannelId(),
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "thread-create") {
    const name = readStringParam(params, "threadName", { required: true });
    const messageId = readStringParam(params, "messageId");
    const content = readStringParam(params, "message");
    const autoArchiveMinutes = readNumberParam(params, "autoArchiveMin", {
      integer: true,
    });
    const appliedTags = readStringArrayParam(params, "appliedTags");
    return await handleDiscordAction(
      {
        action: "threadCreate",
        accountId: accountId ?? undefined,
        channelId: resolveChannelId(),
        name,
        messageId,
        content,
        autoArchiveMinutes,
        appliedTags: appliedTags ?? undefined,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "sticker") {
    const stickerIds =
      readStringArrayParam(params, "stickerId", {
        required: true,
        label: "sticker-id",
      }) ?? [];
    return await handleDiscordAction(
      {
        action: "sticker",
        accountId: accountId ?? undefined,
        to: readStringParam(params, "to", { required: true }),
        stickerIds,
        content: readStringParam(params, "message"),
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "set-presence") {
    return await handleDiscordAction(
      {
        action: "setPresence",
        accountId: accountId ?? undefined,
        status: readStringParam(params, "status"),
        activityType: readStringParam(params, "activityType"),
        activityName: readStringParam(params, "activityName"),
        activityUrl: readStringParam(params, "activityUrl"),
        activityState: readStringParam(params, "activityState"),
      },
      cfg,
      actionOptions,
    );
  }

  const adminResult = await tryHandleDiscordMessageActionGuildAdmin({
    ctx,
    resolveChannelId,
  });
  if (adminResult !== undefined) {
    return adminResult;
  }

  throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
}
