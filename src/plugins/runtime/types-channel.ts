/**
 * Runtime helpers for native channel plugins.
 *
 * This surface exposes generic core helpers only. Plugin-owned behavior stays
 * inside the owning plugin package instead of hanging off core runtime slots
 * keyed by plugin id.
 */
import type {
  IsControlCommandMessage,
  ShouldComputeCommandAuthorized,
} from "../../auto-reply/command-detection.runtime-types.js";
import type { ShouldHandleTextCommands } from "../../auto-reply/commands-registry.runtime-types.js";
import type { DispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.types.js";
import type {
  BuildMentionRegexes,
  MatchesMentionPatterns,
  MatchesMentionWithExplicit,
} from "../../auto-reply/reply/mentions.types.js";
import type { CreateReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.runtime-types.js";
import type { LoadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.types.js";
import type { ResolveMarkdownTableMode } from "../../config/markdown-tables.types.js";
import type {
  ReadSessionUpdatedAt,
  RecordSessionMetaFromInbound,
  UpdateLastRoute,
} from "../../config/sessions/runtime-types.js";
import type {
  ReadChannelAllowFromStoreForAccount,
  RemoveChannelAllowFromStoreEntryForAccount,
  UpsertChannelPairingRequestForAccount,
} from "../../pairing/pairing-store.types.js";

type DispatchReplyWithBufferedBlockDispatcher =
  import("../../auto-reply/reply/provider-dispatcher.types.js").DispatchReplyWithBufferedBlockDispatcher;
type RecordInboundSession = import("../../channels/session.types.js").RecordInboundSession;

type RuntimeThreadBindingLifecycleRecord =
  | import("../../infra/outbound/session-binding.types.js").SessionBindingRecord
  | {
      boundAt: number;
      lastActivityAt: number;
      idleTimeoutMs?: number;
      maxAgeMs?: number;
    };

type PluginRuntimeChannelContextKey = {
  channelId: string;
  accountId?: string | null;
  capability: string;
};

type PluginRuntimeChannelContextEvent = {
  type: "registered" | "unregistered";
  key: {
    channelId: string;
    accountId?: string;
    capability: string;
  };
  context?: unknown;
};

type PluginRuntimeChannelContextRegistry = {
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
    resolveMarkdownTableMode: ResolveMarkdownTableMode;
    convertMarkdownTables: typeof import("../../../packages/markdown-core/src/tables.js").convertMarkdownTables;
  };
  reply: {
    dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
    /**
     * @deprecated Prefer `openclaw/plugin-sdk/channel-outbound` adapters plus
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
    dispatchReplyFromConfig: DispatchReplyFromConfig;
    withReplyDispatcher: typeof import("../../auto-reply/dispatch-dispatcher.js").withReplyDispatcher;
    settleReplyDispatcher: typeof import("../../auto-reply/dispatch-dispatcher.js").settleReplyDispatcher;
    /**
     * @deprecated Prefer `buildChannelInboundEventContext` from
     * `openclaw/plugin-sdk/channel-inbound` so inbound event metadata is
     * carried into reply dispatch.
     */
    finalizeInboundContext: typeof import("../../auto-reply/reply/inbound-context.js").finalizeInboundContext;
    formatAgentEnvelope: typeof import("../../auto-reply/envelope.js").formatAgentEnvelope;
    resolveEnvelopeFormatOptions: typeof import("../../auto-reply/envelope.js").resolveEnvelopeFormatOptions;
  };
  routing: {
    buildAgentSessionKey: typeof import("../../routing/resolve-route.js").buildAgentSessionKey;
    resolveAgentRoute: typeof import("../../routing/resolve-route.js").resolveAgentRoute;
  };
  pairing: {
    buildPairingReply: typeof import("../../pairing/pairing-messages.js").buildPairingReply;
    readAllowFromStore: ReadChannelAllowFromStoreForAccount;
    removeAllowFromStoreEntry: RemoveChannelAllowFromStoreEntryForAccount;
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
    loadAdapter: LoadChannelOutboundAdapter;
  };
  inbound: {
    buildContext: typeof import("../../channels/inbound-event/context.js").buildChannelInboundEventContext;
    run: typeof import("../../channels/turn/kernel.js").runChannelInboundEvent;
    /** @deprecated Prefer `run` for raw inbound events or `dispatchReply` for assembled contexts. */
    runPreparedReply: typeof import("../../channels/turn/kernel.js").runPreparedInboundReply;
    dispatch: typeof import("../../channels/turn/kernel.js").dispatchChannelInboundTurn;
    /** Compatibility escape hatch; prefer `dispatch`, which keeps session wiring in core. */
    dispatchReply: typeof import("../../channels/turn/kernel.js").dispatchChannelInboundReply;
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
