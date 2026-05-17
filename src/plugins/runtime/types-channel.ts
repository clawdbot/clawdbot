/**
 * Runtime helpers for native channel plugins.
 *
 * This surface exposes generic core helpers only. Plugin-owned behavior stays
 * inside the owning plugin package instead of hanging off core runtime slots
 * keyed by plugin id.
 */
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import type { CreateReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.runtime-types.js";
import type {
  ReadChannelAllowFromStoreForAccount,
  UpsertChannelPairingRequestForAccount,
} from "../../pairing/pairing-store.types.js";
type ShouldHandleTextCommands =
  import("../../auto-reply/commands-registry.runtime-types.js").ShouldHandleTextCommands;
type IsControlCommandMessage =
  import("../../auto-reply/command-detection.runtime-types.js").IsControlCommandMessage;
type ShouldComputeCommandAuthorized =
  import("../../auto-reply/command-detection.runtime-types.js").ShouldComputeCommandAuthorized;
type BuildMentionRegexes = import("../../auto-reply/reply/mentions.types.js").BuildMentionRegexes;
type MatchesMentionPatterns =
  import("../../auto-reply/reply/mentions.types.js").MatchesMentionPatterns;
type MatchesMentionWithExplicit =
  import("../../auto-reply/reply/mentions.types.js").MatchesMentionWithExplicit;
type ReadSessionUpdatedAt = import("../../config/sessions/runtime-types.js").ReadSessionUpdatedAt;
type RecordSessionMetaFromInbound =
  import("../../config/sessions/runtime-types.js").RecordSessionMetaFromInbound;
type UpdateLastRoute = import("../../config/sessions/runtime-types.js").UpdateLastRoute;
type RecordInboundSession = import("../../channels/session.types.js").RecordInboundSession;

export type RuntimeThreadBindingLifecycleRecord =
  | import("../../infra/outbound/session-binding.types.js").SessionBindingRecord
  | {
      boundAt: number;
      lastActivityAt: number;
      idleTimeoutMs?: number;
      maxAgeMs?: number;
    };

export type PluginRuntimeChannelContextKey = {
  channelId: string;
  accountId?: string | null;
  capability: string;
};

export type PluginRuntimeChannelContextEvent = {
  type: "registered" | "unregistered";
  key: {
    channelId: string;
    accountId?: string;
    capability: string;
  };
  context?: unknown;
};

export type PluginRuntimeChannelContextRegistry = {
  register: (
    params: PluginRuntimeChannelContextKey & {
      context: unknown;
      abortSignal?: AbortSignal;
    },
  ) => { dispose: () => void };
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Runtime context values are caller-typed by key.
  get: <T = unknown>(params: PluginRuntimeChannelContextKey) => T | undefined;
  watch: (params: {
    channelId?: string;
    accountId?: string | null;
    capability?: string;
    onEvent: (event: PluginRuntimeChannelContextEvent) => void;
  }) => () => void;
};

export type PluginRuntimeChannel = {
  text: {
    chunkByNewline: typeof import("../../auto-reply/chunk.js").chunkByNewline;
    chunkMarkdownText: typeof import("../../auto-reply/chunk.js").chunkMarkdownText;
    chunkMarkdownTextWithMode: typeof import("../../auto-reply/chunk.js").chunkMarkdownTextWithMode;
    chunkText: typeof import("../../auto-reply/chunk.js").chunkText;
    chunkTextWithMode: typeof import("../../auto-reply/chunk.js").chunkTextWithMode;
    resolveChunkMode: typeof import("../../auto-reply/chunk.js").resolveChunkMode;
    resolveTextChunkLimit: typeof import("../../auto-reply/chunk.js").resolveTextChunkLimit;
    hasControlCommand: typeof import("../../auto-reply/command-detection.js").hasControlCommand;
    resolveMarkdownTableMode: import("../../config/markdown-tables.types.js").ResolveMarkdownTableMode;
    convertMarkdownTables: typeof import("../../markdown/tables.js").convertMarkdownTables;
  };
  reply: {
    dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
    /**
     * @deprecated Prefer `openclaw/plugin-sdk/channel-message` adapters plus
     * `dispatchReplyWithBufferedBlockDispatcher` or channel turn helpers.
     * This is a low-level legacy dispatcher escape hatch.
     */
    createReplyDispatcherWithTyping: CreateReplyDispatcherWithTyping;
    resolveEffectiveMessagesConfig: typeof import("../../agents/identity.js").resolveEffectiveMessagesConfig;
    /**
     * @deprecated Prefer the channel-message reply pipeline helpers. This is
     * tied to the low-level legacy dispatcher path.
     */
    resolveHumanDelayConfig: typeof import("../../agents/identity.js").resolveHumanDelayConfig;
    /**
     * @deprecated Prefer `dispatchReplyWithBufferedBlockDispatcher` with a
     * channel-message adapter or the channel turn helpers. Direct use must
     * manually preserve source reply delivery metadata such as
     * `sourceReplyDeliveryMode`.
     */
    dispatchReplyFromConfig: import("../../auto-reply/reply/dispatch-from-config.types.js").DispatchReplyFromConfig;
    withReplyDispatcher: typeof import("../../auto-reply/dispatch-dispatcher.js").withReplyDispatcher;
    settleReplyDispatcher: typeof import("../../auto-reply/dispatch-dispatcher.js").settleReplyDispatcher;
    /**
     * @deprecated Prefer `buildChannelInboundEventContext` /
     * `buildChannelTurnContext` from `openclaw/plugin-sdk/channel-inbound` so
     * inbound event metadata is carried into reply dispatch.
     */
    finalizeInboundContext: typeof import("../../auto-reply/reply/inbound-context.js").finalizeInboundContext;
    formatAgentEnvelope: typeof import("../../auto-reply/envelope.js").formatAgentEnvelope;
    /** @deprecated Prefer `BodyForAgent` + structured user-context blocks (do not build plaintext envelopes for prompts). */
    formatInboundEnvelope: typeof import("../../auto-reply/envelope.js").formatInboundEnvelope;
    resolveEnvelopeFormatOptions: typeof import("../../auto-reply/envelope.js").resolveEnvelopeFormatOptions;
  };
  routing: {
    buildAgentSessionKey: typeof import("../../routing/resolve-route.js").buildAgentSessionKey;
    resolveAgentRoute: typeof import("../../routing/resolve-route.js").resolveAgentRoute;
  };
  pairing: {
    buildPairingReply: typeof import("../../pairing/pairing-messages.js").buildPairingReply;
    readAllowFromStore: ReadChannelAllowFromStoreForAccount;
    upsertPairingRequest: UpsertChannelPairingRequestForAccount;
  };
  media: {
    readRemoteMediaBuffer: typeof import("../../media/fetch.js").readRemoteMediaBuffer;
    /** @deprecated Use `readRemoteMediaBuffer`. */
    fetchRemoteMedia: typeof import("../../media/fetch.js").fetchRemoteMedia;
    saveRemoteMedia: typeof import("../../media/fetch.js").saveRemoteMedia;
    saveResponseMedia: typeof import("../../media/fetch.js").saveResponseMedia;
    saveMediaBuffer: typeof import("../../media/store.js").saveMediaBuffer;
  };
  activity: {
    record: typeof import("../../infra/channel-activity.js").recordChannelActivity;
    get: typeof import("../../infra/channel-activity.js").getChannelActivity;
  };
  session: {
    /** @deprecated Prefer channel turn helpers that record inbound sessions as part of dispatch. */
    resolveStorePath: typeof import("../../config/sessions/paths.js").resolveStorePath;
    readSessionUpdatedAt: ReadSessionUpdatedAt;
    recordSessionMetaFromInbound: RecordSessionMetaFromInbound;
    /** @deprecated Prefer channel turn helpers that record inbound sessions as part of dispatch. */
    recordInboundSession: RecordInboundSession;
    updateLastRoute: UpdateLastRoute;
  };
  mentions: {
    buildMentionRegexes: BuildMentionRegexes;
    matchesMentionPatterns: MatchesMentionPatterns;
    matchesMentionWithExplicit: MatchesMentionWithExplicit;
    implicitMentionKindWhen: typeof import("../../channels/mention-gating.js").implicitMentionKindWhen;
    resolveInboundMentionDecision: typeof import("../../channels/mention-gating.js").resolveInboundMentionDecision;
  };
  reactions: {
    createAckReactionHandle: typeof import("../../channels/ack-reactions.js").createAckReactionHandle;
    shouldAckReaction: typeof import("../../channels/ack-reactions.js").shouldAckReaction;
    removeAckReactionAfterReply: typeof import("../../channels/ack-reactions.js").removeAckReactionAfterReply;
    removeAckReactionHandleAfterReply: typeof import("../../channels/ack-reactions.js").removeAckReactionHandleAfterReply;
  };
  groups: {
    resolveGroupPolicy: typeof import("../../config/group-policy.js").resolveChannelGroupPolicy;
    resolveRequireMention: typeof import("../../config/group-policy.js").resolveChannelGroupRequireMention;
  };
  debounce: {
    createInboundDebouncer: typeof import("../../auto-reply/inbound-debounce.js").createInboundDebouncer;
    resolveInboundDebounceMs: typeof import("../../auto-reply/inbound-debounce.js").resolveInboundDebounceMs;
  };
  commands: {
    resolveCommandAuthorizedFromAuthorizers: typeof import("../../channels/command-gating.js").resolveCommandAuthorizedFromAuthorizers;
    isControlCommandMessage: IsControlCommandMessage;
    shouldComputeCommandAuthorized: ShouldComputeCommandAuthorized;
    shouldHandleTextCommands: ShouldHandleTextCommands;
  };
  outbound: {
    loadAdapter: import("../../channels/plugins/outbound/load.types.js").LoadChannelOutboundAdapter;
  };
  turn: {
    run: typeof import("../../channels/turn/kernel.js").runChannelTurn;
    runAssembled: typeof import("../../channels/turn/kernel.js").dispatchAssembledChannelTurn;
    /** @deprecated Prefer `run(...)`. */
    runResolved: typeof import("../../channels/turn/kernel.js").runResolvedChannelTurn;
    buildContext: typeof import("../../channels/turn/kernel.js").buildChannelInboundEventContext;
    runPrepared: typeof import("../../channels/turn/kernel.js").runPreparedChannelTurn;
    /** @deprecated Prefer `runAssembled(...)`. */
    dispatchAssembled: typeof import("../../channels/turn/kernel.js").dispatchAssembledChannelTurn;
  };
  threadBindings: {
    setIdleTimeoutBySessionKey: (params: {
      channelId: string;
      targetSessionKey: string;
      accountId?: string;
      idleTimeoutMs: number;
    }) => RuntimeThreadBindingLifecycleRecord[];
    setMaxAgeBySessionKey: (params: {
      channelId: string;
      targetSessionKey: string;
      accountId?: string;
      maxAgeMs: number;
    }) => RuntimeThreadBindingLifecycleRecord[];
  };
  runtimeContexts: PluginRuntimeChannelContextRegistry;
};
