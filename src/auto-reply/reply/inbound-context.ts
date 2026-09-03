// Builds prompt context facts from inbound channel and sender metadata.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import {
  projectMediaFacts,
  resolveMediaFacts,
  resolveStagedMediaFacts,
  stripLegacyMediaContextFields,
  type LegacyMediaContextKey,
} from "../../media/media-facts.js";
import { resolveCommandTurnContext } from "../command-turn-context.js";
import { normalizeInternalTurnContext } from "../internal-turn-source.js";
import type {
  CanonicalInboundText,
  FinalizedMsgContext,
  FinalizedRuntimeMsgContext,
  MsgContext,
} from "../templating.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";

export type FinalizeInboundContextOptions = {
  forceBodyForAgent?: boolean;
  forceBodyForCommands?: boolean;
  forceChatType?: boolean;
};

const FINALIZED_INBOUND_CONTEXT = Symbol("openclaw.finalizedInboundContext");

function normalizeTextField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return normalizeInboundTextNewlines(value);
}

export function isFinalizedInboundContext<T extends Record<string, unknown>>(
  ctx: T,
): ctx is T & CanonicalInboundText {
  return (ctx as T & { [FINALIZED_INBOUND_CONTEXT]?: boolean })[FINALIZED_INBOUND_CONTEXT] === true;
}

function resolveCanonicalInboundText(
  ctx: Record<string, unknown>,
  opts: Pick<FinalizeInboundContextOptions, "forceBodyForAgent" | "forceBodyForCommands"> = {},
): CanonicalInboundText {
  const body = normalizeTextField(ctx.Body) ?? "";
  const rawTextFromAliases =
    normalizeTextField(ctx.RawBody) ??
    normalizeTextField(ctx.Transcript) ??
    normalizeTextField(ctx.BodyStripped) ??
    body;
  const forceTextProjection = opts.forceBodyForAgent || opts.forceBodyForCommands;
  const rawText = forceTextProjection
    ? rawTextFromAliases
    : (normalizeTextField(ctx.rawText) ?? rawTextFromAliases);
  const agentText = opts.forceBodyForAgent
    ? body
    : (normalizeTextField(ctx.agentText) ??
      normalizeTextField(ctx.BodyForAgent) ??
      normalizeTextField(ctx.CommandBody) ??
      rawText);
  const commandText = opts.forceBodyForCommands
    ? (normalizeTextField(ctx.CommandBody) ?? rawText)
    : (normalizeTextField(ctx.commandText) ??
      normalizeTextField(ctx.BodyForCommands) ??
      normalizeTextField(ctx.CommandBody) ??
      rawText);
  return { commandText, agentText, rawText };
}

function foldDeprecatedPromptContextFields(ctx: MsgContext): void {
  // Deprecated SDK field names fold here so third-party channel plugins keep working.
  // Runtime reads only the channel-named fields; remove this with the deprecated fields.
  if (ctx.ChannelPromptContext === undefined && ctx.UntrustedContext !== undefined) {
    ctx.ChannelPromptContext = ctx.UntrustedContext;
  }
  delete ctx.UntrustedContext;
  if (ctx.ChannelStructuredContext === undefined && ctx.UntrustedStructuredContext !== undefined) {
    ctx.ChannelStructuredContext = ctx.UntrustedStructuredContext;
  }
  delete ctx.UntrustedStructuredContext;
}

function applySupplementalContext(ctx: MsgContext): void {
  const supplemental = ctx.SupplementalContext;
  if (!supplemental) {
    return;
  }
  if (
    supplemental.channelStructuredContext === undefined &&
    supplemental.untrustedContext !== undefined
  ) {
    // Fold the deprecated supplemental SDK key before projecting the canonical context shape.
    supplemental.channelStructuredContext = supplemental.untrustedContext;
  }
  delete supplemental.untrustedContext;
  const fields = {
    ReplyToId: supplemental.quote?.id,
    ReplyToIdFull: supplemental.quote?.fullId,
    ReplyToBody: supplemental.quote?.body,
    ReplyToSender: supplemental.quote?.sender,
    ReplyToIsQuote: supplemental.quote?.isQuote,
    ForwardedFrom: supplemental.forwarded?.from,
    ForwardedFromType: supplemental.forwarded?.fromType,
    ForwardedFromId: supplemental.forwarded?.fromId,
    ForwardedDate: supplemental.forwarded?.date,
    ThreadStarterBody: supplemental.thread?.starterBody,
    ThreadHistoryBody: supplemental.thread?.historyBody,
    ThreadLabel: supplemental.thread?.label,
    GroupSystemPrompt: supplemental.groupSystemPrompt,
    ChannelStructuredContext: supplemental.channelStructuredContext,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && ctx[key as keyof MsgContext] === undefined) {
      ctx[key as keyof MsgContext] = value as never;
    }
  }
  delete ctx.SupplementalContext;
}

function finalizeInboundContextImpl<T extends Record<string, unknown>>(
  ctx: T,
  opts: FinalizeInboundContextOptions,
  preserveLegacyMedia: boolean,
): T & FinalizedMsgContext {
  const normalized = ctx as T & MsgContext;
  normalizeInternalTurnContext(normalized);
  foldDeprecatedPromptContextFields(normalized);
  applySupplementalContext(normalized);

  normalized.Body = normalizeTextField(normalized.Body) ?? "";
  normalized.RawBody = normalizeTextField(normalized.RawBody);
  normalized.CommandBody = normalizeTextField(normalized.CommandBody);
  normalized.Transcript = normalizeTextField(normalized.Transcript);
  normalized.ThreadStarterBody = normalizeTextField(normalized.ThreadStarterBody);
  normalized.ThreadHistoryBody = normalizeTextField(normalized.ThreadHistoryBody);
  normalized.GroupSystemPrompt = normalizeTextField(normalized.GroupSystemPrompt);
  if (Array.isArray(normalized.ChannelPromptContext)) {
    const normalizedChannelPromptContext = normalized.ChannelPromptContext.map((entry) =>
      normalizeTextField(entry),
    ).filter((entry): entry is string => Boolean(entry));
    normalized.ChannelPromptContext = normalizedChannelPromptContext;
  }

  const chatType = normalizeChatType(normalized.ChatType);
  if (chatType && (opts.forceChatType || normalized.ChatType !== chatType)) {
    normalized.ChatType = chatType;
  }

  Object.assign(normalized, resolveCanonicalInboundText(normalized, opts));
  // Keep the shipped aliases as projections at the public context boundary.
  normalized.BodyForAgent = normalized.agentText;
  normalized.BodyForCommands = normalized.commandText;

  const explicitLabel = normalizeOptionalString(normalized.ConversationLabel);
  if (!explicitLabel) {
    const resolved = normalizeOptionalString(resolveConversationLabel(normalized));
    if (resolved) {
      normalized.ConversationLabel = resolved;
    }
  } else {
    normalized.ConversationLabel = explicitLabel;
  }

  // Always set. Default-deny when upstream forgets to populate it.
  normalized.CommandAuthorized = normalized.CommandAuthorized === true;
  normalized.CommandTurn = resolveCommandTurnContext(normalized);
  if (normalized.CommandTurn.source === "native" || normalized.CommandTurn.source === "text") {
    normalized.CommandSource = normalized.CommandTurn.source;
    normalized.CommandAuthorized = normalized.CommandTurn.authorized;
  } else {
    normalized.CommandSource = undefined;
  }

  const mediaSource =
    normalized.MediaStaged === true || normalizeOptionalString(normalized.MediaWorkspaceDir)
      ? resolveStagedMediaFacts(normalized)
      : resolveMediaFacts(normalized);
  const media = mediaSource.map((fact) =>
    (fact.path || fact.url) && !fact.contentType && !fact.kind
      ? Object.assign(fact, { contentType: "application/octet-stream" })
      : fact,
  );
  if (media.length > 0) {
    normalized.media = media;
    if (preserveLegacyMedia) {
      Object.assign(normalized, projectMediaFacts(media));
    }
  }
  if (!preserveLegacyMedia) {
    stripLegacyMediaContextFields(normalized);
  }
  Object.defineProperty(normalized, FINALIZED_INBOUND_CONTEXT, {
    configurable: true,
    value: true,
  });

  return normalized as T & FinalizedMsgContext;
}

export function finalizeInboundContext<T extends Record<string, unknown>>(
  ctx: T,
  opts: FinalizeInboundContextOptions = {},
): Omit<T, LegacyMediaContextKey> & FinalizedRuntimeMsgContext {
  return finalizeInboundContextImpl(ctx, opts, false) as Omit<T, LegacyMediaContextKey> &
    FinalizedRuntimeMsgContext;
}

/** Keeps the shipped Plugin SDK return type while internal callers use the stricter type above. */
export function finalizeInboundContextForSdk<T extends Record<string, unknown>>(
  ctx: T,
  opts: FinalizeInboundContextOptions = {},
): T & FinalizedMsgContext & CanonicalInboundText {
  return finalizeInboundContextImpl(ctx, opts, true) as T &
    FinalizedMsgContext &
    CanonicalInboundText;
}
