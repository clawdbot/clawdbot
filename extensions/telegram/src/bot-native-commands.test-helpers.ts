import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { ChannelGroupPolicy } from "openclaw/plugin-sdk/config-types";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-types";
import type { MockFn } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import { createNativeCommandTestParams } from "./bot-native-commands.fixture-test-support.js";
import type { RegisterTelegramNativeCommandsParams } from "./bot-native-commands.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

type GetPluginCommandSpecsFn =
  typeof import("./bot-native-commands.runtime.js").getPluginCommandSpecs;
type MatchPluginCommandFn = typeof import("./bot-native-commands.runtime.js").matchPluginCommand;
type ExecutePluginCommandFn =
  typeof import("./bot-native-commands.runtime.js").executePluginCommand;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;
type RecordInboundSessionMetaSafeFn =
  typeof import("./bot-native-commands.runtime.js").recordInboundSessionMetaSafe;
type ResolveChunkModeFn = typeof import("./bot-native-commands.runtime.js").resolveChunkMode;
type EnsureConfiguredBindingRouteReadyFn =
  typeof import("./bot-native-commands.runtime.js").ensureConfiguredBindingRouteReady;
type GetAgentScopedMediaLocalRootsFn =
  typeof import("./bot-native-commands.runtime.js").getAgentScopedMediaLocalRoots;
type CreateChannelReplyPipelineFn =
  typeof import("./bot-native-commands.delivery.runtime.js").createChannelReplyPipeline;
type AnyMock = MockFn<(...args: unknown[]) => unknown>;
type AnyAsyncMock = MockFn<(...args: unknown[]) => Promise<unknown>>;
type NativeCommandHarness = {
  handlers: Record<string, (ctx: unknown) => Promise<void>>;
  sendMessage: AnyAsyncMock;
  setMyCommands: AnyAsyncMock;
  log: AnyMock;
  bot: RegisterTelegramNativeCommandsParams["bot"];
};

const pluginCommandMocks = vi.hoisted(() => ({
  getPluginCommandSpecs: vi.fn<GetPluginCommandSpecsFn>(() => []),
  matchPluginCommand: vi.fn<MatchPluginCommandFn>(() => null),
  executePluginCommand: vi.fn<ExecutePluginCommandFn>(async () => ({ text: "ok" })),
}));
export const getPluginCommandSpecs = pluginCommandMocks.getPluginCommandSpecs;
export const matchPluginCommand = pluginCommandMocks.matchPluginCommand;
export const executePluginCommand = pluginCommandMocks.executePluginCommand;

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginCommandMocks.matchPluginCommand,
  executePluginCommand: pluginCommandMocks.executePluginCommand,
}));

const replyPipelineMocks = vi.hoisted(() => {
  const dispatchReplyResult: DispatchReplyWithBufferedBlockDispatcherResult = {
    queuedFinal: false,
    counts: {} as DispatchReplyWithBufferedBlockDispatcherResult["counts"],
  };
  return {
    finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
    dispatchReplyWithBufferedBlockDispatcher: vi.fn(
      (async () => dispatchReplyResult) as DispatchReplyWithBufferedBlockDispatcherFn,
    ),
    createChannelReplyPipeline: vi.fn((() => ({
      onModelSelected: () => {},
      responsePrefixContextProvider: () => undefined,
    })) as unknown as CreateChannelReplyPipelineFn),
    recordInboundSessionMetaSafe: vi.fn<RecordInboundSessionMetaSafeFn>(async () => undefined),
    resolveChunkMode: vi.fn((() => "length") as unknown as ResolveChunkModeFn),
    ensureConfiguredBindingRouteReady: vi.fn((async () => ({
      ok: true,
    })) as unknown as EnsureConfiguredBindingRouteReadyFn),
    getAgentScopedMediaLocalRoots: vi.fn<GetAgentScopedMediaLocalRootsFn>(() => []),
  };
});
export const dispatchReplyWithBufferedBlockDispatcher =
  replyPipelineMocks.dispatchReplyWithBufferedBlockDispatcher;

const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => {}),
}));
export const deliverReplies = deliveryMocks.deliverReplies;

vi.mock("./bot-native-commands.runtime.js", () => ({
  getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginCommandMocks.matchPluginCommand,
  executePluginCommand: pluginCommandMocks.executePluginCommand,
  finalizeInboundContext: replyPipelineMocks.finalizeInboundContext,
  recordInboundSessionMetaSafe: replyPipelineMocks.recordInboundSessionMetaSafe,
  resolveChunkMode: replyPipelineMocks.resolveChunkMode,
  ensureConfiguredBindingRouteReady: replyPipelineMocks.ensureConfiguredBindingRouteReady,
  getAgentScopedMediaLocalRoots: replyPipelineMocks.getAgentScopedMediaLocalRoots,
}));
vi.mock("./bot-native-commands.delivery.runtime.js", () => ({
  createChannelReplyPipeline: replyPipelineMocks.createChannelReplyPipeline,
  deliverReplies: deliveryMocks.deliverReplies,
  emitTelegramMessageSentHooks: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", () => ({
  dispatchReplyWithBufferedBlockDispatcher:
    replyPipelineMocks.dispatchReplyWithBufferedBlockDispatcher,
}));
vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: vi.fn(async () => []),
  resolveConfiguredBindingRoute: vi.fn(({ route }: { route: unknown }) => ({
    route,
    bindingResolution: null,
    boundSessionKey: "",
  })),
  resolveRuntimeConversationBindingRoute: vi.fn(({ route }: { route: unknown }) => ({
    bindingRecord: null,
    route,
  })),
  getSessionBindingService: vi.fn(() => ({
    resolveByConversation: vi.fn(() => null),
    touch: vi.fn(),
  })),
  isPluginOwnedSessionBindingRecord: vi.fn(() => false),
}));
vi.mock("./bot/delivery.js", () => ({ deliverReplies: deliveryMocks.deliverReplies }));
vi.mock("./bot/delivery.replies.js", () => ({ deliverReplies: deliveryMocks.deliverReplies }));
export { createNativeCommandTestParams };

export function createNativeCommandsHarness(params?: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  telegramCfg?: TelegramAccountConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  useAccessGroups?: boolean;
  nativeEnabled?: boolean;
  groupConfig?: Record<string, unknown>;
  resolveGroupPolicy?: () => ChannelGroupPolicy;
}): NativeCommandHarness {
  const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
  const sendMessage: AnyAsyncMock = vi.fn(async () => undefined);
  const setMyCommands: AnyAsyncMock = vi.fn(async () => undefined);
  const log: AnyMock = vi.fn();
  const telegramDeps = {
    getRuntimeConfig: vi.fn(() => params?.cfg ?? ({} as OpenClawConfig)),
    readChannelAllowFromStore: vi.fn(async () => []),
    dispatchReplyWithBufferedBlockDispatcher:
      replyPipelineMocks.dispatchReplyWithBufferedBlockDispatcher,
    getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
    listSkillCommandsForAgents: vi.fn(() => []),
    syncTelegramMenuCommands: vi.fn(),
  };
  const bot = {
    api: {
      setMyCommands,
      sendMessage,
    },
    command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
      handlers[name] = handler;
    },
  } as unknown as RegisterTelegramNativeCommandsParams["bot"];

  registerTelegramNativeCommands({
    bot,
    cfg: params?.cfg ?? ({} as OpenClawConfig),
    runtime: params?.runtime ?? ({ log } as unknown as RuntimeEnv),
    accountId: "default",
    telegramCfg: params?.telegramCfg ?? ({} as TelegramAccountConfig),
    allowFrom: params?.allowFrom ?? [],
    groupAllowFrom: params?.groupAllowFrom ?? [],
    replyToMode: "off",
    textLimit: 4000,
    useAccessGroups: params?.useAccessGroups ?? false,
    nativeEnabled: params?.nativeEnabled ?? true,
    nativeSkillsEnabled: false,
    nativeDisabledExplicit: false,
    telegramDeps,
    resolveGroupPolicy:
      params?.resolveGroupPolicy ??
      (() =>
        ({
          allowlistEnabled: false,
          allowed: true,
        }) as ChannelGroupPolicy),
    resolveTelegramGroupConfig: () => ({
      groupConfig: params?.groupConfig as undefined,
      topicConfig: undefined,
    }),
    shouldSkipUpdate: () => false,
    opts: { token: "token" },
  });

  return { handlers, sendMessage, setMyCommands, log, bot };
}

export function createTelegramGroupCommandContext(params?: {
  senderId?: number;
  username?: string;
  threadId?: number;
}) {
  return {
    message: {
      chat: { id: -100999, type: "supergroup", is_forum: true },
      from: {
        id: params?.senderId ?? 12345,
        username: params?.username ?? "testuser",
      },
      message_thread_id: params?.threadId ?? 42,
      message_id: 1,
      date: 1700000000,
    },
    match: "",
  };
}

export function findNotAuthorizedCalls(sendMessage: AnyAsyncMock) {
  return sendMessage.mock.calls.filter(
    (call) => typeof call[1] === "string" && call[1].includes("not authorized"),
  );
}
