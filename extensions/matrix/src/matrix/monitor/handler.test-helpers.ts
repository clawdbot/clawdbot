import { vi } from "vitest";
import type { RuntimeEnv, RuntimeLogger } from "../../runtime-api.js";
import type { MatrixRoomConfig, MatrixStreamingMode, ReplyToMode } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { createMatrixRoomMessageHandler, type MatrixMonitorHandlerParams } from "./handler.js";
import { EventType, type MatrixRawEvent, type RoomMessageEventContent } from "./types.js";

const DEFAULT_ROUTE = {
  agentId: "ops",
  channel: "matrix",
  accountId: "ops",
  sessionKey: "agent:ops:main",
  mainSessionKey: "agent:ops:main",
  matchedBy: "binding.account" as const,
};

type MatrixHandlerTestHarnessOptions = {
  accountId?: string;
  cfg?: unknown;
  client?: Partial<MatrixClient>;
  runtime?: RuntimeEnv;
  logger?: RuntimeLogger;
  logVerboseMessage?: (message: string) => void;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  roomsConfig?: Record<string, MatrixRoomConfig>;
  accountAllowBots?: boolean | "mentions";
  configuredBotUserIds?: Set<string>;
  mentionRegexes?: RegExp[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  replyToMode?: ReplyToMode;
  threadReplies?: "off" | "inbound" | "always";
  dmThreadReplies?: "off" | "inbound" | "always";
  dmSessionScope?: "per-user" | "per-room";
  streaming?: MatrixStreamingMode;
  blockStreamingEnabled?: boolean;
  dmEnabled?: boolean;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  textLimit?: number;
  mediaMaxBytes?: number;
  startupMs?: number;
  startupGraceMs?: number;
  dropPreStartupMessages?: boolean;
  needsRoomAliasesForConfig?: boolean;
  isDirectMessage?: boolean;
  historyLimit?: number;
  readAllowFromStore?: MatrixMonitorHandlerParams["core"]["channel"]["pairing"]["readAllowFromStore"];
  upsertPairingRequest?: MatrixMonitorHandlerParams["core"]["channel"]["pairing"]["upsertPairingRequest"];
  buildPairingReply?: () => string;
  shouldHandleTextCommands?: () => boolean;
  hasControlCommand?: () => boolean;
  resolveMarkdownTableMode?: () => string;
  resolveAgentRoute?: () => typeof DEFAULT_ROUTE;
  resolveStorePath?: () => string;
  readSessionUpdatedAt?: () => number | undefined;
  recordInboundSession?: (...args: unknown[]) => Promise<void>;
  resolveEnvelopeFormatOptions?: () => Record<string, never>;
  formatAgentEnvelope?: ({ body }: { body: string }) => string;
  finalizeInboundContext?: (ctx: unknown) => unknown;
  createReplyDispatcherWithTyping?: (params?: {
    onError?: (err: unknown, info: { kind: "tool" | "block" | "final" }) => void;
  }) => {
    dispatcher: Record<string, unknown>;
    replyOptions: Record<string, unknown>;
    markDispatchIdle: () => void;
    markRunComplete: () => void;
  };
  resolveHumanDelayConfig?: () => undefined;
  dispatchReplyFromConfig?: () => Promise<{
    queuedFinal: boolean;
    counts: { final: number; block: number; tool: number };
  }>;
  withReplyDispatcher?: <T>(params: {
    dispatcher: {
      markComplete?: () => void;
      waitForIdle?: () => Promise<void>;
    };
    run: () => Promise<T>;
    onSettled?: () => void | Promise<void>;
  }) => Promise<T>;
  inboundDeduper?: MatrixMonitorHandlerParams["inboundDeduper"];
  shouldAckReaction?: () => boolean;
  enqueueSystemEvent?: (...args: unknown[]) => void;
  getRoomInfo?: MatrixMonitorHandlerParams["getRoomInfo"];
  getMemberDisplayName?: MatrixMonitorHandlerParams["getMemberDisplayName"];
};

type MatrixHandlerTestHarness = {
  dispatchReplyFromConfig: () => Promise<{
    queuedFinal: boolean;
    counts: { final: number; block: number; tool: number };
  }>;
  enqueueSystemEvent: (...args: unknown[]) => void;
  finalizeInboundContext: (ctx: unknown) => unknown;
  handler: ReturnType<typeof createMatrixRoomMessageHandler>;
  readAllowFromStore: MatrixMonitorHandlerParams["core"]["channel"]["pairing"]["readAllowFromStore"];
  recordInboundSession: (...args: unknown[]) => Promise<void>;
  resolveAgentRoute: () => typeof DEFAULT_ROUTE;
  upsertPairingRequest: MatrixMonitorHandlerParams["core"]["channel"]["pairing"]["upsertPairingRequest"];
};

export function createMatrixHandlerTestHarness(
  options: MatrixHandlerTestHarnessOptions = {},
): MatrixHandlerTestHarness {
  const readAllowFromStore = options.readAllowFromStore ?? vi.fn(async () => [] as string[]);
  const upsertPairingRequest =
    options.upsertPairingRequest ?? vi.fn(async () => ({ code: "ABCDEFGH", created: false }));
  const resolveAgentRoute = options.resolveAgentRoute ?? vi.fn(() => DEFAULT_ROUTE);
  const recordInboundSession = options.recordInboundSession ?? vi.fn(async () => {});
  const finalizeInboundContext = options.finalizeInboundContext ?? vi.fn((ctx) => ctx);
  const dispatchReplyFromConfig =
    options.dispatchReplyFromConfig ??
    (async () => ({
      queuedFinal: false,
      counts: { final: 0, block: 0, tool: 0 },
    }));
  const enqueueSystemEvent = options.enqueueSystemEvent ?? vi.fn();

  const handler = createMatrixRoomMessageHandler({
    client: {
      getUserId: async () => "@bot:example.org",
      getEvent: async () => ({ sender: "@bot:example.org" }),
      ...options.client,
    } as never,
    core: {
      channel: {
        pairing: {
          readAllowFromStore,
          upsertPairingRequest,
          buildPairingReply: options.buildPairingReply ?? (() => "pairing"),
        },
        commands: {
          shouldHandleTextCommands: options.shouldHandleTextCommands ?? (() => false),
        },
        text: {
          hasControlCommand: options.hasControlCommand ?? (() => false),
          resolveMarkdownTableMode: options.resolveMarkdownTableMode ?? (() => "preserve"),
        },
        routing: {
          resolveAgentRoute,
        },
        mentions: {
          buildMentionRegexes: () => options.mentionRegexes ?? [],
        },
        session: {
          resolveStorePath: options.resolveStorePath ?? (() => "/tmp/session-store"),
          readSessionUpdatedAt: options.readSessionUpdatedAt ?? (() => undefined),
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: options.resolveEnvelopeFormatOptions ?? (() => ({})),
          formatAgentEnvelope:
            options.formatAgentEnvelope ?? (({ body }: { body: string }) => body),
          finalizeInboundContext,
          createReplyDispatcherWithTyping:
            options.createReplyDispatcherWithTyping ??
            (() => ({
              dispatcher: {},
              replyOptions: {},
              markDispatchIdle: () => {},
              markRunComplete: () => {},
            })),
          resolveHumanDelayConfig: options.resolveHumanDelayConfig ?? (() => undefined),
          dispatchReplyFromConfig,
          withReplyDispatcher:
            options.withReplyDispatcher ??
            (async <T>(params: {
              dispatcher: {
                markComplete?: () => void;
                waitForIdle?: () => Promise<void>;
              };
              run: () => Promise<T>;
              onSettled?: () => void | Promise<void>;
            }) => {
              const { dispatcher, run, onSettled } = params;
              try {
                return await run();
              } finally {
                dispatcher.markComplete?.();
                try {
                  await dispatcher.waitForIdle?.();
                } finally {
                  await onSettled?.();
                }
              }
            }),
        },
        reactions: {
          shouldAckReaction: options.shouldAckReaction ?? (() => false),
        },
      },
      system: {
        enqueueSystemEvent,
      },
    } as never,
    cfg: (options.cfg ?? {}) as never,
    accountId: options.accountId ?? "ops",
    runtime:
      options.runtime ??
      ({
        error: () => {},
      } as RuntimeEnv),
    logger:
      options.logger ??
      ({
        info: () => {},
        warn: () => {},
        error: () => {},
      } as RuntimeLogger),
    logVerboseMessage: options.logVerboseMessage ?? (() => {}),
    allowFrom: options.allowFrom ?? [],
    groupAllowFrom: options.groupAllowFrom ?? [],
    roomsConfig: options.roomsConfig,
    accountAllowBots: options.accountAllowBots,
    configuredBotUserIds: options.configuredBotUserIds,
    groupPolicy: options.groupPolicy ?? "open",
    replyToMode: options.replyToMode ?? "off",
    threadReplies: options.threadReplies ?? "inbound",
    dmThreadReplies: options.dmThreadReplies,
    dmSessionScope: options.dmSessionScope,
    streaming: options.streaming ?? "off",
    blockStreamingEnabled: options.blockStreamingEnabled ?? false,
    dmEnabled: options.dmEnabled ?? true,
    dmPolicy: options.dmPolicy ?? "open",
    textLimit: options.textLimit ?? 8_000,
    mediaMaxBytes: options.mediaMaxBytes ?? 10_000_000,
    startupMs: options.startupMs ?? 0,
    startupGraceMs: options.startupGraceMs ?? 0,
    dropPreStartupMessages: options.dropPreStartupMessages ?? true,
    inboundDeduper: options.inboundDeduper,
    directTracker: {
      isDirectMessage: async () => options.isDirectMessage ?? true,
    },
    getRoomInfo: options.getRoomInfo ?? (async () => ({ altAliases: [] })),
    getMemberDisplayName: options.getMemberDisplayName ?? (async () => "sender"),
    needsRoomAliasesForConfig: options.needsRoomAliasesForConfig ?? false,
    historyLimit: options.historyLimit ?? 0,
  });

  return {
    dispatchReplyFromConfig,
    enqueueSystemEvent,
    finalizeInboundContext,
    handler,
    readAllowFromStore,
    recordInboundSession,
    resolveAgentRoute,
    upsertPairingRequest,
  };
}

export function createMatrixTextMessageEvent(params: {
  eventId: string;
  sender?: string;
  body: string;
  originServerTs?: number;
  relatesTo?: RoomMessageEventContent["m.relates_to"];
  mentions?: RoomMessageEventContent["m.mentions"];
}): MatrixRawEvent {
  return createMatrixRoomMessageEvent({
    eventId: params.eventId,
    sender: params.sender,
    originServerTs: params.originServerTs,
    content: {
      msgtype: "m.text",
      body: params.body,
      ...(params.relatesTo ? { "m.relates_to": params.relatesTo } : {}),
      ...(params.mentions ? { "m.mentions": params.mentions } : {}),
    },
  });
}

export function createMatrixRoomMessageEvent(params: {
  eventId: string;
  sender?: string;
  originServerTs?: number;
  content: RoomMessageEventContent;
}): MatrixRawEvent {
  return {
    type: EventType.RoomMessage,
    sender: params.sender ?? "@user:example.org",
    event_id: params.eventId,
    origin_server_ts: params.originServerTs ?? Date.now(),
    content: params.content,
  } as MatrixRawEvent;
}

export function createMatrixReactionEvent(params: {
  eventId: string;
  targetEventId: string;
  key: string;
  sender?: string;
  originServerTs?: number;
}): MatrixRawEvent {
  return {
    type: EventType.Reaction,
    sender: params.sender ?? "@user:example.org",
    event_id: params.eventId,
    origin_server_ts: params.originServerTs ?? Date.now(),
    content: {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: params.targetEventId,
        key: params.key,
      },
    },
  } as MatrixRawEvent;
}
