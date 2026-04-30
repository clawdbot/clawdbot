import { vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsAdapter } from "./messenger.js";
import type { MSTeamsActivityHandler, MSTeamsMessageHandlerDeps } from "./monitor-handler.js";
import type { MSTeamsPollStore } from "./polls.js";
import { setMSTeamsRuntime } from "./runtime.js";

type RuntimeRoutePeer = { peer: { kind: string; id: string } };

type MSTeamsTestRuntimeOptions = {
  enqueueSystemEvent?: ReturnType<typeof vi.fn>;
  readAllowFromStore?: ReturnType<typeof vi.fn>;
  upsertPairingRequest?: ReturnType<typeof vi.fn>;
  recordInboundSession?: ReturnType<typeof vi.fn>;
  resolveAgentRoute?: (params: RuntimeRoutePeer) => unknown;
  resolveTextChunkLimit?: () => number;
  resolveStorePath?: () => string;
};

export function installMSTeamsTestRuntime(options: MSTeamsTestRuntimeOptions = {}): void {
  const runPrepared = vi.fn(
    async (turn: Parameters<PluginRuntime["channel"]["turn"]["runPrepared"]>[0]) => {
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
  const run = vi.fn(async (params: Parameters<PluginRuntime["channel"]["turn"]["run"]>[0]) => {
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
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: <T>(params: {
          onFlush: (entries: T[]) => Promise<void>;
        }): { enqueue: (entry: T) => Promise<void> } => ({
          enqueue: async (entry: T) => {
            await params.onFlush([entry]);
          },
        }),
      },
      pairing: {
        readAllowFromStore: options.readAllowFromStore ?? vi.fn(async () => []),
        upsertPairingRequest: options.upsertPairingRequest ?? vi.fn(async () => null),
      },
      text: {
        hasControlCommand: () => false,
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
      turn: {
        run: run as unknown as PluginRuntime["channel"]["turn"]["run"],
        runPrepared: runPrepared as unknown as PluginRuntime["channel"]["turn"]["runPrepared"],
      },
    },
  } as unknown as PluginRuntime);
}

export function createActivityHandler(
  run = vi.fn(async () => undefined),
): MSTeamsActivityHandler & {
  run: NonNullable<MSTeamsActivityHandler["run"]>;
} {
  let handler: MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  };
  handler = {
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
  const adapter: MSTeamsAdapter = {
    continueConversation: async () => {},
    process: async () => {},
    updateActivity: async () => {},
    deleteActivity: async () => {},
  };
  const conversationStore: MSTeamsConversationStore = {
    upsert: async () => {},
    get: async () => null,
    list: async () => [],
    remove: async () => false,
    findPreferredDmByUserId: async () => null,
    findByUserId: async () => null,
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
    adapter,
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
