import { randomUUID } from "node:crypto";
import { expect, vi, type Mock } from "vitest";
import { createPluginRuntimeMock } from "../../../../test/helpers/plugins/plugin-runtime-mock.js";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../../runtime-api.js";
import { createFeishuMessageReceiveHandler } from "../monitor.message-handler.js";
import { setFeishuRuntime } from "../runtime.js";
import type { ResolvedFeishuAccount } from "../types.js";

const FEISHU_LIFECYCLE_WAIT_TIMEOUT_MS = 10_000;

type InboundDebouncerParams<T> = {
  onFlush?: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
};
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type FeishuDispatchReplyCounts = {
  final: number;
  block?: number;
  tool?: number;
};
type FeishuDispatchReplyContext = Record<string, unknown> & {
  SessionKey?: string;
};
type FeishuDispatchReplyDispatcher = {
  sendFinalReply: (payload: { text: string }) => unknown;
};
type FeishuDispatchReplyMock = Mock<
  (args: {
    ctx: FeishuDispatchReplyContext;
    dispatcher: FeishuDispatchReplyDispatcher;
  }) => Promise<{ queuedFinal: boolean; counts: FeishuDispatchReplyCounts }>
>;
type FeishuLifecycleReplyDispatcher = {
  dispatcher: {
    sendToolResult: UnknownMock;
    sendBlockReply: UnknownMock;
    sendFinalReply: AsyncUnknownMock;
    waitForIdle: AsyncUnknownMock;
    getQueuedCounts: UnknownMock;
    markComplete: UnknownMock;
  };
  replyOptions: Record<string, never>;
  markDispatchIdle: UnknownMock;
};

export function setFeishuLifecycleStateDir(prefix: string) {
  process.env.OPENCLAW_STATE_DIR = `/tmp/${prefix}-${randomUUID()}`;
}

export function restoreFeishuLifecycleStateDir(originalStateDir: string | undefined) {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
    return;
  }
  process.env.OPENCLAW_STATE_DIR = originalStateDir;
}

export const FEISHU_PREFETCHED_BOT_OPEN_ID_SOURCE = {
  kind: "prefetched",
  botOpenId: "ou_bot_1",
  botName: "Bot",
} as const;

export function createFeishuLifecycleReplyDispatcher(): FeishuLifecycleReplyDispatcher {
  return {
    dispatcher: {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(async () => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  };
}

export function createImmediateInboundDebounce() {
  return {
    resolveInboundDebounceMs: vi.fn(() => 0),
    createInboundDebouncer: <T>(params: InboundDebouncerParams<T>) => ({
      enqueue: async (item: T) => {
        try {
          await params.onFlush?.([item]);
        } catch (err) {
          params.onError?.(err, [item]);
        }
      },
      flushKey: async () => {},
    }),
  };
}

export function installFeishuLifecycleRuntime(params: {
  resolveAgentRoute: PluginRuntime["channel"]["routing"]["resolveAgentRoute"];
  finalizeInboundContext: PluginRuntime["channel"]["reply"]["finalizeInboundContext"];
  dispatchReplyFromConfig: PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"];
  withReplyDispatcher: PluginRuntime["channel"]["reply"]["withReplyDispatcher"];
  resolveStorePath: PluginRuntime["channel"]["session"]["resolveStorePath"];
  hasControlCommand?: PluginRuntime["channel"]["text"]["hasControlCommand"];
  shouldComputeCommandAuthorized?: PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"];
  resolveCommandAuthorizedFromAuthorizers?: PluginRuntime["channel"]["commands"]["resolveCommandAuthorizedFromAuthorizers"];
  readAllowFromStore?: PluginRuntime["channel"]["pairing"]["readAllowFromStore"];
  upsertPairingRequest?: PluginRuntime["channel"]["pairing"]["upsertPairingRequest"];
  buildPairingReply?: PluginRuntime["channel"]["pairing"]["buildPairingReply"];
  detectMime?: PluginRuntime["media"]["detectMime"];
}): PluginRuntime {
  const runtime = createPluginRuntimeMock({
    channel: {
      debounce: createImmediateInboundDebounce(),
      text: {
        hasControlCommand: params.hasControlCommand ?? vi.fn(() => false),
      },
      routing: {
        resolveAgentRoute: params.resolveAgentRoute,
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatAgentEnvelope: vi.fn((value: { body: string }) => value.body),
        finalizeInboundContext: params.finalizeInboundContext,
        dispatchReplyFromConfig: params.dispatchReplyFromConfig,
        withReplyDispatcher: params.withReplyDispatcher,
      },
      commands: {
        shouldComputeCommandAuthorized: params.shouldComputeCommandAuthorized ?? vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers:
          params.resolveCommandAuthorizedFromAuthorizers ?? vi.fn(() => false),
      },
      session: {
        readSessionUpdatedAt: vi.fn(),
        resolveStorePath: params.resolveStorePath,
      },
      pairing: {
        readAllowFromStore: params.readAllowFromStore ?? vi.fn().mockResolvedValue([]),
        upsertPairingRequest: params.upsertPairingRequest ?? vi.fn(),
        buildPairingReply: params.buildPairingReply ?? vi.fn(),
      },
    },
    media: {
      detectMime: params.detectMime ?? vi.fn(async () => "text/plain"),
    },
  }) as unknown as PluginRuntime;
  setFeishuRuntime(runtime);
  return runtime;
}

export function installFeishuLifecycleReplyRuntime(params: {
  resolveAgentRouteMock: unknown;
  finalizeInboundContextMock: unknown;
  dispatchReplyFromConfigMock: unknown;
  withReplyDispatcherMock: unknown;
  storePath: string;
}): PluginRuntime {
  return installFeishuLifecycleRuntime({
    resolveAgentRoute:
      params.resolveAgentRouteMock as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
    finalizeInboundContext:
      params.finalizeInboundContextMock as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
    dispatchReplyFromConfig:
      params.dispatchReplyFromConfigMock as PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"],
    withReplyDispatcher:
      params.withReplyDispatcherMock as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
    resolveStorePath: vi.fn(() => params.storePath),
  });
}

export function mockFeishuReplyOnceDispatch(params: {
  dispatchReplyFromConfigMock: FeishuDispatchReplyMock;
  replyText: string;
  shouldSendFinalReply?: (ctx: unknown) => boolean;
}) {
  params.dispatchReplyFromConfigMock.mockImplementation(async ({ ctx, dispatcher }) => {
    const shouldSendFinalReply = params.shouldSendFinalReply?.(ctx) ?? true;
    if (shouldSendFinalReply && typeof dispatcher?.sendFinalReply === "function") {
      await dispatcher.sendFinalReply({ text: params.replyText });
    }
    return {
      queuedFinal: false,
      counts: { final: shouldSendFinalReply ? 1 : 0 },
    };
  });
}

export function createFeishuLifecycleConfig(params: {
  accountId: string;
  appId: string;
  appSecret: string;
  channelConfig?: Record<string, unknown>;
  accountConfig?: Record<string, unknown>;
  extraConfig?: Record<string, unknown>;
}): ClawdbotConfig {
  const extraConfig = params.extraConfig ?? {};
  return {
    ...extraConfig,
    channels: {
      ...(extraConfig.channels as Record<string, unknown> | undefined),
      feishu: {
        enabled: true,
        requireMention: false,
        resolveSenderNames: false,
        ...params.channelConfig,
        accounts: {
          [params.accountId]: {
            enabled: true,
            appId: params.appId,
            appSecret: params.appSecret, // pragma: allowlist secret
            connectionMode: "websocket",
            requireMention: false,
            resolveSenderNames: false,
            ...params.accountConfig,
          },
        },
      },
    },
    messages: {
      inbound: {
        debounceMs: 0,
        byChannel: {
          feishu: 0,
        },
      },
    },
  } as ClawdbotConfig;
}

export function createFeishuLifecycleFixture(params: {
  accountId: string;
  appId: string;
  appSecret: string;
  channelConfig?: Record<string, unknown>;
  accountConfig?: Record<string, unknown>;
  extraConfig?: Record<string, unknown>;
}) {
  return {
    cfg: createFeishuLifecycleConfig(params),
    account: createResolvedFeishuLifecycleAccount({
      accountId: params.accountId,
      appId: params.appId,
      appSecret: params.appSecret,
      config: {
        ...params.channelConfig,
        ...params.accountConfig,
      },
    }),
  };
}

export function createResolvedFeishuLifecycleAccount(params: {
  accountId: string;
  appId: string;
  appSecret: string;
  config: Record<string, unknown>;
}): ResolvedFeishuAccount {
  return {
    accountId: params.accountId,
    selectionSource: "config",
    enabled: true,
    configured: true,
    appId: params.appId,
    appSecret: params.appSecret, // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
      requireMention: false,
      resolveSenderNames: false,
      ...params.config,
    },
  } as unknown as ResolvedFeishuAccount;
}

export function createFeishuTextMessageEvent(params: {
  messageId: string;
  chatId: string;
  text: string;
  chatType?: "group" | "p2p";
  senderOpenId?: string;
  rootId?: string;
  threadId?: string;
}) {
  return {
    sender: {
      sender_id: { open_id: params.senderOpenId ?? "ou_sender_1" },
      sender_type: "user",
    },
    message: {
      message_id: params.messageId,
      ...(params.rootId ? { root_id: params.rootId } : {}),
      ...(params.threadId ? { thread_id: params.threadId } : {}),
      chat_id: params.chatId,
      chat_type: params.chatType ?? "group",
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      create_time: "1710000000000",
    },
  };
}

export async function replayFeishuLifecycleEvent(params: {
  handler: (data: unknown) => Promise<void>;
  event: unknown;
  waitForFirst: () => void | Promise<void>;
  waitForSecond?: () => void | Promise<void>;
  waitTimeoutMs?: number;
}) {
  const waitOptions = { timeout: params.waitTimeoutMs ?? FEISHU_LIFECYCLE_WAIT_TIMEOUT_MS };
  await params.handler(params.event);
  await vi.waitFor(params.waitForFirst, waitOptions);
  await params.handler(params.event);
  await vi.waitFor(params.waitForSecond ?? params.waitForFirst, waitOptions);
}

export async function runFeishuLifecycleSequence(
  deliveries: Array<() => Promise<void>>,
  waits: Array<() => void | Promise<void>>,
) {
  for (const [index, deliver] of deliveries.entries()) {
    await deliver();
    await vi.waitFor(waits[index] ?? waits.at(-1) ?? (() => {}), {
      timeout: FEISHU_LIFECYCLE_WAIT_TIMEOUT_MS,
    });
  }
}

export async function expectFeishuSingleEffectAcrossReplay(params: {
  handler: (data: unknown) => Promise<void>;
  event: unknown;
  effectMock: ReturnType<typeof vi.fn>;
  effectCount?: number;
}) {
  const effectCount = params.effectCount ?? 1;
  await replayFeishuLifecycleEvent({
    handler: params.handler,
    event: params.event,
    waitForFirst: () => {
      expect(params.effectMock).toHaveBeenCalledTimes(effectCount);
    },
  });
}

export async function expectFeishuReplyPipelineDedupedAcrossReplay(params: {
  handler: (data: unknown) => Promise<void>;
  event: unknown;
  dispatchReplyFromConfigMock: ReturnType<typeof vi.fn>;
  createFeishuReplyDispatcherMock: ReturnType<typeof vi.fn>;
  waitTimeoutMs?: number;
}) {
  const waitTimeoutMs = params.waitTimeoutMs ?? FEISHU_LIFECYCLE_WAIT_TIMEOUT_MS;
  await replayFeishuLifecycleEvent({
    handler: params.handler,
    event: params.event,
    waitTimeoutMs,
    waitForFirst: () => {
      expect(params.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    },
    waitForSecond: () => {
      expect(params.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
      expect(params.createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    },
  });
}

export async function expectFeishuReplyPipelineDedupedAfterPostSendFailure(params: {
  handler: (data: unknown) => Promise<void>;
  event: unknown;
  dispatchReplyFromConfigMock: ReturnType<typeof vi.fn>;
  runtimeErrorMock: ReturnType<typeof vi.fn>;
  waitTimeoutMs?: number;
}) {
  const waitTimeoutMs = params.waitTimeoutMs ?? FEISHU_LIFECYCLE_WAIT_TIMEOUT_MS;
  await replayFeishuLifecycleEvent({
    handler: params.handler,
    event: params.event,
    waitTimeoutMs,
    waitForFirst: () => {
      expect(params.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
      expect(params.runtimeErrorMock).toHaveBeenCalledTimes(1);
    },
    waitForSecond: () => {
      expect(params.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
      expect(params.runtimeErrorMock).toHaveBeenCalledTimes(1);
    },
  });
}

export function expectFeishuReplyDispatcherSentFinalReplyOnce(params: {
  createFeishuReplyDispatcherMock: ReturnType<typeof vi.fn>;
}) {
  const dispatcher = params.createFeishuReplyDispatcherMock.mock.results[0]?.value.dispatcher as {
    sendFinalReply: ReturnType<typeof vi.fn>;
  };
  expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
}

async function loadMonitorSingleAccount() {
  const module = await import("../monitor.account.js");
  return module.monitorSingleAccount;
}

export async function setupFeishuMessageReceiveLifecycleHandler(params: {
  runtime: RuntimeEnv;
  core: PluginRuntime;
  cfg: ClawdbotConfig;
  accountId: string;
  fireAndForget?: boolean;
  handleMessage: Parameters<typeof createFeishuMessageReceiveHandler>[0]["handleMessage"];
  resolveDebounceText: Parameters<
    typeof createFeishuMessageReceiveHandler
  >[0]["resolveDebounceText"];
}): Promise<(data: unknown) => Promise<void>> {
  return createFeishuMessageReceiveHandler({
    cfg: params.cfg,
    core: params.core,
    accountId: params.accountId,
    runtime: params.runtime,
    chatHistories: new Map(),
    fireAndForget: params.fireAndForget,
    handleMessage: params.handleMessage,
    resolveDebounceText: params.resolveDebounceText,
    hasProcessedMessage: vi.fn(async () => false),
    recordProcessedMessage: vi.fn(async () => true),
  });
}

export async function setupFeishuLifecycleHandler(params: {
  createEventDispatcherMock: {
    mockReturnValue: (value: unknown) => unknown;
    mockReturnValueOnce: (value: unknown) => unknown;
  };
  onRegister: (registered: Record<string, (data: unknown) => Promise<void>>) => void;
  runtime: RuntimeEnv;
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  handlerKey: string;
  missingHandlerMessage: string;
  once?: boolean;
}): Promise<(data: unknown) => Promise<void>> {
  const register = vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
    params.onRegister(registered);
  });
  if (params.once) {
    params.createEventDispatcherMock.mockReturnValueOnce({ register });
  } else {
    params.createEventDispatcherMock.mockReturnValue({ register });
  }

  const monitorSingleAccount = await loadMonitorSingleAccount();
  await monitorSingleAccount({
    cfg: params.cfg,
    account: params.account,
    runtime: params.runtime,
    botOpenIdSource: FEISHU_PREFETCHED_BOT_OPEN_ID_SOURCE,
  });

  const handlers: Record<string, (data: unknown) => Promise<void>> = {};
  for (const [key, value] of Object.entries(register.mock.calls[0]?.[0] ?? {})) {
    handlers[key] = value as (data: unknown) => Promise<void>;
  }
  const handler = handlers[params.handlerKey];
  if (!handler) {
    throw new Error(params.missingHandlerMessage);
  }
  return handler;
}
