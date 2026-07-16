import { vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../../runtime-api.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import { setMSTeamsRuntime } from "../runtime.js";

export const channelConversationId = "19:general@thread.tacv2";

export function createMessageHandlerDeps(cfg: OpenClawConfig) {
  const enqueueSystemEvent = vi.fn();
  const recordInboundSession = vi.fn(async (_params: { sessionKey: string }) => undefined);
  const resolveAgentRoute = vi.fn(({ peer }: { peer: { kind: string; id: string } }) => ({
    sessionKey: `agent:main:msteams:${peer.kind}:${peer.id}`,
    agentId: "main",
    accountId: "default",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "session" as const,
    matchedBy: "default" as const,
  }));

  setMSTeamsRuntime({
    logging: { shouldLogVerbose: () => false },
    system: { enqueueSystemEvent },
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
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => null),
      },
      text: {
        hasControlCommand: () => false,
        resolveTextChunkLimit: () => 4000,
      },
      routing: { resolveAgentRoute },
      reply: {
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
      },
      session: {
        recordInboundSession,
        resolveStorePath: () => "/tmp/test-store",
      },
    },
  } as unknown as PluginRuntime);

  const deps: MSTeamsMessageHandlerDeps = {
    cfg,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
    appId: "test-app",
    adapter: {} as MSTeamsMessageHandlerDeps["adapter"],
    tokenProvider: {
      getAccessToken: vi.fn(async () => "token"),
    },
    textLimit: 4000,
    mediaMaxBytes: 1024 * 1024,
    conversationStore: {
      get: vi.fn(async () => null),
      upsert: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => false),
      findPreferredDmByUserId: vi.fn(async () => null),
      findByUserId: vi.fn(async () => null),
    } satisfies MSTeamsMessageHandlerDeps["conversationStore"],
    pollStore: {
      recordVote: vi.fn(async () => null),
    } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
    log: {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as MSTeamsMessageHandlerDeps["log"],
  };

  return {
    deps,
    enqueueSystemEvent,
    recordInboundSession,
    resolveAgentRoute,
  };
}

export function buildChannelActivity(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    type: "message",
    text: "hello",
    from: { id: "user-id", aadObjectId: "user-aad", name: "Test User" },
    recipient: { id: "bot-id", name: "Bot" },
    conversation: { id: channelConversationId, conversationType: "channel" },
    channelData: { team: { id: "team-1" } },
    attachments: [],
    entities: [{ type: "mention", mentioned: { id: "bot-id" } }],
    ...overrides,
  };
}
