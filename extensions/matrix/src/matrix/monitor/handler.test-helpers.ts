import { vi } from "vitest";
import type { RuntimeEnv, RuntimeLogger } from "../../runtime-api.js";
import type {
  MatrixConfig,
  MatrixRoomConfig,
  MatrixStreamingMode,
  ReplyToMode,
} from "../../types.js";
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
  accountConfig?: MatrixConfig;
  cfg?: unknown;
  client?: Partial<MatrixClient>;
  runtime?: RuntimeEnv;
  logger?: RuntimeLogger;
  logVerboseMessage?: (message: string) => void;
  allowFrom?: string[];
  allowFromResolvedEntries?: MatrixMonitorHandlerParams["allowFromResolvedEntries"];
  groupAllowFrom?: string[];
  groupAllowFromResolvedEntries?: MatrixMonitorHandlerParams["groupAllowFromResolvedEntries"];
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
  previewToolProgressEnabled?: boolean;
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
  hasControlCommand?: MatrixMonitorHandlerParams["core"]["channel"]["text"]["hasControlCommand"];
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
  resolveLiveUserAllowlist?: MatrixMonitorHandlerParams["resolveLiveUserAllowlist"];
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
  const runPrepared = vi.fn(
    async (
      turn: Parameters<MatrixMonitorHandlerParams["core"]["channel"]["turn"]["runPrepared"]>[0],
    ) => {
      await turn.recordInboundSession({
        storePath: turn.storePath,
        sessionKey: turn.ctxPayload.SessionKey ?? turn.routeSessionKey,
        ctx: turn.ctxPayload,
        groupResolution: turn.record?.groupResolution,
        createIfMissing: turn.record?.createIfMissing,
        updateLastRoute: turn.record?.updateLastRoute,
        onRecordError: turn.record?.onRecordError ?? (() => undefined),
      });
      const dispatchResult = await turn.runDispatch();
      return {
        admission: { kind: "dispatch" as const },
        dispatched: true,
        ctxPayload: turn.ctxPayload,
        routeSessionKey: turn.routeSessionKey,
        dispatchResult,
      };
    },
  );
  const run = vi.fn(
    async (params: Parameters<MatrixMonitorHandlerParams["core"]["channel"]["turn"]["run"]>[0]) => {
      const input = await params.adapter.ingest(params.raw);
      if (!input) {
        return { admission: { kind: "drop" as const, reason: "ingest-null" }, dispatched: false };
      }
      const eventClass = (await params.adapter.classify?.(input)) ?? {
        kind: "message" as const,
        canStartAgentTurn: true,
      };
      const preflightResult = await params.adapter.preflight?.(input, eventClass);
      const preflight =
        preflightResult && "kind" in preflightResult
          ? { admission: preflightResult }
          : (preflightResult ?? {});
      const turn = await params.adapter.resolveTurn(input, eventClass, preflight);
      if ("runDispatch" in turn) {
        return await runPrepared(turn);
      }
      throw new Error("matrix test helper only supports prepared turn dispatch");
    },
  );
  const dmPolicy = options.dmPolicy ?? "open";
  const allowFrom = options.allowFrom ?? (dmPolicy === "open" ? ["*"] : []);
  const cfgForHandler =
    options.cfg ??
    ({
      channels: {
        matrix: {
          dm: {
            allowFrom,
          },
        },
      },
    } as const);

  const handler = createMatrixRoomMessageHandler({
    client: {
      getUserId: async () => "@bot:example.org",
      getEvent: async () => ({ sender: "@bot:example.org" }),
      ...options.client,
    } as never,
    core: {
      config: {
        current: () => cfgForHandler,
      },
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
        turn: {
          run,
          runPrepared,
        },
        reactions: {
          shouldAckReaction: options.shouldAckReaction ?? (() => false),
        },
      },
      system: {
        enqueueSystemEvent,
      },
    } as never,
    cfg: cfgForHandler as never,
    accountId: options.accountId ?? "ops",
    accountConfig: options.accountConfig,
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
    allowFrom,
    allowFromResolvedEntries: options.allowFromResolvedEntries,
    groupAllowFrom: options.groupAllowFrom ?? [],
    groupAllowFromResolvedEntries: options.groupAllowFromResolvedEntries,
    roomsConfig: options.roomsConfig,
    accountAllowBots: options.accountAllowBots,
    configuredBotUserIds: options.configuredBotUserIds,
    groupPolicy: options.groupPolicy ?? "open",
    replyToMode: options.replyToMode ?? "off",
    threadReplies: options.threadReplies ?? "inbound",
    dmThreadReplies: options.dmThreadReplies,
    dmSessionScope: options.dmSessionScope,
    streaming: options.streaming ?? "off",
    previewToolProgressEnabled: options.previewToolProgressEnabled ?? false,
    blockStreamingEnabled: options.blockStreamingEnabled ?? false,
    dmEnabled: options.dmEnabled ?? true,
    dmPolicy,
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
    resolveLiveUserAllowlist: options.resolveLiveUserAllowlist,
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
  unsigned?: MatrixRawEvent["unsigned"];
}): MatrixRawEvent {
  return createMatrixRoomMessageEvent({
    eventId: params.eventId,
    sender: params.sender,
    originServerTs: params.originServerTs,
    unsigned: params.unsigned,
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
  unsigned?: MatrixRawEvent["unsigned"];
  content: RoomMessageEventContent;
}): MatrixRawEvent {
  return {
    type: EventType.RoomMessage,
    sender: params.sender ?? "@user:example.org",
    event_id: params.eventId,
    origin_server_ts: params.originServerTs ?? Date.now(),
    content: params.content,
    ...(params.unsigned ? { unsigned: params.unsigned } : {}),
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
