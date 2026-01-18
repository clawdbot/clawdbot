import type { LogLevel } from "../../logging/levels.js";

type ShouldLogVerbose = typeof import("../../globals.js").shouldLogVerbose;
type DispatchReplyWithBufferedBlockDispatcher =
  typeof import("../../auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;
type CreateReplyDispatcherWithTyping =
  typeof import("../../auto-reply/reply/reply-dispatcher.js").createReplyDispatcherWithTyping;
type ResolveEffectiveMessagesConfig =
  typeof import("../../agents/identity.js").resolveEffectiveMessagesConfig;
type ResolveHumanDelayConfig = typeof import("../../agents/identity.js").resolveHumanDelayConfig;
type ResolveAgentRoute = typeof import("../../routing/resolve-route.js").resolveAgentRoute;
type BuildPairingReply = typeof import("../../pairing/pairing-messages.js").buildPairingReply;
type ReadChannelAllowFromStore =
  typeof import("../../pairing/pairing-store.js").readChannelAllowFromStore;
type UpsertChannelPairingRequest =
  typeof import("../../pairing/pairing-store.js").upsertChannelPairingRequest;
type FetchRemoteMedia = typeof import("../../media/fetch.js").fetchRemoteMedia;
type SaveMediaBuffer = typeof import("../../media/store.js").saveMediaBuffer;
type BuildMentionRegexes = typeof import("../../auto-reply/reply/mentions.js").buildMentionRegexes;
type MatchesMentionPatterns =
  typeof import("../../auto-reply/reply/mentions.js").matchesMentionPatterns;
type ResolveChannelGroupPolicy =
  typeof import("../../config/group-policy.js").resolveChannelGroupPolicy;
type ResolveChannelGroupRequireMention =
  typeof import("../../config/group-policy.js").resolveChannelGroupRequireMention;
type CreateInboundDebouncer =
  typeof import("../../auto-reply/inbound-debounce.js").createInboundDebouncer;
type ResolveInboundDebounceMs =
  typeof import("../../auto-reply/inbound-debounce.js").resolveInboundDebounceMs;
type ResolveCommandAuthorizedFromAuthorizers =
  typeof import("../../channels/command-gating.js").resolveCommandAuthorizedFromAuthorizers;
type ResolveTextChunkLimit = typeof import("../../auto-reply/chunk.js").resolveTextChunkLimit;
type ChunkMarkdownText = typeof import("../../auto-reply/chunk.js").chunkMarkdownText;
type HasControlCommand = typeof import("../../auto-reply/command-detection.js").hasControlCommand;
type ResolveStateDir = typeof import("../../config/paths.js").resolveStateDir;

export type RuntimeLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type PluginRuntime = {
  version: string;
  channel: {
    text: {
      chunkMarkdownText: ChunkMarkdownText;
      resolveTextChunkLimit: ResolveTextChunkLimit;
      hasControlCommand: HasControlCommand;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
      createReplyDispatcherWithTyping: CreateReplyDispatcherWithTyping;
      resolveEffectiveMessagesConfig: ResolveEffectiveMessagesConfig;
      resolveHumanDelayConfig: ResolveHumanDelayConfig;
    };
    routing: {
      resolveAgentRoute: ResolveAgentRoute;
    };
    pairing: {
      buildPairingReply: BuildPairingReply;
      readAllowFromStore: ReadChannelAllowFromStore;
      upsertPairingRequest: UpsertChannelPairingRequest;
    };
    media: {
      fetchRemoteMedia: FetchRemoteMedia;
      saveMediaBuffer: SaveMediaBuffer;
    };
    mentions: {
      buildMentionRegexes: BuildMentionRegexes;
      matchesMentionPatterns: MatchesMentionPatterns;
    };
    groups: {
      resolveGroupPolicy: ResolveChannelGroupPolicy;
      resolveRequireMention: ResolveChannelGroupRequireMention;
    };
    debounce: {
      createInboundDebouncer: CreateInboundDebouncer;
      resolveInboundDebounceMs: ResolveInboundDebounceMs;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers: ResolveCommandAuthorizedFromAuthorizers;
    };
  };
  logging: {
    shouldLogVerbose: ShouldLogVerbose;
    getChildLogger: (
      bindings?: Record<string, unknown>,
      opts?: { level?: LogLevel },
    ) => RuntimeLogger;
  };
  state: {
    resolveStateDir: ResolveStateDir;
  };
};
