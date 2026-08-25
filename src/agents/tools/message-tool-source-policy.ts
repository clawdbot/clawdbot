import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { Type, type TObject } from "typebox";
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import type { AgentRuntimeMessageActionContext } from "../../gateway/message-action-turn-capability.js";
import { MessageActionDeniedError } from "../../infra/outbound/message-action-denial.js";
import { sourceDeliveryTargetsMatch } from "../../infra/outbound/source-delivery-plan.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { stripUnsupportedCitationControlMarkers } from "../../shared/text/citation-control-markers.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { channelTargetSchema, stringEnum } from "../schema/typebox.js";
import { readToolStringParam } from "./common.js";
import { normalizeEscapedLineBreaksForVisibleText } from "./message-tool-visible-content.js";

function sourceReplyPolicyError(message: string): MessageActionDeniedError {
  return new MessageActionDeniedError(
    message,
    "message_source_reply_policy_denied",
    "message-source-reply:current-conversation",
  );
}
export const SOURCE_REPLY_ONLY_MESSAGE_SCHEMA = Type.Object({
  action: stringEnum(["send"], {
    description: "Send a text reply to the current source conversation.",
  }),
  channel: Type.Optional(Type.String()),
  target: Type.Optional(channelTargetSchema()),
  accountId: Type.Optional(Type.String()),
  message: Type.Optional(
    Type.String({ description: "Text to send to the current source conversation." }),
  ),
  replyTo: Type.Optional(Type.String()),
  threadId: Type.Optional(Type.String()),
});
const SOURCE_REPLY_ONLY_RUNTIME_ARG_NAMES = new Set(["to", "channelId", "final"]);
const SOURCE_REPLY_FINAL_PROPERTY = Type.Optional(
  Type.Boolean({
    description:
      "Set false for progress. Set true, or omit, for the completed current-source reply.",
  }),
);

export function addSourceReplyFinalControl<T extends TObject>(
  schema: T,
  sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined,
): T | TObject {
  if (sourceReplyDeliveryMode !== "message_tool_only") {
    return schema;
  }
  return Type.Object({ ...schema.properties, final: SOURCE_REPLY_FINAL_PROPERTY });
}

export function enforceSourceReplyOnlyTextDirectives(args: Record<string, unknown>): void {
  if (typeof args.message !== "string" || !args.message.trim()) {
    throw sourceReplyPolicyError("Completion source replies require non-empty visible text.");
  }
  // Use the outbound owner's parser: sanitization can assemble directives that
  // change routes, attach local files, or deliver audio.
  const message = normalizeEscapedLineBreaksForVisibleText(args.message);
  const withoutCitationMarkers = stripUnsupportedCitationControlMarkers(message);
  for (const normalized of new Set([
    message,
    withoutCitationMarkers,
    stripPlainTextToolCallBlocks(withoutCitationMarkers),
  ])) {
    const directives = parseReplyDirectives(normalized, { extractMarkdownImages: true });
    if (
      directives.replyToTag ||
      directives.audioAsVoice ||
      directives.mediaUrls?.length ||
      directives.isSilent
    ) {
      throw sourceReplyPolicyError(
        "Completion source replies cannot contain non-text or silent directives.",
      );
    }
  }
}

// A live channel turn grants delegated use of that provider account, not a
// model-selected sibling account. Keep cross-provider and source-less routing intact.
export function enforceTrustedTurnExplicitAccount(params: {
  explicitAccountId?: string;
  selectedChannels: Array<string | undefined>;
  trustedCurrentChannel?: string;
  trustedRequesterAccountId?: string;
  hasTrustedTurnContext: boolean;
}): void {
  if (!params.explicitAccountId || !params.hasTrustedTurnContext) {
    return;
  }
  const trustedCurrentChannel = normalizeMessageChannel(params.trustedCurrentChannel);
  if (!trustedCurrentChannel) {
    throw new MessageActionDeniedError(
      "Trusted current account is missing its channel identity.",
      "message_trusted_account_context_missing",
      "message-account:trusted-turn",
    );
  }
  const includesTrustedCurrentChannel = params.selectedChannels.some(
    (channel) => normalizeMessageChannel(channel) === trustedCurrentChannel,
  );
  if (!includesTrustedCurrentChannel) {
    return;
  }
  if (normalizeOptionalAccountId(params.trustedRequesterAccountId) !== params.explicitAccountId) {
    throw new MessageActionDeniedError(
      "Explicit account does not match the trusted current account.",
      "message_account_mismatch",
      "message-account:trusted-turn",
    );
  }
}

export function enforceSourceReplyOnlyMessageAction(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  currentChannelProvider?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentAccountId?: string;
  trustedTurnContext?: AgentRuntimeMessageActionContext;
}): void {
  if (params.action !== "send") {
    throw sourceReplyPolicyError(
      `Completion source replies permit only action "send", not "${params.action}".`,
    );
  }
  for (const name of Object.keys(params.args)) {
    if (
      !Object.hasOwn(SOURCE_REPLY_ONLY_MESSAGE_SCHEMA.properties, name) &&
      !SOURCE_REPLY_ONLY_RUNTIME_ARG_NAMES.has(name)
    ) {
      throw sourceReplyPolicyError(`Completion source replies cannot use the "${name}" argument.`);
    }
  }
  enforceSourceReplyOnlyTextDirectives(params.args);

  const sourceContext = params.trustedTurnContext?.toolContext ?? params;
  const sourceChannel = normalizeMessageChannel(sourceContext.currentChannelProvider);
  const sourceTargets = uniqueValues(
    [sourceContext.currentMessagingTarget, sourceContext.currentChannelId]
      .map((target) => normalizeOptionalString(target))
      .filter((target): target is string => Boolean(target)),
  );
  if (!sourceChannel || sourceTargets.length === 0) {
    throw sourceReplyPolicyError(
      "Completion source replies require an authoritative current conversation.",
    );
  }

  const requestedChannel = readToolStringParam(params.args, "channel");
  if (requestedChannel && normalizeMessageChannel(requestedChannel) !== sourceChannel) {
    throw sourceReplyPolicyError("Completion source replies cannot target another channel.");
  }

  const requestedAccountId = readToolStringParam(params.args, "accountId");
  const sourceAccountId = params.trustedTurnContext
    ? params.trustedTurnContext.requesterAccountId
    : params.currentAccountId;
  if (
    requestedAccountId &&
    normalizeOptionalAccountId(requestedAccountId) !== normalizeOptionalAccountId(sourceAccountId)
  ) {
    throw sourceReplyPolicyError("Completion source replies cannot use another channel account.");
  }

  const sourceThreadId = normalizeOptionalString(sourceContext.currentThreadTs);
  const requestedThreadId = normalizeOptionalStringifiedId(params.args.threadId);
  if (requestedThreadId && requestedThreadId !== sourceThreadId) {
    throw sourceReplyPolicyError("Completion source replies cannot target another thread.");
  }

  const requestedReplyTo = readToolStringParam(params.args, "replyTo");
  const sourceMessageId = normalizeOptionalStringifiedId(sourceContext.currentMessageId);
  if (
    requestedReplyTo &&
    requestedReplyTo !== sourceMessageId &&
    requestedReplyTo !== sourceThreadId
  ) {
    throw sourceReplyPolicyError(
      "Completion source replies cannot reply outside the current thread.",
    );
  }

  const explicitTargets = uniqueValues(
    [params.args.target, params.args.to, params.args.channelId]
      .map((target) => normalizeOptionalStringifiedId(target))
      .filter((target): target is string => Boolean(target)),
  );
  for (const requestedTarget of explicitTargets) {
    if (
      !sourceTargets.some((sourceTarget) =>
        sourceDeliveryTargetsMatch(
          {
            provider: sourceChannel,
            accountId: sourceAccountId,
            to: requestedTarget,
            threadImplicit: true,
          },
          {
            channel: sourceChannel,
            accountId: sourceAccountId,
            to: sourceTarget,
            threadId: sourceThreadId,
          },
        ),
      )
    ) {
      throw sourceReplyPolicyError(
        "Completion source replies cannot target another conversation or thread.",
      );
    }
  }
}
