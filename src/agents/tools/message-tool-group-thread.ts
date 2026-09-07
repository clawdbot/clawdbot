import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "@openclaw/normalization-core/string-coerce";
import {
  captureGroupThreadToolReply,
  formatGroupThreadReply,
  getGroupThreadTurn,
  recordGroupThreadReply,
} from "../../auto-reply/group-thread-context.js";
import { isSilentReplyPayloadText } from "../../auto-reply/tokens.js";
import type { PreparedMessageToolCatalog } from "../../channels/plugins/message-action-discovery.js";
import type {
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import { resolveChannelThreadAddressing } from "../../channels/thread-addressing.js";
import type { MessageActionResult } from "../../infra/outbound/message-action-contracts.js";
import { resolveActionDeliveryTargetAlias } from "../../infra/outbound/message-action-spec.js";
import { sourceDeliveryTargetsMatch } from "../../infra/outbound/source-delivery-plan.js";
import { isDeliveredCurrentSourceReply } from "../../infra/outbound/source-reply-mirror.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { projectEmbeddedMessageDeliveryFact } from "../embedded-agent-message-delivery.js";
import { readStringArrayParam } from "./common.js";
import { hasSanitizedSendPayloadContent } from "./message-tool-visible-content.js";

/** Owns source-only labels and final observations for one message action. */
export function prepareMessageToolGroupThread(
  args: Record<string, unknown>,
  options: {
    action: ChannelMessageActionName;
    channel?: string;
    accountId?: string;
    currentAccountId?: string;
    toolContext?: ChannelThreadingToolContext;
    catalog?: PreparedMessageToolCatalog;
  },
) {
  const { action, channel, accountId, currentAccountId, toolContext, catalog } = options;
  const currentThreadTs = toolContext?.currentThreadTs;
  const currentTarget = toolContext?.currentMessagingTarget ?? toolContext?.currentChannelId;
  const sourceAction =
    getGroupThreadTurn() &&
    ["send", "edit", "reply", "thread-reply"].includes(action) &&
    (!args.replyTo ||
      [String(toolContext?.currentMessageId ?? ""), currentThreadTs].includes(
        normalizeOptionalStringifiedId(args.replyTo),
      )) &&
    (action !== "reply" ||
      normalizeOptionalStringifiedId(args.messageId) ===
        normalizeOptionalStringifiedId(toolContext?.currentMessageId)) &&
    (action !== "edit" || !currentThreadTs || args.threadId || args.messageThreadId) &&
    [
      args.target,
      args.to,
      args.channelId,
      resolveActionDeliveryTargetAlias(action, args, {
        channel,
        aliasSpec: catalog?.getChannel(channel ?? "")?.actions?.messageActionTargetAliases?.[
          action
        ],
      }),
    ]
      .map(normalizeOptionalStringifiedId)
      .filter((target): target is string => Boolean(target))
      .concat(!args.target && !args.to && !args.channelId ? [currentTarget ?? ""] : [])
      .every((target) =>
        sourceDeliveryTargetsMatch(
          {
            provider: channel,
            accountId: normalizeAccountId(accountId),
            to: target,
            threadId: normalizeOptionalStringifiedId(args.threadId ?? args.messageThreadId),
            threadImplicit: true,
            threadSuppressed: args.topLevel === true || args.threadId === null,
          },
          {
            channel: toolContext?.currentChannelProvider,
            accountId: normalizeAccountId(currentAccountId),
            to: currentTarget,
            threadId: currentThreadTs,
          },
        ),
      );
  const text = sourceAction
    ? [args.message, args.text, args.content, args.caption].find(
        (value): value is string => typeof value === "string" && Boolean(value.trim()),
      )
    : undefined;
  const reply = sourceAction
    ? {
        text,
        mediaUrl: [args.mediaUrl, args.media, args.path, args.filePath, args.fileUrl]
          .map(normalizeOptionalString)
          .find(Boolean),
        mediaUrls: readStringArrayParam(args, "mediaUrls"),
      }
    : undefined;
  const silent = Boolean(text && isSilentReplyPayloadText(text));
  if (sourceAction && !silent) {
    if (!text && hasSanitizedSendPayloadContent(args)) {
      args.message = formatGroupThreadReply("");
    }
    for (const field of ["message", "text", "content", "caption"]) {
      if (text && typeof args[field] === "string" && args[field].trim()) {
        args[field] = formatGroupThreadReply(args[field]);
      }
    }
  }
  let capturedReply: { observed: boolean; text?: string } | undefined;
  const threadAddressing = sourceAction ? resolveChannelThreadAddressing(channel) : undefined;
  return {
    silent,
    async run(runAction: () => Promise<MessageActionResult>): Promise<MessageActionResult> {
      const captured = await captureGroupThreadToolReply(
        runAction,
        sourceAction
          ? {
              matches: (event, context) => {
                const target = {
                  provider: context.channelId,
                  accountId: normalizeAccountId(context.accountId),
                  to: event.to,
                };
                const source = {
                  channel: toolContext?.currentChannelProvider,
                  accountId: normalizeAccountId(currentAccountId),
                  to: currentTarget,
                };
                const threadId =
                  normalizeOptionalStringifiedId(event.threadId) ??
                  (threadAddressing === "message"
                    ? normalizeOptionalStringifiedId(event.replyToId)
                    : currentThreadTs &&
                        sourceDeliveryTargetsMatch(target, { ...source, to: currentThreadTs })
                      ? currentThreadTs
                      : undefined);
                return sourceDeliveryTargetsMatch(
                  { ...target, threadId },
                  { ...source, threadId: currentThreadTs },
                );
              },
              format: formatGroupThreadReply,
            }
          : undefined,
      );
      capturedReply = captured;
      return captured.result;
    },
    record(
      result: MessageActionResult,
      sourceReply: Parameters<typeof isDeliveredCurrentSourceReply>[0],
      currentSourceReply: boolean,
      final: boolean | undefined,
    ): void {
      // Edits share the send destination contract without claiming a new source reply.
      const delivery =
        reply &&
        (currentSourceReply ||
          (action === "edit" && isDeliveredCurrentSourceReply({ ...sourceReply, action: "send" })))
          ? projectEmbeddedMessageDeliveryFact(result, true)
          : undefined;
      if (
        reply &&
        delivery?.status === "settled" &&
        !delivery.partialDelivery &&
        (!capturedReply?.observed || capturedReply.text !== undefined) &&
        final !== false &&
        !result.dryRun
      ) {
        recordGroupThreadReply({
          ...reply,
          ...(capturedReply?.observed ? { text: capturedReply.text } : {}),
        });
      }
    },
  };
}
