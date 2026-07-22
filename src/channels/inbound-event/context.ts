/**
 * Channel inbound event context builder.
 *
 * Converts route, sender, command, media, and supplemental facts into finalized message context.
 */
import {
  commandTurnKindToSource,
  createCommandTurnContext,
  type CommandTurnContext,
} from "../../auto-reply/command-turn-context.js";
import {
  finalizeInboundContext as finalizeCoreInboundContext,
  type FinalizeInboundContextOptions,
} from "../../auto-reply/reply/inbound-context.js";
import {
  normalizeInboundTextNewlines,
  sanitizeInboundSystemTags,
} from "../../auto-reply/reply/inbound-text.js";
import type {
  FinalizedMsgContext,
  MentionSource,
  SessionTranscriptContext,
} from "../../auto-reply/templating.js";
import type { ContextVisibilityMode } from "../../config/types.base.js";
import type { PluginHookChannelContext } from "../../plugins/hook-channel-context.types.js";
import { shouldIncludeSupplementalContext } from "../../security/context-visibility.js";
import type { InboundImplicitMentionKind } from "../mention-gating.js";
import type { ChannelIngressCommandAccess } from "../message-access/runtime-types.js";
import type {
  CommandFacts,
  ConversationFacts,
  InboundMediaFacts,
  MessageFacts,
  ReplyPlanFacts,
  RouteFacts,
  SenderFacts,
  SupplementalContextFacts,
} from "../turn/types.js";
import type { InboundEventKind } from "./kind.js";
import { buildChannelInboundMediaPayload } from "./media.js";

type MaybePromise<T> = T | Promise<T>;
type ChannelInboundSupplementalMediaResolver = () => MaybePromise<
  readonly InboundMediaFacts[] | null | undefined
>;
type ChannelInboundSupplementalQuoteFacts = NonNullable<SupplementalContextFacts["quote"]> & {
  isSelf?: boolean;
  media?: readonly InboundMediaFacts[] | ChannelInboundSupplementalMediaResolver;
};
type ChannelInboundSupplementalFacts = Omit<SupplementalContextFacts, "quote"> & {
  quote?: ChannelInboundSupplementalQuoteFacts;
};
/**
 * @deprecated Prefer passing `resolveSupplementalMedia: true` directly to
 * `buildChannelInboundEventContext` without naming this compatibility type.
 */
export type ChannelInboundSupplementalResolutionOptions = {
  resolveSupplementalMedia: true;
  suppressSelfQuoteBody?: boolean;
  suppressSelfQuoteMedia?: boolean;
};
type BuildChannelInboundEventAccess = {
  commands?: Pick<ChannelIngressCommandAccess, "authorized">;
  mentions?: {
    canDetectMention: boolean;
    wasMentioned: boolean;
    hasAnyMention?: boolean;
    explicitlyMentionedBot?: boolean;
    mentionedUserIds?: string[];
    mentionedSubteamIds?: string[];
    mentionSource?: MentionSource;
    implicitMentionKinds?: InboundImplicitMentionKind[];
    requireMention?: boolean;
    effectiveWasMentioned?: boolean;
  };
};

export type BuildChannelInboundEventContextParams = {
  channel: string;
  accountId?: string;
  provider?: string;
  surface?: string;
  messageId?: string;
  messageIdFull?: string;
  timestamp?: number;
  from: string;
  sender: SenderFacts;
  conversation: ConversationFacts;
  route: RouteFacts;
  reply: ReplyPlanFacts;
  message: MessageFacts;
  sessionTranscript?: SessionTranscriptContext;
  access?: BuildChannelInboundEventAccess;
  command?: CommandFacts;
  commandTurn?: CommandTurnContext;
  media?: InboundMediaFacts[];
  supplemental?: ChannelInboundSupplementalFacts;
  channelContext?: PluginHookChannelContext;
  contextVisibility?: ContextVisibilityMode;
  finalize?: FinalizeInboundContextFn;
  finalizeOptions?: FinalizeInboundContextOptions;
  extra?: Record<string, unknown>;
};
/**
 * @deprecated Prefer `BuildChannelInboundEventContextParams` with
 * `resolveSupplementalMedia: true` at call sites that need lazy quote media.
 */
export type BuildChannelInboundEventContextAsyncParams = BuildChannelInboundEventContextParams &
  ChannelInboundSupplementalResolutionOptions;

type UntrustedStructuredContextEntries = NonNullable<
  FinalizedMsgContext["UntrustedStructuredContext"]
>;

export type BuiltChannelInboundEventContext = FinalizedMsgContext & {
  Body: string;
  BodyForAgent: string;
  BodyForCommands: string;
  ChatType: ConversationFacts["kind"];
  CommandAuthorized: boolean;
  CommandBody: string;
  From: string;
  RawBody: string;
  SessionKey: string;
  To: string;
  InboundEventKind: InboundEventKind;
};
type FinalizeInboundContextFn = (
  ctx: Record<string, unknown>,
  opts?: FinalizeInboundContextOptions,
) => unknown;

/**
 * @deprecated Used by deprecated `finalizeChannelInboundContext`; new channel
 * code should pass facts to `buildChannelInboundEventContext`.
 */
export type FinalizeChannelInboundContextParams<T extends Record<string, unknown>> = {
  context: T;
  supplemental?: SupplementalContextFacts | ChannelInboundSupplementalFacts;
  contextVisibility?: ContextVisibilityMode;
  media?: readonly InboundMediaFacts[];
  finalize?: FinalizeInboundContextFn;
  finalizeOptions?: FinalizeInboundContextOptions;
};
/**
 * @deprecated Prefer `FinalizeChannelInboundContextParams<T>` with
 * `resolveSupplementalMedia: true` when lazy quote media must be resolved.
 */
export type FinalizeChannelInboundContextAsyncParams<T extends Record<string, unknown>> =
  FinalizeChannelInboundContextParams<T> & { resolveSupplementalMedia: true } & Pick<
      ChannelInboundSupplementalResolutionOptions,
      "suppressSelfQuoteBody" | "suppressSelfQuoteMedia"
    >;

/**
 * @deprecated Result type for deprecated `finalizeChannelInboundContext`.
 */
export type FinalizeChannelInboundContextResult<T extends Record<string, unknown>> = {
  context: T & FinalizedMsgContext;
  supplemental?: SupplementalContextFacts;
  quoteHidden: boolean;
  forwardedHidden: boolean;
  threadHidden: boolean;
};

function keepSupplementalContext(params: {
  mode?: ContextVisibilityMode;
  kind: "quote" | "forwarded" | "thread";
  senderAllowed?: boolean;
}): boolean {
  if (!params.mode || params.mode === "all") {
    return true;
  }
  if (params.senderAllowed === undefined) {
    return false;
  }
  return shouldIncludeSupplementalContext({
    mode: params.mode,
    kind: params.kind,
    senderAllowed: params.senderAllowed,
  });
}

export function filterChannelInboundSupplementalContext(params: {
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
}): SupplementalContextFacts | undefined {
  const supplemental = params.supplemental;
  if (!supplemental) {
    return undefined;
  }
  const quote = keepSupplementalContext({
    mode: params.contextVisibility,
    kind: "quote",
    senderAllowed: supplemental.quote?.senderAllowed,
  })
    ? supplemental.quote
    : undefined;
  const forwarded = keepSupplementalContext({
    mode: params.contextVisibility,
    kind: "forwarded",
    senderAllowed: supplemental.forwarded?.senderAllowed,
  })
    ? supplemental.forwarded
    : undefined;
  const thread = keepSupplementalContext({
    mode: params.contextVisibility,
    kind: "thread",
    senderAllowed: supplemental.thread?.senderAllowed,
  })
    ? supplemental.thread
    : undefined;

  return {
    ...supplemental,
    quote,
    forwarded,
    thread,
  };
}

/** Resolves whether a supplemental-context sender passes the active group policy. */
export function resolveInboundSupplementalSenderAllowed<TAllowFrom>(params: {
  isGroup: boolean;
  groupPolicy: string;
  allowFrom: readonly TAllowFrom[];
  isSenderAllowed: (allowFrom: readonly TAllowFrom[]) => boolean;
}): boolean {
  if (!params.isGroup || params.groupPolicy !== "allowlist") {
    return true;
  }
  return params.isSenderAllowed(params.allowFrom);
}

export function filterChannelInboundQuoteContext(
  contextVisibility: ContextVisibilityMode | undefined,
  quote: SupplementalContextFacts["quote"] | undefined,
): SupplementalContextFacts["quote"] | undefined {
  return filterChannelInboundSupplementalContext({
    contextVisibility,
    supplemental: quote ? { quote } : undefined,
  })?.quote;
}

function definedFields<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, Exclude<unknown, undefined>] => entry[1] !== undefined,
    ),
  ) as Partial<T>;
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === "function";
}

function stripQuoteRuntimeFields(
  quote: ChannelInboundSupplementalQuoteFacts,
): NonNullable<SupplementalContextFacts["quote"]> {
  const { media: _media, isSelf: _isSelf, ...stripped } = quote;
  return stripped;
}

function resolveChannelInboundSupplementalForFinalizer(params: {
  supplemental?: SupplementalContextFacts | ChannelInboundSupplementalFacts;
  contextVisibility?: ContextVisibilityMode;
  media?: readonly InboundMediaFacts[];
  resolveSupplementalMedia?: true;
  suppressSelfQuoteBody?: boolean;
  suppressSelfQuoteMedia?: boolean;
}): MaybePromise<{
  rawSupplemental?: SupplementalContextFacts | ChannelInboundSupplementalFacts;
  supplemental?: SupplementalContextFacts;
  media?: readonly InboundMediaFacts[];
}> {
  const rawSupplemental = params.supplemental;
  const filtered = filterChannelInboundSupplementalContext({
    supplemental: rawSupplemental,
    contextVisibility: params.contextVisibility,
  });
  const media = [...(params.media ?? [])];
  if (!rawSupplemental?.quote || !filtered?.quote) {
    return { rawSupplemental, supplemental: filtered, media };
  }

  const quote = filtered.quote as ChannelInboundSupplementalQuoteFacts;
  const selfQuote = quote.isSelf === true;
  const suppressSelfQuoteBody = params.suppressSelfQuoteBody ?? true;
  const suppressSelfQuoteMedia = params.suppressSelfQuoteMedia ?? true;
  const finalizeQuote = (quoteMedia?: readonly InboundMediaFacts[] | null) => {
    if (!(selfQuote && suppressSelfQuoteMedia)) {
      media.push(...(quoteMedia ?? []));
    }
    const stripped = stripQuoteRuntimeFields(quote);
    const visibleQuote =
      selfQuote && suppressSelfQuoteBody
        ? (({ body: _body, ...withoutBody }) => withoutBody)(stripped)
        : stripped;
    return {
      rawSupplemental,
      supplemental: {
        ...filtered,
        quote: visibleQuote,
      },
      media,
    };
  };

  if (selfQuote && suppressSelfQuoteMedia) {
    return finalizeQuote(undefined);
  }
  if (!params.resolveSupplementalMedia) {
    return finalizeQuote(Array.isArray(quote.media) ? quote.media : undefined);
  }
  if (typeof quote.media !== "function") {
    return finalizeQuote(quote.media);
  }
  const resolved = quote.media();
  return isPromiseLike(resolved) ? resolved.then(finalizeQuote) : finalizeQuote(resolved);
}

/**
 * @deprecated Prefer `buildChannelInboundEventContext({ resolveSupplementalMedia: true })`
 * for channel inbound payloads.
 */
export async function resolveChannelInboundSupplementalContext(params: {
  supplemental?: ChannelInboundSupplementalFacts;
  contextVisibility?: ContextVisibilityMode;
  media?: readonly InboundMediaFacts[];
  suppressSelfQuoteBody?: boolean;
  suppressSelfQuoteMedia?: boolean;
}): Promise<{
  supplemental?: SupplementalContextFacts;
  media: InboundMediaFacts[];
  quoteHidden: boolean;
}> {
  const resolved = await resolveChannelInboundSupplementalForFinalizer({
    ...params,
    resolveSupplementalMedia: true,
  });
  return {
    supplemental: resolved.supplemental,
    media: [...(resolved.media ?? [])],
    quoteHidden: Boolean(resolved.rawSupplemental?.quote && !resolved.supplemental?.quote),
  };
}

function finalizePreparedChannelInboundContext<T extends Record<string, unknown>>(params: {
  originalContext: T;
  rawSupplemental?: SupplementalContextFacts | ChannelInboundSupplementalFacts;
  supplemental?: SupplementalContextFacts;
  media?: readonly InboundMediaFacts[];
  finalize?: FinalizeInboundContextFn;
  finalizeOptions?: FinalizeInboundContextOptions;
}): FinalizeChannelInboundContextResult<T> {
  const mediaPayload = params.media
    ? definedFields(buildChannelInboundMediaPayload([...params.media]))
    : {};
  const baseContext = {
    ...params.originalContext,
    SupplementalContext: params.supplemental,
    ...(params.media ? { media: [...params.media] } : {}),
    ...mediaPayload,
  };
  const untrustedStructuredContext = resolveUntrustedStructuredContext({
    supplemental: params.supplemental,
    extra: baseContext,
  });
  const finalize = params.finalize ?? finalizeCoreInboundContext;
  const context = finalize(
    {
      ...baseContext,
      UntrustedStructuredContext: untrustedStructuredContext,
    },
    params.finalizeOptions,
  ) as T & FinalizedMsgContext;
  return {
    context,
    supplemental: params.supplemental,
    quoteHidden: Boolean(params.rawSupplemental?.quote && !params.supplemental?.quote),
    forwardedHidden: Boolean(params.rawSupplemental?.forwarded && !params.supplemental?.forwarded),
    threadHidden: Boolean(params.rawSupplemental?.thread && !params.supplemental?.thread),
  };
}

function finalizeChannelInboundContextValue<T extends Record<string, unknown>>(
  params: FinalizeChannelInboundContextParams<T> &
    Partial<ChannelInboundSupplementalResolutionOptions>,
): MaybePromise<FinalizeChannelInboundContextResult<T>> {
  const contextSupplemental = (params.context as { SupplementalContext?: SupplementalContextFacts })
    .SupplementalContext;
  const prepared = resolveChannelInboundSupplementalForFinalizer({
    supplemental: params.supplemental ?? contextSupplemental,
    contextVisibility: params.contextVisibility,
    media: params.media,
    resolveSupplementalMedia: params.resolveSupplementalMedia,
    suppressSelfQuoteBody: params.suppressSelfQuoteBody,
    suppressSelfQuoteMedia: params.suppressSelfQuoteMedia,
  });
  const finish = (result: Awaited<typeof prepared>) =>
    finalizePreparedChannelInboundContext({
      originalContext: params.context,
      finalize: params.finalize,
      finalizeOptions: params.finalizeOptions,
      ...result,
    });
  if (params.resolveSupplementalMedia) {
    return Promise.resolve(prepared).then(finish);
  }
  return isPromiseLike(prepared) ? prepared.then(finish) : finish(prepared);
}

/**
 * @deprecated Public compatibility for callers that already prepared legacy
 * prompt fields. New channel code should use `buildChannelInboundEventContext`.
 */
export function finalizeChannelInboundContext<T extends Record<string, unknown>>(
  params: FinalizeChannelInboundContextAsyncParams<T>,
): Promise<FinalizeChannelInboundContextResult<T>>;
export function finalizeChannelInboundContext<T extends Record<string, unknown>>(
  params: FinalizeChannelInboundContextParams<T>,
): FinalizeChannelInboundContextResult<T>;
export function finalizeChannelInboundContext<T extends Record<string, unknown>>(
  params: FinalizeChannelInboundContextParams<T> &
    Partial<ChannelInboundSupplementalResolutionOptions>,
): MaybePromise<FinalizeChannelInboundContextResult<T>> {
  return finalizeChannelInboundContextValue(params);
}

function resolveIngressCommandAuthorized(
  access: BuildChannelInboundEventAccess | undefined,
): boolean | undefined {
  return access?.commands?.authorized;
}

function normalizeUntrustedGroupPrompt(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = sanitizeInboundSystemTags(normalizeInboundTextNewlines(value));
  return normalized.trim().length > 0 ? normalized : undefined;
}

function resolveUntrustedStructuredContext(params: {
  supplemental?: SupplementalContextFacts;
  extra?: Record<string, unknown>;
}): UntrustedStructuredContextEntries | undefined {
  const entries: UntrustedStructuredContextEntries = [];
  const extraEntries = params.extra?.UntrustedStructuredContext;
  if (Array.isArray(extraEntries)) {
    entries.push(...(extraEntries as UntrustedStructuredContextEntries));
  }
  entries.push(...(params.supplemental?.untrustedContext ?? []));

  // User-controlled group prompt metadata must stay out of GroupSystemPrompt.
  // Keeping it with untrusted context prevents spoofed system markers from gaining prompt authority.
  const groupPrompt = normalizeUntrustedGroupPrompt(
    params.supplemental?.untrustedGroupSystemPrompt,
  );
  if (groupPrompt) {
    entries.push({
      label: "Group prompt context",
      type: "group_prompt_context",
      payload: { text: groupPrompt },
    });
  }

  return entries.length > 0 ? entries : undefined;
}

function resolveChannelCommandContext(params: {
  command?: CommandFacts;
  commandTurn?: CommandTurnContext;
  message: MessageFacts;
  access?: BuildChannelInboundEventAccess;
}): CommandTurnContext | undefined {
  if (params.commandTurn) {
    return params.commandTurn;
  }
  const command = params.command;
  if (!command) {
    return undefined;
  }
  const body = command.body ?? params.message.commandBody ?? params.message.rawBody;
  return createCommandTurnContext(commandTurnKindToSource(command.kind), {
    authorized:
      command.kind === "normal"
        ? false
        : (command.authorized ?? resolveIngressCommandAuthorized(params.access) === true),
    commandName: command.name,
    body,
  });
}

export function buildChannelInboundEventContext(
  params: BuildChannelInboundEventContextAsyncParams,
): Promise<BuiltChannelInboundEventContext>;
export function buildChannelInboundEventContext(
  params: BuildChannelInboundEventContextParams,
): BuiltChannelInboundEventContext;
export function buildChannelInboundEventContext(
  params: BuildChannelInboundEventContextParams &
    Partial<ChannelInboundSupplementalResolutionOptions>,
): MaybePromise<BuiltChannelInboundEventContext> {
  const body = params.message.body ?? params.message.rawBody;
  const commandTurn = resolveChannelCommandContext({
    command: params.command,
    commandTurn: params.commandTurn,
    message: params.message,
    access: params.access,
  });

  const context = {
    Body: body,
    InboundEventKind: params.message.inboundEventKind ?? "user_request",
    BodyForAgent: params.message.bodyForAgent ?? params.message.rawBody,
    InboundHistory: params.message.inboundHistory,
    SessionTranscriptContext:
      params.sessionTranscript && params.sessionTranscript.historyLimit > 0
        ? params.sessionTranscript
        : undefined,
    SourceModality: params.message.sourceModality,
    RawBody: params.message.rawBody,
    CommandBody: params.message.commandBody ?? params.message.rawBody,
    BodyForCommands: params.message.commandBody ?? params.message.rawBody,
    From: params.from,
    To: params.reply.to,
    SessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
    AgentId: params.route.agentId,
    DmScope: params.route.dmScope,
    AccountId: params.route.accountId ?? params.accountId,
    ParentSessionKey: params.route.parentSessionKey,
    ModelParentSessionKey: params.route.modelParentSessionKey,
    MessageSid: params.messageId,
    MessageSidFull: params.messageIdFull,
    ReplyToId: params.reply.replyToId,
    ReplyToIdFull: params.reply.replyToIdFull,
    ChatType: params.conversation.kind,
    ChatId: params.conversation.id,
    ConversationLabel: params.conversation.label,
    GroupSubject: params.conversation.kind !== "direct" ? params.conversation.label : undefined,
    GroupSpace: params.conversation.spaceId,
    SenderName: params.sender.name ?? params.sender.displayLabel,
    SenderId: params.sender.id,
    SenderUsername: params.sender.username,
    SenderTag: params.sender.tag,
    SenderIsBot: params.sender.isBot,
    MemberRoleIds: params.sender.roles,
    Timestamp: params.timestamp,
    Provider: params.provider ?? params.channel,
    Surface: params.surface ?? params.provider ?? params.channel,
    WasMentioned: params.access?.mentions?.wasMentioned,
    GroupRequireMention: params.access?.mentions?.requireMention,
    ExplicitlyMentionedBot: params.access?.mentions?.explicitlyMentionedBot,
    MentionedUserIds: params.access?.mentions?.mentionedUserIds,
    MentionedSubteamIds: params.access?.mentions?.mentionedSubteamIds,
    ImplicitMentionKinds: params.access?.mentions?.implicitMentionKinds,
    MentionSource: params.access?.mentions?.mentionSource,
    CommandAuthorized: resolveIngressCommandAuthorized(params.access) === true,
    CommandTurn: commandTurn,
    MessageThreadId: params.reply.messageThreadId ?? params.conversation.threadId,
    NativeChannelId: params.reply.nativeChannelId ?? params.conversation.nativeChannelId,
    ChannelContext: params.channelContext,
    OriginatingChannel: params.channel,
    OriginatingTo: params.reply.originatingTo ?? params.reply.to,
    ThreadParentId: params.reply.threadParentId ?? params.conversation.parentId,
    // This builder is the post-admission boundary for channel events. Preserve
    // that fact so interceptors cannot bypass sender, route, or pairing gates.
    InboundAccessAuthorized: true,
    ...params.extra,
  };
  const finalizeParams = {
    finalize: params.finalize,
    finalizeOptions: params.finalizeOptions,
    supplemental: params.supplemental,
    contextVisibility: params.contextVisibility,
    media: params.media,
    context,
  };
  const result = params.resolveSupplementalMedia
    ? finalizeChannelInboundContextValue({
        ...finalizeParams,
        resolveSupplementalMedia: true,
        suppressSelfQuoteBody: params.suppressSelfQuoteBody,
        suppressSelfQuoteMedia: params.suppressSelfQuoteMedia,
      })
    : finalizeChannelInboundContextValue(finalizeParams);
  return isPromiseLike(result)
    ? result.then((finalized) => finalized.context as BuiltChannelInboundEventContext)
    : (result.context as BuiltChannelInboundEventContext);
}
