// Slack plugin module implements message action dispatch behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  normalizeInteractiveReply,
  normalizeMessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultSlackAccountId } from "./accounts.js";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import { buildSlackPresentationBlocks, canRenderSlackPresentation } from "./blocks-render.js";
import { SLACK_EDIT_TEXT_LIMIT } from "./limits.js";
import { renderSlackMessagePresentationFallbackText } from "./presentation-fallback.js";
import {
  resolveSlackReplyBlockResolution,
  resolveSlackReplyDeliveryMessages,
  type SlackReplyDeliveryMessage,
} from "./reply-blocks.js";

type SlackActionInvoke = (
  action: Record<string, unknown>,
  cfg: ChannelMessageActionContext["cfg"],
  toolContext?: ChannelMessageActionContext["toolContext"],
) => Promise<AgentToolResult<unknown>>;

function resolveSlackPresentationText(
  content: string | undefined,
  presentation: ReturnType<typeof normalizeMessagePresentation>,
): string {
  const hasStructuredData = presentation?.blocks.some(
    (block) => block.type === "chart" || block.type === "table",
  );
  return hasStructuredData
    ? renderSlackMessagePresentationFallbackText({ text: content, presentation })
    : (content ?? "");
}

function renderSlackActionPresentation(
  presentation: ReturnType<typeof normalizeMessagePresentation>,
): {
  blocks?: ReturnType<typeof buildSlackPresentationBlocks>;
  usesPresentationTextFallback: boolean;
} {
  if (!presentation) {
    return { usesPresentationTextFallback: false };
  }
  const renderedBlocks = canRenderSlackPresentation(presentation)
    ? buildSlackPresentationBlocks(presentation)
    : undefined;
  const usesPresentationTextFallback = !renderedBlocks || renderedBlocks.length > SLACK_MAX_BLOCKS;
  const blocks = usesPresentationTextFallback ? undefined : renderedBlocks;
  return {
    ...(blocks?.length ? { blocks } : {}),
    usesPresentationTextFallback,
  };
}

/** Translate generic channel action requests into Slack-specific tool invocations and payload shapes. */
export async function handleSlackMessageAction(params: {
  providerId: string;
  ctx: ChannelMessageActionContext;
  invoke: SlackActionInvoke;
  normalizeChannelId?: (channelId: string) => string;
  includeReadThreadId?: boolean;
}): Promise<AgentToolResult<unknown>> {
  const { providerId, ctx, invoke, normalizeChannelId, includeReadThreadId = false } = params;
  const { action, cfg, params: actionParams } = ctx;
  const accountId = ctx.accountId ?? undefined;
  const resolveChannelId = () => {
    const channelId =
      readStringParam(actionParams, "channelId") ??
      readStringParam(actionParams, "to", { required: true });
    return normalizeChannelId ? normalizeChannelId(channelId) : channelId;
  };

  if (action === "send") {
    const to = readStringParam(actionParams, "to", { required: true });
    const content = readStringParam(actionParams, "message", {
      required: false,
      allowEmpty: true,
    });
    const mediaUrl = readStringParam(actionParams, "media", { trim: false });
    const presentation = normalizeMessagePresentation(actionParams.presentation);
    const interactive = normalizeInteractiveReply(actionParams.interactive);
    const hasStructuredContent = Boolean(presentation || interactive?.blocks.length);
    const resolution = resolveSlackReplyBlockResolution(
      {
        text: content,
        presentation,
        interactive,
      },
      { materializeAuthoredText: hasStructuredContent },
    );
    const preparedMessages =
      resolution.segments.length > 0
        ? resolveSlackReplyDeliveryMessages({
            authoredTextPlacement: resolution.authoredTextPlacement,
            segments: resolution.segments,
            text: content,
          })
        : [];
    if (!content && preparedMessages.length === 0 && !mediaUrl) {
      throw new Error("Slack send requires message, blocks, or media.");
    }
    const replyBroadcast = readBooleanParam(actionParams, "replyBroadcast");
    if (replyBroadcast && mediaUrl) {
      throw new Error("Slack replyBroadcast is only supported for text or block thread replies.");
    }
    const threadId = readStringParam(actionParams, "threadId");
    const replyTo = readStringParam(actionParams, "replyTo");
    const topLevel =
      readBooleanParam(actionParams, "topLevel") === true || actionParams.threadId === null;
    const toolContext =
      preparedMessages.length > 0
        ? {
            ...ctx.toolContext,
            preparedMessages: preparedMessages satisfies readonly SlackReplyDeliveryMessage[],
          }
        : ctx.toolContext;
    return await invoke(
      {
        action: "sendMessage",
        to,
        content: content ?? "",
        mediaUrl: mediaUrl ?? undefined,
        accountId,
        threadTs: threadId ?? replyTo ?? undefined,
        ...(topLevel ? { topLevel: true } : {}),
        ...(replyBroadcast ? { replyBroadcast } : {}),
      },
      cfg,
      toolContext,
    );
  }

  if (action === "react") {
    const messageIdRaw = resolveReactionMessageId({
      args: actionParams,
      toolContext: ctx.toolContext,
    });
    if (messageIdRaw == null) {
      throw new Error(
        "messageId required. Provide messageId explicitly or react to the current inbound message.",
      );
    }
    const messageId = String(messageIdRaw);
    const emoji = readStringParam(actionParams, "emoji", { allowEmpty: true });
    const remove = typeof actionParams.remove === "boolean" ? actionParams.remove : undefined;
    return await invoke(
      {
        action: "react",
        channelId: resolveChannelId(),
        messageId,
        emoji,
        remove,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "reactions") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    const limit = readPositiveIntegerParam(actionParams, "limit", {
      message: "limit must be a positive integer.",
    });
    return await invoke(
      {
        action: "reactions",
        channelId: resolveChannelId(),
        messageId,
        limit,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "read") {
    const limit = readPositiveIntegerParam(actionParams, "limit", {
      message: "limit must be a positive integer.",
    });
    const readAction: Record<string, unknown> = {
      action: "readMessages",
      channelId: resolveChannelId(),
      limit,
      before: readStringParam(actionParams, "before"),
      after: readStringParam(actionParams, "after"),
      messageId: readStringParam(actionParams, "messageId"),
      accountId,
    };
    if (includeReadThreadId) {
      readAction.threadId = readStringParam(actionParams, "threadId");
    }
    return await invoke(readAction, cfg, ctx.toolContext);
  }

  if (action === "edit") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    const content = readStringParam(actionParams, "message", { allowEmpty: true });
    const presentation = normalizeMessagePresentation(actionParams.presentation);
    const renderedPresentation = renderSlackActionPresentation(presentation);
    // Slack hides top-level text when blocks are present on updates. Keep an
    // unrenderable presentation text-only so its complete fallback stays visible.
    const blocks = renderedPresentation.usesPresentationTextFallback
      ? undefined
      : renderedPresentation.blocks;
    const accessibleContent = renderedPresentation.usesPresentationTextFallback
      ? renderSlackMessagePresentationFallbackText({ text: content, presentation })
      : resolveSlackPresentationText(content, presentation);
    if (
      renderedPresentation.usesPresentationTextFallback &&
      accessibleContent.length > SLACK_EDIT_TEXT_LIMIT
    ) {
      throw new Error(
        `Slack presentation fallback exceeds the ${String(SLACK_EDIT_TEXT_LIMIT)}-character edit limit. Send a new message instead.`,
      );
    }
    if (!accessibleContent && !blocks) {
      throw new Error("Slack edit requires message or blocks.");
    }
    return await invoke(
      {
        action: "editMessage",
        channelId: resolveChannelId(),
        messageId,
        content: accessibleContent,
        blocks,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "delete") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    return await invoke(
      {
        action: "deleteMessage",
        channelId: resolveChannelId(),
        messageId,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "pin" || action === "unpin" || action === "list-pins") {
    const messageId =
      action === "list-pins"
        ? undefined
        : readStringParam(actionParams, "messageId", { required: true });
    return await invoke(
      {
        action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
        channelId: resolveChannelId(),
        messageId,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "member-info") {
    const requesterAccountId = ctx.requesterAccountId
      ? normalizeAccountId(ctx.requesterAccountId)
      : undefined;
    const targetAccountId = normalizeAccountId(accountId ?? resolveDefaultSlackAccountId(cfg));
    const requesterUserId =
      normalizeOptionalLowercaseString(ctx.toolContext?.currentChannelProvider) === "slack" &&
      requesterAccountId !== undefined &&
      requesterAccountId === targetAccountId
        ? normalizeOptionalString(ctx.requesterSenderId)
        : undefined;
    const userId = readStringParam(actionParams, "userId") ?? requesterUserId;
    if (!userId) {
      throw new Error("member-info requires a userId outside a current Slack conversation.");
    }
    return await invoke({ action: "memberInfo", userId, accountId }, cfg, ctx.toolContext);
  }

  if (action === "emoji-list") {
    const limit = readPositiveIntegerParam(actionParams, "limit", {
      message: "limit must be a positive integer.",
    });
    return await invoke({ action: "emojiList", limit, accountId }, cfg, ctx.toolContext);
  }

  if (action === "download-file") {
    const fileIdParam = readStringParam(actionParams, "fileId");
    const messageIdParam =
      readStringParam(actionParams, "messageId") ?? readStringParam(actionParams, "message_id");
    if (!fileIdParam && messageIdParam) {
      throw new Error(
        "download-file requires fileId (the Slack file id, for example F0B0LTT8M36 from event.files[].id), not messageId. Did you mean to pass fileId? messageId is the Slack message timestamp and is used by react / reactions / edit / delete / pin / unpin actions, not download-file.",
      );
    }
    const fileId = readStringParam(actionParams, "fileId", { required: true });
    const channelId =
      readStringParam(actionParams, "channelId") ?? readStringParam(actionParams, "to");
    const threadId =
      readStringParam(actionParams, "threadId") ?? readStringParam(actionParams, "replyTo");
    return await invoke(
      {
        action: "downloadFile",
        fileId,
        channelId: channelId ?? undefined,
        threadId: threadId ?? undefined,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "upload-file") {
    const replyBroadcast = readBooleanParam(actionParams, "replyBroadcast");
    if (replyBroadcast) {
      throw new Error("Slack replyBroadcast is only supported for text or block thread replies.");
    }
    const to = readStringParam(actionParams, "to") ?? resolveChannelId();
    const filePath =
      readStringParam(actionParams, "filePath", { trim: false }) ??
      readStringParam(actionParams, "path", { trim: false }) ??
      readStringParam(actionParams, "media", { trim: false });
    if (!filePath) {
      throw new Error("upload-file requires filePath, path, or media");
    }
    const threadId =
      readStringParam(actionParams, "threadId") ?? readStringParam(actionParams, "replyTo");
    const topLevel =
      readBooleanParam(actionParams, "topLevel") === true || actionParams.threadId === null;
    return await invoke(
      {
        action: "uploadFile",
        to,
        filePath,
        initialComment:
          readStringParam(actionParams, "initialComment", { allowEmpty: true }) ??
          readStringParam(actionParams, "message", { allowEmpty: true }) ??
          "",
        filename: readStringParam(actionParams, "filename"),
        title: readStringParam(actionParams, "title"),
        threadTs: threadId ?? undefined,
        ...(topLevel ? { topLevel: true } : {}),
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
}
