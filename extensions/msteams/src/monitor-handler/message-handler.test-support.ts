// Msteams plugin module implements message handler support behavior.
import { vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../../runtime-api.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import { installMSTeamsTestRuntime } from "../monitor-handler.test-helpers.js";

export const channelConversationId = "19:general@thread.tacv2";

type MessageHandlerDepsOptions = {
  enqueueSystemEvent?: ReturnType<typeof vi.fn>;
  readAllowFromStore?: ReturnType<typeof vi.fn>;
  upsertPairingRequest?: ReturnType<typeof vi.fn>;
  recordInboundSession?: ReturnType<typeof vi.fn>;
  resolveAgentRoute?: (params: { peer: { kind: string; id: string } }) => unknown;
  hasControlCommand?: PluginRuntime["channel"]["text"]["hasControlCommand"];
  isControlCommandMessage?: PluginRuntime["channel"]["commands"]["isControlCommandMessage"];
  shouldComputeCommandAuthorized?: PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"];
  shouldHandleTextCommands?: PluginRuntime["channel"]["commands"]["shouldHandleTextCommands"];
  createInboundDebouncer?: PluginRuntime["channel"]["debounce"]["createInboundDebouncer"];
  resolveInboundDebounceMs?: PluginRuntime["channel"]["debounce"]["resolveInboundDebounceMs"];
  getTeamDetails?: ReturnType<typeof vi.fn>;
};

export function createMessageHandlerDeps(
  cfg: OpenClawConfig,
  options: MessageHandlerDepsOptions = {},
) {
  const enqueueSystemEvent = options.enqueueSystemEvent ?? vi.fn();
  const readAllowFromStore = options.readAllowFromStore ?? vi.fn(async () => []);
  const upsertPairingRequest = options.upsertPairingRequest ?? vi.fn(async () => null);
  const recordInboundSession =
    options.recordInboundSession ?? vi.fn(async (_params: { sessionKey: string }) => undefined);
  const resolveAgentRoute =
    options.resolveAgentRoute ??
    vi.fn(({ peer }: { peer: { kind: string; id: string } }) => ({
      sessionKey: `agent:main:msteams:${peer.kind}:${peer.id}`,
      agentId: "main",
      accountId: "default",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "default" as const,
    }));
  const getTeamDetails =
    options.getTeamDetails ?? vi.fn(async () => ({ aadGroupId: "team-aad-group" }));

  installMSTeamsTestRuntime({
    enqueueSystemEvent,
    readAllowFromStore,
    upsertPairingRequest,
    recordInboundSession,
    resolveAgentRoute,
    hasControlCommand: options.hasControlCommand,
    isControlCommandMessage: options.isControlCommandMessage,
    shouldComputeCommandAuthorized: options.shouldComputeCommandAuthorized,
    shouldHandleTextCommands: options.shouldHandleTextCommands,
    createInboundDebouncer: options.createInboundDebouncer,
    resolveInboundDebounceMs: options.resolveInboundDebounceMs,
    resolveTextChunkLimit: () => 4000,
    resolveStorePath: () => "/tmp/test-store",
  });

  const conversationStore = {
    get: vi.fn<MSTeamsMessageHandlerDeps["conversationStore"]["get"]>(async () => null),
    upsert: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => false),
    findPreferredDmByUserId: vi.fn(async () => null),
  } satisfies MSTeamsMessageHandlerDeps["conversationStore"];

  const deps: MSTeamsMessageHandlerDeps = {
    cfg,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
    appId: "test-app",
    app: {} as MSTeamsMessageHandlerDeps["app"],
    tokenProvider: {
      getAccessToken: vi.fn(async () => "token"),
    },
    textLimit: 4000,
    mediaMaxBytes: 1024 * 1024,
    conversationStore,
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
    conversationStore,
    deps,
    enqueueSystemEvent,
    readAllowFromStore,
    upsertPairingRequest,
    recordInboundSession,
    resolveAgentRoute,
    getTeamDetails,
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
