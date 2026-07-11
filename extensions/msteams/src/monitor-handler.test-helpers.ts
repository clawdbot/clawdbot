// Msteams helper module supports monitor handler helpers behavior.
import type { PreparedInboundReply } from "openclaw/plugin-sdk/channel-inbound";
import { vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsActivityHandler, MSTeamsMessageHandlerDeps } from "./monitor-handler.js";
import type { MSTeamsPollStore } from "./polls.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsApp } from "./sdk.js";

type RuntimeRoutePeer = { peer: { kind: string; id: string } };

type MSTeamsTestRuntimeOptions = {
  enqueueSystemEvent?: ReturnType<typeof vi.fn>;
  readAllowFromStore?: ReturnType<typeof vi.fn>;
  upsertPairingRequest?: ReturnType<typeof vi.fn>;
  recordInboundSession?: ReturnType<typeof vi.fn>;
  resolveAgentRoute?: (params: RuntimeRoutePeer) => unknown;
  hasControlCommand?: PluginRuntime["channel"]["text"]["hasControlCommand"];
  isControlCommandMessage?: PluginRuntime["channel"]["commands"]["isControlCommandMessage"];
  shouldComputeCommandAuthorized?: PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"];
  shouldHandleTextCommands?: PluginRuntime["channel"]["commands"]["shouldHandleTextCommands"];
  createInboundDebouncer?: PluginRuntime["channel"]["debounce"]["createInboundDebouncer"];
  resolveInboundDebounceMs?: PluginRuntime["channel"]["debounce"]["resolveInboundDebounceMs"];
  resolveTextChunkLimit?: () => number;
  resolveStorePath?: () => string;
};

export function installMSTeamsTestRuntime(options: MSTeamsTestRuntimeOptions = {}): void {
  const runPrepared = vi.fn(async (turn: PreparedInboundReply<unknown>) => {
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
  });
  const run = vi.fn(async (params: Parameters<PluginRuntime["channel"]["inbound"]["run"]>[0]) => {
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
    throw new Error("msteams test runtime only supports prepared turn dispatch");
  });
  setMSTeamsRuntime({
    logging: { shouldLogVerbose: () => false },
    system: { enqueueSystemEvent: options.enqueueSystemEvent ?? vi.fn() },
    channel: {
      debounce: {
        resolveInboundDebounceMs:
          options.resolveInboundDebounceMs ??
          ((() => 0) as PluginRuntime["channel"]["debounce"]["resolveInboundDebounceMs"]),
        createInboundDebouncer:
          options.createInboundDebouncer ??
          (<T>(params: {
            onFlush: (entries: T[]) => Promise<void>;
          }): { enqueue: (entry: T) => Promise<void> } => ({
            enqueue: async (entry: T) => {
              await params.onFlush([entry]);
            },
          })),
      },
      pairing: {
        readAllowFromStore: options.readAllowFromStore ?? vi.fn(async () => []),
        upsertPairingRequest: options.upsertPairingRequest ?? vi.fn(async () => null),
      },
      commands: {
        isControlCommandMessage:
          options.isControlCommandMessage ?? options.hasControlCommand ?? (() => false),
        shouldComputeCommandAuthorized:
          options.shouldComputeCommandAuthorized ?? options.hasControlCommand ?? (() => false),
        shouldHandleTextCommands: options.shouldHandleTextCommands ?? (() => true),
      },
      text: {
        hasControlCommand: options.hasControlCommand ?? (() => false),
        resolveChunkMode: () => "length",
        resolveMarkdownTableMode: () => "code",
        ...(options.resolveTextChunkLimit
          ? { resolveTextChunkLimit: options.resolveTextChunkLimit }
          : {}),
      },
      routing: {
        resolveAgentRoute:
          options.resolveAgentRoute ??
          (({ peer }: RuntimeRoutePeer) => ({
            sessionKey: `msteams:${peer.kind}:${peer.id}`,
            agentId: "default",
            accountId: "default",
          })),
      },
      reply: {
        createReplyDispatcherWithTyping: () => ({
          dispatcher: {},
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        }),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
        resolveHumanDelayConfig: () => undefined,
      },
      session: {
        recordInboundSession: options.recordInboundSession ?? vi.fn(async () => undefined),
        ...(options.resolveStorePath ? { resolveStorePath: options.resolveStorePath } : {}),
      },
      inbound: {
        run: run as unknown as PluginRuntime["channel"]["inbound"]["run"],
      },
    },
  } as unknown as PluginRuntime);
}

export function createActivityHandler(
  run = vi.fn(async () => undefined),
): MSTeamsActivityHandler & {
  run: NonNullable<MSTeamsActivityHandler["run"]>;
} {
  const handler: MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  } = {
    onMessage: () => handler,
    onMembersAdded: () => handler,
    onReactionsAdded: () => handler,
    onReactionsRemoved: () => handler,
    run,
  };
  return handler;
}

export function createMSTeamsMessageHandlerDeps(params?: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
}): MSTeamsMessageHandlerDeps {
  const app = {
    tokenManager: {
      getBotToken: async () => ({ toString: () => "bot-token" }),
      getGraphToken: async () => ({ toString: () => "graph-token" }),
    },
    api: {},
    graph: {},
    send: async () => ({ id: "sent" }),
    initialize: async () => {},
    on: () => {},
  } as unknown as MSTeamsApp;
  const conversationStore: MSTeamsConversationStore = {
    upsert: async () => {},
    get: async () => null,
    list: async () => [],
    remove: async () => false,
    findPreferredDmByUserId: async () => null,
  };
  const pollStore: MSTeamsPollStore = {
    createPoll: async () => {},
    getPoll: async () => null,
    recordVote: async () => null,
  };

  return {
    cfg: params?.cfg ?? {},
    runtime: (params?.runtime ?? { error: vi.fn() }) as RuntimeEnv,
    appId: "test-app-id",
    app,
    tokenProvider: {
      getAccessToken: async () => "token",
    },
    textLimit: 4000,
    mediaMaxBytes: 8 * 1024 * 1024,
    conversationStore,
    pollStore,
    log: {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}
