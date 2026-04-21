import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type {
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurnInput,
} from "../../plugin-sdk/acp-runtime.js";
import type {
  PluginHookBeforeDispatchResult,
  PluginHookReplyDispatchResult,
  PluginTargetedInboundClaimOutcome,
} from "../../plugins/hooks.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

type AbortResult = { handled: boolean; aborted: boolean; stoppedSubagents?: number };

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
  tryFastAbortFromMessage: vi.fn<() => Promise<AbortResult>>(async () => ({
    handled: false,
    aborted: false,
  })),
}));
const diagnosticMocks = vi.hoisted(() => ({
  logMessageQueued: vi.fn(),
  logMessageProcessed: vi.fn(),
  logSessionStateChange: vi.fn(),
}));
const hookMocks = vi.hoisted(() => ({
  registry: {
    plugins: [] as Array<{
      id: string;
      status: "loaded" | "disabled" | "error";
    }>,
  },
  runner: {
    hasHooks: vi.fn<(hookName?: string) => boolean>(() => false),
    runInboundClaim: vi.fn(async () => undefined),
    runInboundClaimForPlugin: vi.fn(async () => undefined),
    runInboundClaimForPluginOutcome: vi.fn<() => Promise<PluginTargetedInboundClaimOutcome>>(
      async () => ({ status: "no_handler" as const }),
    ),
    runMessageReceived: vi.fn(async () => {}),
    runBeforeDispatch: vi.fn<
      (_event: unknown, _ctx: unknown) => Promise<PluginHookBeforeDispatchResult | undefined>
    >(async () => undefined),
    runReplyDispatch: vi.fn<
      (_event: unknown, _ctx: unknown) => Promise<PluginHookReplyDispatchResult | undefined>
    >(async () => undefined),
  },
}));
const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));
const acpMocks = vi.hoisted(() => ({
  listAcpSessionEntries: vi.fn(async () => []),
  readAcpSessionEntry: vi.fn<(params: { sessionKey: string; cfg?: OpenClawConfig }) => unknown>(
    () => null,
  ),
  getAcpRuntimeBackend: vi.fn<() => unknown>(() => null),
  upsertAcpSessionMeta: vi.fn<
    (params: {
      sessionKey: string;
      cfg?: OpenClawConfig;
      mutate: (
        current: Record<string, unknown> | undefined,
        entry: { acp?: Record<string, unknown> } | undefined,
      ) => Record<string, unknown> | null | undefined;
    }) => Promise<unknown>
  >(async () => null),
  requireAcpRuntimeBackend: vi.fn<() => unknown>(),
}));
const sessionBindingMocks = vi.hoisted(() => ({
  listBySession: vi.fn<(targetSessionKey: string) => SessionBindingRecord[]>(() => []),
  resolveByConversation: vi.fn<
    (ref: {
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
    }) => SessionBindingRecord | null
  >(() => null),
  touch: vi.fn(),
}));
const pluginConversationBindingMocks = vi.hoisted(() => ({
  shownFallbackNoticeBindingIds: new Set<string>(),
}));
const sessionStoreMocks = vi.hoisted(() => ({
  currentEntry: undefined as Record<string, unknown> | undefined,
  loadSessionStore: vi.fn(() => ({})),
  resolveStorePath: vi.fn(() => "/tmp/mock-sessions.json"),
  resolveSessionStoreEntry: vi.fn(() => ({ existing: sessionStoreMocks.currentEntry })),
}));
const acpManagerRuntimeMocks = vi.hoisted(() => ({
  getAcpSessionManager: vi.fn(),
}));
const agentEventMocks = vi.hoisted(() => ({
  emitAgentEvent: vi.fn(),
  onAgentEvent: vi.fn<(listener: unknown) => () => void>(() => () => {}),
}));
const ttsMocks = vi.hoisted(() => {
  const state = {
    synthesizeFinalAudio: false,
  };
  return {
    state,
    maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        payload: ReplyPayload;
        kind: "tool" | "block" | "final";
      };
      if (
        state.synthesizeFinalAudio &&
        params.kind === "final" &&
        typeof params.payload?.text === "string" &&
        params.payload.text.trim()
      ) {
        return {
          ...params.payload,
          mediaUrl: "https://example.com/tts-synth.opus",
          audioAsVoice: true,
        };
      }
      return params.payload;
    }),
    normalizeTtsAutoMode: vi.fn((value: unknown) =>
      typeof value === "string" ? value : undefined,
    ),
    resolveTtsConfig: vi.fn((_cfg: OpenClawConfig) => ({ mode: "final" })),
  };
});
const replyMediaPathMocks = vi.hoisted(() => ({
  createReplyMediaPathNormalizer: vi.fn(
    (_params?: unknown) => async (payload: ReplyPayload) => payload,
  ),
}));
const threadInfoMocks = vi.hoisted(() => ({
  parseSessionThreadInfo: vi.fn<
    (sessionKey: string | undefined) => {
      baseSessionKey: string | undefined;
      threadId: string | undefined;
    }
  >(),
}));

function parseGenericThreadSessionInfo(sessionKey: string | undefined) {
  const trimmed = sessionKey?.trim();
  if (!trimmed) {
    return { baseSessionKey: undefined, threadId: undefined };
  }
  const threadMarker = ":thread:";
  const topicMarker = ":topic:";
  const marker = trimmed.includes(threadMarker)
    ? threadMarker
    : trimmed.includes(topicMarker)
      ? topicMarker
      : undefined;
  if (!marker) {
    return { baseSessionKey: trimmed, threadId: undefined };
  }
  const index = trimmed.lastIndexOf(marker);
  if (index < 0) {
    return { baseSessionKey: trimmed, threadId: undefined };
  }
  const baseSessionKey = trimmed.slice(0, index).trim() || undefined;
  const threadId = trimmed.slice(index + marker.length).trim() || undefined;
  return { baseSessionKey, threadId };
}

vi.mock("./route-reply.runtime.js", () => ({
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(
      channel &&
      [
        "telegram",
        "slack",
        "discord",
        "signal",
        "imessage",
        "whatsapp",
        "feishu",
        "mattermost",
      ].includes(channel),
    ),
  routeReply: mocks.routeReply,
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(
      channel &&
      [
        "telegram",
        "slack",
        "discord",
        "signal",
        "imessage",
        "whatsapp",
        "feishu",
        "mattermost",
      ].includes(channel),
    ),
  routeReply: mocks.routeReply,
}));

vi.mock("./abort.runtime.js", () => ({
  tryFastAbortFromMessage: mocks.tryFastAbortFromMessage,
  formatAbortReplyText: (stoppedSubagents?: number) => {
    if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
      return "⚙️ Agent was aborted.";
    }
    const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
    return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${label}.`;
  },
}));

vi.mock("../../logging/diagnostic.js", () => ({
  logMessageQueued: diagnosticMocks.logMessageQueued,
  logMessageProcessed: diagnosticMocks.logMessageProcessed,
  logSessionStateChange: diagnosticMocks.logSessionStateChange,
}));
vi.mock("../../config/sessions/thread-info.js", () => ({
  parseSessionThreadInfo: (sessionKey: string | undefined) =>
    threadInfoMocks.parseSessionThreadInfo(sessionKey),
  parseSessionThreadInfoFast: (sessionKey: string | undefined) =>
    threadInfoMocks.parseSessionThreadInfo(sessionKey),
}));
vi.mock("./dispatch-from-config.runtime.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  loadSessionStore: sessionStoreMocks.loadSessionStore,
  resolveSessionStoreEntry: sessionStoreMocks.resolveSessionStoreEntry,
  resolveStorePath: sessionStoreMocks.resolveStorePath,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
  getGlobalPluginRegistry: () => hookMocks.registry,
}));
vi.mock("../../acp/runtime/session-meta.js", () => ({
  listAcpSessionEntries: acpMocks.listAcpSessionEntries,
  readAcpSessionEntry: acpMocks.readAcpSessionEntry,
  upsertAcpSessionMeta: acpMocks.upsertAcpSessionMeta,
}));
vi.mock("../../acp/runtime/registry.js", () => ({
  getAcpRuntimeBackend: acpMocks.getAcpRuntimeBackend,
  requireAcpRuntimeBackend: acpMocks.requireAcpRuntimeBackend,
}));
vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    bind: vi.fn(async () => {
      throw new Error("bind not mocked");
    }),
    getCapabilities: vi.fn(() => ({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"] as const,
    })),
    listBySession: (targetSessionKey: string) =>
      sessionBindingMocks.listBySession(targetSessionKey),
    resolveByConversation: sessionBindingMocks.resolveByConversation,
    touch: sessionBindingMocks.touch,
    unbind: vi.fn(async () => []),
  }),
}));
vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent: (params: unknown) => agentEventMocks.emitAgentEvent(params),
  onAgentEvent: (listener: unknown) => agentEventMocks.onAgentEvent(listener),
}));
vi.mock("../../plugins/conversation-binding.js", () => ({
  buildPluginBindingDeclinedText: () => "Plugin binding request was declined.",
  buildPluginBindingErrorText: () => "Plugin binding request failed.",
  buildPluginBindingUnavailableText: (binding: { pluginName?: string; pluginId: string }) =>
    `${binding.pluginName ?? binding.pluginId} is not currently loaded.`,
  hasShownPluginBindingFallbackNotice: (bindingId: string) =>
    pluginConversationBindingMocks.shownFallbackNoticeBindingIds.has(bindingId),
  isPluginOwnedSessionBindingRecord: (
    record: SessionBindingRecord | null | undefined,
  ): record is SessionBindingRecord =>
    record?.metadata != null &&
    typeof record.metadata === "object" &&
    (record.metadata as { pluginBindingOwner?: string }).pluginBindingOwner === "plugin",
  markPluginBindingFallbackNoticeShown: (bindingId: string) => {
    pluginConversationBindingMocks.shownFallbackNoticeBindingIds.add(bindingId);
  },
  toPluginConversationBinding: (record: SessionBindingRecord) => {
    const metadata = (record.metadata ?? {}) as {
      pluginId?: string;
      pluginName?: string;
      pluginRoot?: string;
    };
    return {
      bindingId: record.bindingId,
      pluginId: metadata.pluginId ?? "unknown-plugin",
      pluginName: metadata.pluginName,
      pluginRoot: metadata.pluginRoot ?? "",
      channel: record.conversation.channel,
      accountId: record.conversation.accountId,
      conversationId: record.conversation.conversationId,
      parentConversationId: record.conversation.parentConversationId,
    };
  },
}));
vi.mock("./dispatch-acp-manager.runtime.js", () => ({
  getAcpSessionManager: () => acpManagerRuntimeMocks.getAcpSessionManager(),
  getSessionBindingService: () => ({
    listBySession: (targetSessionKey: string) =>
      sessionBindingMocks.listBySession(targetSessionKey),
    unbind: vi.fn(async () => []),
  }),
}));
vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
  normalizeTtsAutoMode: (value: unknown) => ttsMocks.normalizeTtsAutoMode(value),
  resolveTtsConfig: (cfg: OpenClawConfig) => ttsMocks.resolveTtsConfig(cfg),
}));
vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));
vi.mock("./reply-media-paths.runtime.js", () => ({
  createReplyMediaPathNormalizer: (params: unknown) =>
    replyMediaPathMocks.createReplyMediaPathNormalizer(params),
}));
vi.mock("../../tts/status-config.js", () => ({
  resolveStatusTtsSnapshot: () => ({
    autoMode: "always",
    provider: "auto",
    maxLength: 1500,
    summarize: true,
  }),
}));
vi.mock("./dispatch-acp-tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));
vi.mock("./dispatch-acp-session.runtime.js", () => ({
  readAcpSessionEntry: (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
    acpMocks.readAcpSessionEntry(params),
}));
vi.mock("../../tts/tts-config.js", () => ({
  normalizeTtsAutoMode: (value: unknown) => ttsMocks.normalizeTtsAutoMode(value),
  resolveConfiguredTtsMode: (cfg: OpenClawConfig) => ttsMocks.resolveTtsConfig(cfg).mode,
  shouldAttemptTtsPayload: () => true,
}));

const noAbortResult = { handled: false, aborted: false } as const;
const emptyConfig = {} as OpenClawConfig;
let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acp-runtime.js").tryDispatchAcpReplyHook;
type DispatchReplyArgs = Parameters<
  typeof import("./dispatch-from-config.js").dispatchReplyFromConfig
>[0];

beforeAll(async () => {
  ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
  await import("./dispatch-acp.js");
  await import("./dispatch-acp-command-bypass.js");
  await import("./dispatch-acp-tts.runtime.js");
  await import("./dispatch-acp-session.runtime.js");
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acp-runtime.js"));
});

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

function shouldUseAcpReplyDispatchHook(eventUnknown: unknown): boolean {
  const event = eventUnknown as {
    sessionKey?: string;
    ctx?: {
      SessionKey?: string;
      CommandTargetSessionKey?: string;
      AcpDispatchTailAfterReset?: boolean;
    };
  };
  if (event.ctx?.AcpDispatchTailAfterReset) {
    return true;
  }
  return [event.sessionKey, event.ctx?.SessionKey, event.ctx?.CommandTargetSessionKey].some(
    (value) => {
      const key = value?.trim();
      return Boolean(key && (key.includes("acp:") || key.includes(":acp") || key.includes("-acp")));
    },
  );
}

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

type MockAcpRuntime = AcpRuntime & {
  ensureSession: Mock<(input: AcpRuntimeEnsureInput) => Promise<AcpRuntimeHandle>>;
  runTurn: Mock<(input: AcpRuntimeTurnInput) => AsyncIterable<AcpRuntimeEvent>>;
  cancel: Mock<(input: { handle: AcpRuntimeHandle; reason?: string }) => Promise<void>>;
  close: Mock<(input: { handle: AcpRuntimeHandle; reason: string }) => Promise<void>>;
};

function createAcpRuntime(events: AcpRuntimeEvent[]): MockAcpRuntime {
  const runtime = {
    ensureSession: vi.fn<(input: AcpRuntimeEnsureInput) => Promise<AcpRuntimeHandle>>(
      async (input) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:${input.mode}`,
      }),
    ),
    runTurn: vi.fn<(input: AcpRuntimeTurnInput) => AsyncIterable<AcpRuntimeEvent>>(
      async function* (_input) {
        for (const event of events) {
          yield event;
        }
      },
    ),
    cancel: vi.fn<(input: { handle: AcpRuntimeHandle; reason?: string }) => Promise<void>>(
      async () => {},
    ),
    close: vi.fn<(input: { handle: AcpRuntimeHandle; reason: string }) => Promise<void>>(
      async () => {},
    ),
  } satisfies AcpRuntime;
  return runtime as MockAcpRuntime;
}

function createMockAcpSessionManager() {
  return {
    resolveSession: (params: { cfg: OpenClawConfig; sessionKey: string }) => {
      const entry = acpMocks.readAcpSessionEntry({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
      }) as { acp?: Record<string, unknown> } | null;
      if (entry?.acp) {
        return {
          kind: "ready" as const,
          sessionKey: params.sessionKey,
          meta: entry.acp,
        };
      }
      return params.sessionKey.startsWith("agent:")
        ? {
            kind: "stale" as const,
            sessionKey: params.sessionKey,
            error: {
              code: "ACP_SESSION_INIT_FAILED",
              message: `ACP metadata is missing for ${params.sessionKey}.`,
            },
          }
        : {
            kind: "none" as const,
            sessionKey: params.sessionKey,
          };
    },
    getObservabilitySnapshot: () => ({
      runtimeCache: {
        activeSessions: 0,
        idleTtlMs: 0,
        evictedTotal: 0,
      },
      turns: {
        active: 0,
        queueDepth: 0,
        completed: 0,
        failed: 0,
        averageLatencyMs: 0,
        maxLatencyMs: 0,
      },
      errorsByCode: {},
    }),
    runTurn: vi.fn(
      async (params: {
        cfg: OpenClawConfig;
        sessionKey: string;
        text?: string;
        attachments?: unknown[];
        mode: string;
        requestId: string;
        signal?: AbortSignal;
        onEvent: (event: Record<string, unknown>) => Promise<void>;
      }) => {
        const entry = acpMocks.readAcpSessionEntry({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
        }) as {
          acp?: {
            agent?: string;
            mode?: string;
          };
        } | null;
        const runtimeBackend = acpMocks.requireAcpRuntimeBackend() as {
          runtime?: ReturnType<typeof createAcpRuntime>;
        };
        if (!runtimeBackend.runtime) {
          throw new Error("ACP runtime backend not mocked");
        }
        const handle = await runtimeBackend.runtime.ensureSession({
          sessionKey: params.sessionKey,
          mode: (entry?.acp?.mode || "persistent") as AcpRuntimeEnsureInput["mode"],
          agent: entry?.acp?.agent || "codex",
        });
        const stream = runtimeBackend.runtime.runTurn({
          handle,
          text: params.text ?? "",
          attachments: params.attachments as AcpRuntimeTurnInput["attachments"],
          mode: params.mode as AcpRuntimeTurnInput["mode"],
          requestId: params.requestId,
          signal: params.signal,
        });
        for await (const event of stream) {
          await params.onEvent(event);
        }
        if (entry?.acp?.mode === "oneshot") {
          await runtimeBackend.runtime.close({
            handle,
            reason: "oneshot-complete",
          });
        }
      },
    ),
  };
}

function firstToolResultPayload(dispatcher: ReplyDispatcher): ReplyPayload | undefined {
  return (dispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
    | ReplyPayload
    | undefined;
}

async function dispatchTwiceWithFreshDispatchers(params: Omit<DispatchReplyArgs, "dispatcher">) {
  await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
  await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
}

describe("dispatchReplyFromConfig", () => {
  beforeEach(() => {
    const discordTestPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        capabilities: {
          chatTypes: ["direct"],
          nativeCommands: true,
        },
      }),
      outbound: {
        deliveryMode: "direct",
        shouldSuppressLocalPayloadPrompt: ({ payload }: { payload: ReplyPayload }) =>
          Boolean(
            payload.channelData &&
            typeof payload.channelData === "object" &&
            !Array.isArray(payload.channelData) &&
            payload.channelData.execApproval,
          ),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: discordTestPlugin,
        },
      ]),
    );
    acpManagerRuntimeMocks.getAcpSessionManager.mockReset();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReturnValue(createMockAcpSessionManager());
    resetInboundDedupe();
    mocks.routeReply.mockReset();
    mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    diagnosticMocks.logMessageQueued.mockClear();
    diagnosticMocks.logMessageProcessed.mockClear();
    diagnosticMocks.logSessionStateChange.mockClear();
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_dispatch",
    );
    hookMocks.runner.runInboundClaim.mockClear();
    hookMocks.runner.runInboundClaim.mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPlugin.mockClear();
    hookMocks.runner.runInboundClaimForPlugin.mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runMessageReceived.mockClear();
    hookMocks.runner.runBeforeDispatch.mockClear();
    hookMocks.runner.runBeforeDispatch.mockResolvedValue(undefined);
    hookMocks.runner.runReplyDispatch.mockClear();
    hookMocks.runner.runReplyDispatch.mockImplementation(async (event: unknown, ctx: unknown) => {
      if (!shouldUseAcpReplyDispatchHook(event)) {
        return undefined;
      }
      return (await tryDispatchAcpReplyHook(event as never, ctx as never)) ?? undefined;
    });
    hookMocks.registry.plugins = [];
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockClear();
    acpMocks.readAcpSessionEntry.mockReset();
    acpMocks.readAcpSessionEntry.mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset();
    acpMocks.upsertAcpSessionMeta.mockResolvedValue(null);
    acpMocks.getAcpRuntimeBackend.mockReset();
    acpMocks.requireAcpRuntimeBackend.mockReset();
    agentEventMocks.emitAgentEvent.mockReset();
    agentEventMocks.onAgentEvent.mockReset();
    agentEventMocks.onAgentEvent.mockReturnValue(() => {});
    sessionBindingMocks.listBySession.mockReset();
    sessionBindingMocks.listBySession.mockReturnValue([]);
    pluginConversationBindingMocks.shownFallbackNoticeBindingIds.clear();
    sessionBindingMocks.resolveByConversation.mockReset();
    sessionBindingMocks.resolveByConversation.mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionStore.mockClear();
    sessionStoreMocks.resolveStorePath.mockClear();
    sessionStoreMocks.resolveSessionStoreEntry.mockClear();
    threadInfoMocks.parseSessionThreadInfo.mockReset();
    threadInfoMocks.parseSessionThreadInfo.mockImplementation(parseGenericThreadSessionInfo);
    ttsMocks.state.synthesizeFinalAudio = false;
    ttsMocks.maybeApplyTtsToPayload.mockClear();
    ttsMocks.normalizeTtsAutoMode.mockClear();
    ttsMocks.resolveTtsConfig.mockClear();
    ttsMocks.resolveTtsConfig.mockReturnValue({
      mode: "final",
    });
    replyMediaPathMocks.createReplyMediaPathNormalizer.mockReset();
    replyMediaPathMocks.createReplyMediaPathNormalizer.mockReturnValue(
      async (payload: ReplyPayload) => payload,
    );
  });
  it("does not route when Provider matches OriginatingChannel (even if Surface is missing)", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: undefined,
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("routes when OriginatingChannel differs from Provider", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      AccountId: "acc-1",
      MessageThreadId: 123,
      GroupChannel: "ops-room",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:999",
        accountId: "acc-1",
        threadId: 123,
        isGroup: true,
        groupId: "telegram:999",
      }),
    );
  });

  it("falls back to thread-scoped session key when current ctx has no MessageThreadId", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    sessionStoreMocks.currentEntry = {
      deliveryContext: {
        channel: "discord",
        to: "channel:CHAN1",
        accountId: "default",
      },
      origin: {
        threadId: "stale-origin-root",
      },
      lastThreadId: "stale-origin-root",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      SessionKey: "agent:main:discord:channel:CHAN1:thread:post-root",
      AccountId: "default",
      MessageThreadId: undefined,
      OriginatingChannel: "discord",
      OriginatingTo: "channel:CHAN1",
      ExplicitDeliverRoute: true,
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:CHAN1",
        threadId: "post-root",
      }),
    );
  });

  it("does not resurrect a cleared route thread from origin metadata", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    // Simulate the real store: lastThreadId and deliveryContext.threadId may be normalised from
    // origin.threadId on read, but a non-thread session key must still route to channel root.
    sessionStoreMocks.currentEntry = {
      deliveryContext: {
        channel: "mattermost",
        to: "channel:CHAN1",
        accountId: "default",
        threadId: "stale-root",
      },
      lastThreadId: "stale-root",
      origin: {
        threadId: "stale-root",
      },
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      SessionKey: "agent:main:mattermost:channel:CHAN1",
      AccountId: "default",
      MessageThreadId: undefined,
      OriginatingChannel: "mattermost",
      OriginatingTo: "channel:CHAN1",
      ExplicitDeliverRoute: true,
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const routeCall = mocks.routeReply.mock.calls[0]?.[0] as
      | { channel?: string; to?: string; threadId?: string | number }
      | undefined;
    expect(routeCall).toMatchObject({
      channel: "mattermost",
      to: "channel:CHAN1",
    });
    expect(routeCall?.threadId).toBeUndefined();
  });

  it("forces suppressTyping when routing to a different originating channel", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.suppressTyping).toBe(true);
      expect(opts?.typingPolicy).toBe("system_event");
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
  });

  it("forces suppressTyping for internal webchat turns", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      OriginatingTo: "session:abc",
    });

    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.suppressTyping).toBe(true);
      expect(opts?.typingPolicy).toBe("internal_webchat");
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
  });

  it("routes when provider is webchat but surface carries originating channel metadata", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:999",
      }),
    );
  });

  it("routes Feishu replies when provider is webchat and origin metadata points to Feishu", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: "ou_feishu_direct_123",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "feishu",
        to: "ou_feishu_direct_123",
      }),
    );
  });

  it("does not route when provider already matches originating channel", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "webchat",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("does not route external origin replies when current surface is internal webchat without explicit delivery", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:+15550001111",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("routes external origin replies for internal webchat turns when explicit delivery is set", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:+15550001111",
      ExplicitDeliverRoute: true,
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "imessage",
        to: "imessage:+15550001111",
      }),
    );
  });

  it("routes media-only tool results when summaries are suppressed", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      ChatType: "group",
      AccountId: "acc-1",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      await opts?.onToolResult?.({
        text: "NO_REPLY",
        mediaUrls: ["https://example.com/tts-routed.opus"],
      });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyMediaPathMocks.createReplyMediaPathNormalizer).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        messageProvider: "telegram",
      }),
    );
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledTimes(1);
    const routed = mocks.routeReply.mock.calls[0]?.[0] as { payload?: ReplyPayload } | undefined;
    expect(routed?.payload?.mediaUrls).toEqual(["https://example.com/tts-routed.opus"]);
    expect(routed?.payload?.text).toBeUndefined();
  });

  it("provides onToolResult in DM sessions", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      expect(typeof opts?.onToolResult).toBe("function");
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses group tool summaries but still forwards tool media", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      await opts?.onToolResult?.({
        text: "NO_REPLY",
        mediaUrls: ["https://example.com/tts-group.opus"],
      });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    const sent = firstToolResultPayload(dispatcher);
    expect(sent?.mediaUrls).toEqual(["https://example.com/tts-group.opus"]);
    expect(sent?.text).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("normalizes tool-result media before delivery and drops blocked file URLs", async () => {
    setNoAbort();
    replyMediaPathMocks.createReplyMediaPathNormalizer.mockReturnValue(
      async (payload: ReplyPayload) => ({
        ...payload,
        mediaUrl: undefined,
        mediaUrls: undefined,
      }),
    );
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "group",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({
        text: "NO_REPLY",
        mediaUrls: ["file://attacker/share/probe.mp3"],
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyMediaPathMocks.createReplyMediaPathNormalizer).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        messageProvider: "webchat",
      }),
    );
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("delivers tool summaries in forum topic sessions (group + IsForum)", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
      IsForum: true,
      MessageThreadId: 99,
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ text: "🔧 exec: ls" }),
    );
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers deterministic exec approval tool payloads in groups", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({
        text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
        channelData: {
          execApproval: {
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)).toEqual(
      expect.objectContaining({
        text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
        channelData: {
          execApproval: {
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      }),
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "NO_REPLY" });
  });

  it("sends tool results via dispatcher in DM sessions", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      // Simulate tool result emission
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ text: "🔧 exec: ls" }),
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers native tool summaries and tool media", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      CommandSource: "native",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      await opts?.onToolResult?.({ text: "🔧 tools/sessions_send" });
      await opts?.onToolResult?.({
        mediaUrl: "https://example.com/tts-native.opus",
      });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(2);
    expect(dispatcher.sendToolResult).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "🔧 tools/sessions_send" }),
    );
    const sent = (dispatcher.sendToolResult as Mock).mock.calls[1]?.[0] as ReplyPayload | undefined;
    expect(sent?.mediaUrl).toBe("https://example.com/tts-native.opus");
    expect(sent?.text).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("renders plain-text plan updates and concise approval progress when verbose is enabled", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onPlanUpdate?.({
        phase: "update",
        explanation: "Inspect code, patch it, run tests.",
        steps: ["Inspect code", "Patch code", "Run tests"],
      });
      await opts?.onApprovalEvent?.({
        phase: "requested",
        status: "pending",
        command: "pnpm test",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        text: "Inspect code, patch it, run tests.\n\n1. Inspect code\n2. Patch code\n3. Run tests",
      }),
    );
    expect(dispatcher.sendToolResult).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "Working: awaiting approval: pnpm test" }),
    );
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(2);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("renders concise patch summaries when verbose is enabled", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onPatchSummary?.({
        phase: "end",
        title: "apply patch",
        summary: "1 added, 2 modified",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "Working: 1 added, 2 modified" }),
    );
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("suppresses plan and working-status progress when session verbose is off", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = {
      ...emptyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:main",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onPlanUpdate?.({
        phase: "update",
        explanation: "Inspect code, patch it, run tests.",
        steps: ["Inspect code", "Patch code", "Run tests"],
      });
      await opts?.onApprovalEvent?.({
        phase: "requested",
        status: "pending",
        command: "pnpm test",
      });
      await opts?.onPatchSummary?.({
        phase: "end",
        title: "apply patch",
        summary: "1 added, 2 modified",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("suppresses text-only tool summaries when preview tool-progress suppression is enabled", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("still delivers media-only tool payloads when preview tool-progress suppression is enabled", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({ mediaUrl: "https://example.com/tts-preview.opus" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "https://example.com/tts-preview.opus" }),
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("delivers deterministic exec approval tool payloads for native commands", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      CommandSource: "native",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({
        text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
        channelData: {
          execApproval: {
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)).toEqual(
      expect.objectContaining({
        channelData: {
          execApproval: {
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      }),
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "NO_REPLY" });
  });

  it("fast-aborts without calling the reply resolver", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
    });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "/stop",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted.",
    });
  });

  it("fast-abort reply includes stopped subagent count when provided", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
      stoppedSubagents: 2,
    });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "/stop",
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver: vi.fn(async () => ({ text: "hi" }) as ReplyPayload),
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted. Stopped 2 sub-agents.",
    });
  });

  it("routes ACP sessions through the runtime branch and streams block replies", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([
      { type: "text_delta", text: "hello " },
      { type: "text_delta", text: "world" },
      { type: "done" },
    ]);
    let currentAcpEntry = {
      sessionKey: "agent:codex-acp:session-1",
      storeSessionKey: "agent:codex-acp:session-1",
      cfg: {},
      storePath: "/tmp/mock-sessions.json",
      entry: {},
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    };
    acpMocks.readAcpSessionEntry.mockImplementation(() => currentAcpEntry);
    acpMocks.upsertAcpSessionMeta.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: Record<string, unknown> | undefined,
          entry: { acp?: Record<string, unknown> } | undefined,
        ) => Record<string, unknown> | null | undefined;
      };
      const nextMeta = params.mutate(currentAcpEntry.acp as Record<string, unknown>, {
        acp: currentAcpEntry.acp as Record<string, unknown>,
      });
      if (nextMeta === null) {
        return null;
      }
      if (nextMeta) {
        currentAcpEntry = {
          ...currentAcpEntry,
          acp: nextMeta as typeof currentAcpEntry.acp,
        };
      }
      return currentAcpEntry;
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const cfg = {
      acp: {
        enabled: true,
        dispatch: { enabled: true },
        stream: { coalesceIdleMs: 0, maxChunkChars: 128 },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:codex-acp:session-1",
      BodyForAgent: "write a test",
    });
    const replyResolver = vi.fn(async () => ({ text: "fallback" }) as ReplyPayload);

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(runtime.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:codex-acp:session-1",
        agent: "codex",
        mode: "persistent",
      }),
    );
    const blockCalls = (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(blockCalls.length).toBeGreaterThan(0);
    const streamedText = blockCalls.map((call) => (call[0] as ReplyPayload).text ?? "").join("");
    expect(streamedText).toContain("hello");
    expect(streamedText).toContain("world");
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "hello world" }),
    );
  });

  it("emits lifecycle end for ACP turns using the current run id", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([{ type: "text_delta", text: "done" }, { type: "done" }]);
    acpMocks.readAcpSessionEntry.mockReturnValue({
      sessionKey: "agent:codex-acp:session-1",
      storeSessionKey: "agent:codex-acp:session-1",
      cfg: {},
      storePath: "/tmp/mock-sessions.json",
      entry: {},
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:codex-acp:session-1",
      BodyForAgent: "write a test",
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: {
        acp: {
          enabled: true,
          dispatch: { enabled: true },
          stream: { coalesceIdleMs: 0, maxChunkChars: 128 },
        },
      } as OpenClawConfig,
      dispatcher,
      replyOptions: {
        runId: "run-acp-lifecycle-end",
      },
    });

    expect(agentEventMocks.emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-acp-lifecycle-end",
        sessionKey: "agent:codex-acp:session-1",
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "end",
        }),
      }),
    );
  });

  it("emits lifecycle error for ACP turn failures using the current run id", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([]);
    runtime.runTurn.mockImplementation(async function* () {
      yield { type: "status", tag: "usage_update", text: "warming up" };
      throw new Error("ACP exploded");
    });
    acpMocks.readAcpSessionEntry.mockReturnValue({
      sessionKey: "agent:codex-acp:session-1",
      storeSessionKey: "agent:codex-acp:session-1",
      cfg: {},
      storePath: "/tmp/mock-sessions.json",
      entry: {},
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:codex-acp:session-1",
      BodyForAgent: "write a test",
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: {
        acp: {
          enabled: true,
          dispatch: { enabled: true },
          stream: { coalesceIdleMs: 0, maxChunkChars: 128 },
        },
      } as OpenClawConfig,
      dispatcher,
      replyOptions: {
        runId: "run-acp-lifecycle-error",
      },
    });

    expect(agentEventMocks.emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-acp-lifecycle-error",
        sessionKey: "agent:codex-acp:session-1",
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "error",
          error: expect.stringContaining("ACP exploded"),
        }),
      }),
    );
  });

  it("posts a one-time resolved-session-id notice in thread after the first ACP turn", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([{ type: "text_delta", text: "hello" }, { type: "done" }]);
    const pendingAcp = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime:1",
      identity: {
        state: "pending" as const,
        source: "ensure" as const,
        lastUpdatedAt: Date.now(),
        acpxSessionId: "acpx-123",
        agentSessionId: "inner-123",
      },
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: Date.now(),
    };
    const resolvedAcp = {
      ...pendingAcp,
      identity: {
        ...pendingAcp.identity,
        state: "resolved" as const,
        source: "status" as const,
      },
    };
    acpMocks.readAcpSessionEntry.mockImplementation(() => {
      const runTurnStarted = runtime.runTurn.mock.calls.length > 0;
      return {
        sessionKey: "agent:codex-acp:session-1",
        storeSessionKey: "agent:codex-acp:session-1",
        cfg: {},
        storePath: "/tmp/mock-sessions.json",
        entry: {},
        acp: runTurnStarted ? resolvedAcp : pendingAcp,
      };
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const cfg = {
      acp: {
        enabled: true,
        dispatch: { enabled: true },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:codex-acp:session-1",
      MessageThreadId: "thread-1",
      BodyForAgent: "show ids",
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver: vi.fn() });

    const finalCalls = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(finalCalls.length).toBe(2);
    const noticePayload = finalCalls[1]?.[0] as ReplyPayload | undefined;
    expect(noticePayload?.text).toContain("Session ids resolved");
    expect(noticePayload?.text).toContain("agent session id: inner-123");
    expect(noticePayload?.text).toContain("acpx session id: acpx-123");
    expect(noticePayload?.text).toContain("codex resume inner-123");
  });

  it("posts resolved-session-id notice when ACP session is bound even without MessageThreadId", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([{ type: "text_delta", text: "hello" }, { type: "done" }]);
    const pendingAcp = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime:1",
      identity: {
        state: "pending" as const,
        source: "ensure" as const,
        lastUpdatedAt: Date.now(),
        acpxSessionId: "acpx-123",
        agentSessionId: "inner-123",
      },
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: Date.now(),
    };
    const resolvedAcp = {
      ...pendingAcp,
      identity: {
        ...pendingAcp.identity,
        state: "resolved" as const,
        source: "status" as const,
      },
    };
    acpMocks.readAcpSessionEntry.mockImplementation(() => {
      const runTurnStarted = runtime.runTurn.mock.calls.length > 0;
      return {
        sessionKey: "agent:codex-acp:session-1",
        storeSessionKey: "agent:codex-acp:session-1",
        cfg: {},
        storePath: "/tmp/mock-sessions.json",
        entry: {},
        acp: runTurnStarted ? resolvedAcp : pendingAcp,
      };
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });
    sessionBindingMocks.listBySession.mockReturnValue([
      {
        bindingId: "default:thread-1",
        targetSessionKey: "agent:codex-acp:session-1",
        targetKind: "session",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
        },
        status: "active",
        boundAt: Date.now(),
      },
    ]);

    const cfg = {
      acp: {
        enabled: true,
        dispatch: { enabled: true },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      AccountId: "default",
      SessionKey: "agent:codex-acp:session-1",
      MessageThreadId: undefined,
      BodyForAgent: "show ids",
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver: vi.fn() });

    const finalCalls = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(finalCalls.length).toBe(2);
    const noticePayload = finalCalls[1]?.[0] as ReplyPayload | undefined;
    expect(noticePayload?.text).toContain("Session ids resolved");
    expect(noticePayload?.text).toContain("agent session id: inner-123");
    expect(noticePayload?.text).toContain("acpx session id: acpx-123");
  });

  it("honors the configured default account when resolving plugin-owned binding fallbacks", async () => {
    setNoAbort();
    sessionBindingMocks.resolveByConversation.mockImplementation(
      (ref: {
        channel: string;
        accountId: string;
        conversationId: string;
        parentConversationId?: string;
      }) =>
        ref.channel === "discord" && ref.accountId === "work" && ref.conversationId === "thread-1"
          ? ({
              bindingId: "plugin:work:thread-1",
              targetSessionKey: "plugin-binding:missing-plugin",
              targetKind: "session",
              conversation: {
                channel: "discord",
                accountId: "work",
                conversationId: "thread-1",
              },
              status: "active",
              boundAt: Date.now(),
              metadata: {
                pluginBindingOwner: "plugin",
                pluginId: "missing-plugin",
                pluginRoot: "/plugins/missing-plugin",
                pluginName: "Missing Plugin",
              },
            } satisfies SessionBindingRecord)
          : null,
    );

    const cfg = {
      channels: {
        discord: {
          defaultAccount: "work",
        },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      To: "discord:thread-1",
      SessionKey: "main",
      BodyForAgent: "fallback",
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(sessionBindingMocks.resolveByConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        accountId: "work",
        conversationId: "thread-1",
      }),
    );
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("not currently loaded"),
      }),
    );
    expect(replyResolver).toHaveBeenCalled();
  });

  it("coalesces tiny ACP token deltas into normal Discord text spacing", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([
      { type: "text_delta", text: "What" },
      { type: "text_delta", text: " do" },
      { type: "text_delta", text: " you" },
      { type: "text_delta", text: " want" },
      { type: "text_delta", text: " to" },
      { type: "text_delta", text: " work" },
      { type: "text_delta", text: " on?" },
      { type: "done" },
    ]);
    acpMocks.readAcpSessionEntry.mockReturnValue({
      sessionKey: "agent:codex-acp:session-1",
      storeSessionKey: "agent:codex-acp:session-1",
      cfg: {},
      storePath: "/tmp/mock-sessions.json",
      entry: {},
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const cfg = {
      acp: {
        enabled: true,
        dispatch: { enabled: true },
        stream: { coalesceIdleMs: 0, maxChunkChars: 256 },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:codex-acp:session-1",
      BodyForAgent: "test spacing",
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher });

    const blockTexts = (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => ((call[0] as ReplyPayload).text ?? "").trim())
      .filter(Boolean);
    expect(blockTexts).toEqual(["What do you want to work on?"]);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "What do you want to work on?" }),
    );
  });

  it("generates final-mode TTS audio after ACP block streaming completes", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const runtime = createAcpRuntime([
      { type: "text_delta", text: "Hello from ACP streaming." },
      { type: "done" },
    ]);
    acpMocks.readAcpSessionEntry.mockReturnValue({
      sessionKey: "agent:codex-acp:session-1",
      storeSessionKey: "agent:codex-acp:session-1",
      cfg: {},
      storePath: "/tmp/mock-sessions.json",
      entry: {},
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const cfg = {
      acp: {
        enabled: true,
        dispatch: { enabled: true },
        stream: { coalesceIdleMs: 0, maxChunkChars: 256 },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:codex-acp:session-1",
      BodyForAgent: "stream this",
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher });

    const finalPayload = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalPayload?.mediaUrl).toBe("https://example.com/tts-synth.opus");
    expect(finalPayload?.text).toBeUndefined();
  });

  it("closes oneshot ACP sessions after the turn completes", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([{ type: "done" }]);
    acpMocks.readAcpSessionEntry.mockReturnValue({
      sessionKey: "agent:codex-acp:oneshot-1",
      storeSessionKey: "agent:codex-acp:oneshot-1",
      cfg: {},
      storePath: "/tmp/mock-sessions.json",
      entry: {},
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:oneshot",
        mode: "oneshot",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const cfg = {
      acp: {
        enabled: true,
        dispatch: { enabled: true },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:codex-acp:oneshot-1",
      BodyForAgent: "run once",
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher });

    expect(runtime.close).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "oneshot-complete",
      }),
    );
  });

  it("deduplicates inbound messages by MessageSid and origin", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      MessageSid: "msg-1",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchTwiceWithFreshDispatchers({
      ctx,
      cfg,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("suppresses local discord exec approval tool prompts when discord approvals are enabled", async () => {
    setNoAbort();
    const cfg = {
      channels: {
        discord: {
          enabled: true,
          execApprovals: {
            enabled: true,
            approvers: ["123"],
          },
        },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      AccountId: "default",
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, options?: GetReplyOptions) => {
      await options?.onToolResult?.({
        text: "Approval required.",
        channelData: {
          execApproval: {
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      });
      return { text: "done" } as ReplyPayload;
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "done" }),
    );
  });

  it("deduplicates same-agent inbound replies across main and direct session keys", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);
    const baseCtx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:7463849194",
      MessageSid: "msg-1",
      SessionKey: "agent:main:main",
    });

    await dispatchReplyFromConfig({
      ctx: baseCtx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver,
    });
    await dispatchReplyFromConfig({
      ctx: {
        ...baseCtx,
        SessionKey: "agent:main:telegram:direct:7463849194",
      },
      cfg,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("emits message_received hook with originating channel metadata", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "Telegram",
      OriginatingTo: "telegram:999",
      CommandBody: "/search hello",
      RawBody: "raw text",
      Body: "body text",
      Timestamp: 1710000000000,
      MessageSidFull: "sid-full",
      SenderId: "user-1",
      SenderName: "Alice",
      SenderUsername: "alice",
      SenderE164: "+15555550123",
      AccountId: "acc-1",
      GroupSpace: "guild-123",
      GroupChannel: "alerts",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(hookMocks.runner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        from: ctx.From,
        content: "/search hello",
        timestamp: 1710000000000,
        metadata: expect.objectContaining({
          originatingChannel: "Telegram",
          originatingTo: "telegram:999",
          messageId: "sid-full",
          senderId: "user-1",
          senderName: "Alice",
          senderUsername: "alice",
          senderE164: "+15555550123",
          guildId: "guild-123",
          channelName: "alerts",
        }),
      }),
      expect.objectContaining({
        channelId: "telegram",
        accountId: "acc-1",
        conversationId: "telegram:999",
      }),
    );
  });

  it("does not broadcast inbound claims without a core-owned plugin binding", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.runner.runInboundClaim.mockResolvedValue({ handled: true } as never);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-10099",
      To: "telegram:-10099",
      AccountId: "default",
      SenderId: "user-9",
      SenderUsername: "ada",
      MessageThreadId: 77,
      CommandAuthorized: true,
      WasMentioned: true,
      CommandBody: "who are you",
      RawBody: "who are you",
      Body: "who are you",
      MessageSid: "msg-claim-1",
      SessionKey: "agent:main:telegram:group:-10099:77",
    });
    const replyResolver = vi.fn(async () => ({ text: "core reply" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: true, counts: { tool: 0, block: 0, final: 0 } });
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        from: ctx.From,
        content: "who are you",
        metadata: expect.objectContaining({
          messageId: "msg-claim-1",
          originatingChannel: "telegram",
          originatingTo: "telegram:-10099",
          senderId: "user-9",
          senderUsername: "ada",
          threadId: 77,
        }),
      }),
      expect.objectContaining({
        channelId: "telegram",
        accountId: "default",
        conversationId: "telegram:-10099",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message",
        action: "received",
        sessionKey: "agent:main:telegram:group:-10099:77",
      }),
    );
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "core reply" }),
    );
  });

  it("emits internal message:received hook when a session key is available", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      SessionKey: "agent:main:main",
      CommandBody: "/help",
      MessageSid: "msg-42",
      GroupSpace: "guild-456",
      GroupChannel: "ops-room",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      "agent:main:main",
      expect.objectContaining({
        from: ctx.From,
        content: "/help",
        channelId: "telegram",
        messageId: "msg-42",
        metadata: expect.objectContaining({
          guildId: "guild-456",
          channelName: "ops-room",
        }),
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("skips internal message:received hook when session key is unavailable", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      CommandBody: "/help",
    });
    (ctx as MsgContext).SessionKey = undefined;

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("emits diagnostics when enabled", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      SessionKey: "agent:main:main",
      MessageSid: "msg-1",
      To: "slack:C123",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logSessionStateChange).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      state: "processing",
      reason: "message_start",
    });
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        outcome: "completed",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("routes plugin-owned bindings to the owning plugin before generic inbound claim broadcast", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-1",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
    } satisfies SessionBindingRecord);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:1481858418548412579",
      To: "discord:channel:1481858418548412579",
      AccountId: "default",
      SenderId: "user-9",
      SenderUsername: "ada",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "who are you",
      RawBody: "who are you",
      Body: "who are you",
      MessageSid: "msg-claim-plugin-1",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-1");
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledWith(
      "openclaw-codex-app-server",
      expect.objectContaining({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
        content: "who are you",
      }),
      expect.objectContaining({
        channelId: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      }),
    );
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("routes plugin-owned Discord DM bindings to the owning plugin before generic inbound claim broadcast", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-dm-1",
      targetSessionKey: "plugin-binding:codex:dm123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
    } satisfies SessionBindingRecord);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      From: "discord:1177378744822943744",
      OriginatingTo: "channel:1480574946919846079",
      To: "channel:1480574946919846079",
      AccountId: "default",
      SenderId: "user-9",
      SenderUsername: "ada",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "who are you",
      RawBody: "who are you",
      Body: "who are you",
      MessageSid: "msg-claim-plugin-dm-1",
      SessionKey: "agent:main:discord:user:1177378744822943744",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-dm-1");
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledWith(
      "openclaw-codex-app-server",
      expect.objectContaining({
        channel: "discord",
        accountId: "default",
        conversationId: "1480574946919846079",
        content: "who are you",
      }),
      expect.objectContaining({
        channelId: "discord",
        accountId: "default",
        conversationId: "1480574946919846079",
      }),
    );
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("falls back to OpenClaw once per startup when a bound plugin is missing", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "missing_plugin",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-missing-1",
      targetSessionKey: "plugin-binding:codex:missing123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:missing-plugin",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
        detachHint: "/codex_detach",
      },
    } satisfies SessionBindingRecord);

    const replyResolver = vi.fn(async () => ({ text: "openclaw fallback" }) satisfies ReplyPayload);

    const firstDispatcher = createDispatcher();
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:missing-plugin",
        To: "discord:channel:missing-plugin",
        AccountId: "default",
        MessageSid: "msg-missing-plugin-1",
        SessionKey: "agent:main:discord:channel:missing-plugin",
        CommandBody: "hello",
        RawBody: "hello",
        Body: "hello",
      }),
      cfg: emptyConfig,
      dispatcher: firstDispatcher,
      replyResolver,
    });

    const firstNotice = (firstDispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(firstNotice?.text).toContain("is not currently loaded.");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();

    replyResolver.mockClear();
    hookMocks.runner.runInboundClaim.mockClear();

    const secondDispatcher = createDispatcher();
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:missing-plugin",
        To: "discord:channel:missing-plugin",
        AccountId: "default",
        MessageSid: "msg-missing-plugin-2",
        SessionKey: "agent:main:discord:channel:missing-plugin",
        CommandBody: "still there?",
        RawBody: "still there?",
        Body: "still there?",
      }),
      cfg: emptyConfig,
      dispatcher: secondDispatcher,
      replyResolver,
    });

    expect(secondDispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("falls back to OpenClaw when the bound plugin is loaded but has no inbound_claim handler", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-no-handler-1",
      targetSessionKey: "plugin-binding:codex:nohandler123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:no-handler",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
    } satisfies SessionBindingRecord);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "openclaw fallback" }) satisfies ReplyPayload);

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:no-handler",
        To: "discord:channel:no-handler",
        AccountId: "default",
        MessageSid: "msg-no-handler-1",
        SessionKey: "agent:main:discord:channel:no-handler",
        CommandBody: "hello",
        RawBody: "hello",
        Body: "hello",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    const notice = (dispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | ReplyPayload
      | undefined;
    expect(notice?.text).toContain("is not currently loaded.");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("notifies the user when a bound plugin declines the turn and keeps the binding attached", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "declined",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-declined-1",
      targetSessionKey: "plugin-binding:codex:declined123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:declined",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
        detachHint: "/codex_detach",
      },
    } satisfies SessionBindingRecord);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:declined",
        To: "discord:channel:declined",
        AccountId: "default",
        MessageSid: "msg-declined-1",
        SessionKey: "agent:main:discord:channel:declined",
        CommandBody: "hello",
        RawBody: "hello",
        Body: "hello",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    const finalNotice = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalNotice?.text).toContain("Plugin binding request was declined.");
    expect(replyResolver).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("notifies the user when a bound plugin errors and keeps raw details out of the reply", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "error",
      error: "boom",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-error-1",
      targetSessionKey: "plugin-binding:codex:error123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:error",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
    } satisfies SessionBindingRecord);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:error",
        To: "discord:channel:error",
        AccountId: "default",
        MessageSid: "msg-error-1",
        SessionKey: "agent:main:discord:channel:error",
        CommandBody: "hello",
        RawBody: "hello",
        Body: "hello",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    const finalNotice = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalNotice?.text).toContain("Plugin binding request failed.");
    expect(finalNotice?.text).not.toContain("boom");
    expect(replyResolver).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("marks diagnostics skipped for duplicate inbound messages", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      MessageSid: "msg-dup",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchTwiceWithFreshDispatchers({
      ctx,
      cfg,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        outcome: "skipped",
        reason: "duplicate",
      }),
    );
  });

  it("releases inbound dedupe when dispatch fails before completion", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550124",
      To: "whatsapp:+15555550124",
      AccountId: "default",
      MessageSid: "msg-dup-error",
      SessionKey: "agent:main:whatsapp:direct:+15555550124",
      CommandBody: "hello",
      RawBody: "hello",
      Body: "hello",
    });
    const replyResolver = vi
      .fn<
        (_ctx: MsgContext, _opts?: GetReplyOptions, _cfg?: OpenClawConfig) => Promise<ReplyPayload>
      >()
      .mockRejectedValueOnce(new Error("dispatch failed"))
      .mockResolvedValueOnce({ text: "retry succeeds" });

    await expect(
      dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher: createDispatcher(),
        replyResolver,
      }),
    ).rejects.toThrow("dispatch failed");

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(2);
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        outcome: "error",
        error: "Error: dispatch failed",
      }),
    );
  });

  it("passes configOverride to replyResolver when provided", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "msteams", Surface: "msteams" });

    const overrideCfg = {
      agents: { defaults: { userTimezone: "America/New_York" } },
    } as OpenClawConfig;

    let receivedCfg: OpenClawConfig | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      cfgArg?: OpenClawConfig,
    ) => {
      receivedCfg = cfgArg;
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      configOverride: overrideCfg,
    });

    expect(receivedCfg).toBe(overrideCfg);
  });

  it("does not pass cfg as implicit configOverride when configOverride is not provided", async () => {
    setNoAbort();
    const cfg = { agents: { defaults: { userTimezone: "UTC" } } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });

    let receivedCfg: OpenClawConfig | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      cfgArg?: OpenClawConfig,
    ) => {
      receivedCfg = cfgArg;
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(receivedCfg).toBeUndefined();
  });

  it("suppresses isReasoning payloads from final replies (WhatsApp channel)", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const replyResolver = async () =>
      [
        { text: "Reasoning:\n_thinking..._", isReasoning: true },
        { text: "The answer is 42" },
      ] satisfies ReplyPayload[];
    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });
    const finalCalls = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(finalCalls).toHaveLength(1);
    expect(finalCalls[0][0]).toMatchObject({ text: "The answer is 42" });
  });

  it("suppresses isReasoning payloads from block replies (generic dispatch path)", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const blockReplySentTexts: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      // Simulate block reply with reasoning payload
      await opts?.onBlockReply?.({ text: "Reasoning:\n_thinking..._", isReasoning: true });
      await opts?.onBlockReply?.({ text: "The answer is 42" });
      return { text: "The answer is 42" };
    };
    // Capture what actually gets dispatched as block replies
    (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: ReplyPayload) => {
        if (payload.text) {
          blockReplySentTexts.push(payload.text);
        }
        return true;
      },
    );
    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });
    expect(blockReplySentTexts).not.toContain("Reasoning:\n_thinking..._");
    expect(blockReplySentTexts).toContain("The answer is 42");
  });

  it("signals block boundaries before async block delivery is queued", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const callOrder: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "The answer is 42" });
      return undefined;
    };

    (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: ReplyPayload) => {
        callOrder.push(`dispatch:${payload.text}`);
        return true;
      },
    );

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        onBlockReplyQueued: (payload) => {
          callOrder.push(`queued:${payload.text}`);
        },
      },
    });

    expect(callOrder).toEqual(["queued:The answer is 42", "dispatch:The answer is 42"]);
  });

  it("forwards payload metadata into onBlockReplyQueued context", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const onBlockReplyQueued = vi.fn();
    const { setReplyPayloadMetadata } = await import("../types.js");
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      const payload = setReplyPayloadMetadata({ text: "Alpha" }, { assistantMessageIndex: 7 });
      await opts?.onBlockReply?.(payload);
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onBlockReplyQueued },
    });

    expect(onBlockReplyQueued).toHaveBeenCalledWith(
      { text: "Alpha" },
      expect.objectContaining({ assistantMessageIndex: 7 }),
    );
  });
});

describe("before_dispatch hook", () => {
  const createHookCtx = (overrides: Partial<MsgContext> = {}) =>
    buildTestCtx({
      Body: "hello",
      BodyForAgent: "hello",
      BodyForCommands: "hello",
      From: "user1",
      Surface: "telegram",
      ChatType: "private",
      ...overrides,
    });

  beforeEach(() => {
    resetInboundDedupe();
    mocks.routeReply.mockReset();
    mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
    threadInfoMocks.parseSessionThreadInfo.mockReset();
    threadInfoMocks.parseSessionThreadInfo.mockImplementation(parseGenericThreadSessionInfo);
    ttsMocks.state.synthesizeFinalAudio = false;
    ttsMocks.maybeApplyTtsToPayload.mockClear();
    setNoAbort();
    hookMocks.runner.runBeforeDispatch.mockClear();
    hookMocks.runner.runBeforeDispatch.mockResolvedValue(undefined);
    hookMocks.runner.runReplyDispatch.mockClear();
    hookMocks.runner.runReplyDispatch.mockResolvedValue(undefined);
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "before_dispatch",
    );
  });

  it("skips model dispatch when hook returns handled", async () => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true, text: "Blocked" });
    const dispatcher = createDispatcher();
    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "Blocked" });
    expect(result.queuedFinal).toBe(true);
  });

  it("silently short-circuits when hook returns handled without text", async () => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true });
    const dispatcher = createDispatcher();
    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
    });
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
  });

  it("uses canonical hook metadata and shared routed final delivery", async () => {
    ttsMocks.state.synthesizeFinalAudio = true;
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true, text: "Blocked" });
    const dispatcher = createDispatcher();
    const ctx = createHookCtx({
      Body: "raw body",
      BodyForAgent: "agent body",
      BodyForCommands: "command body",
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      From: "signal:group:ops-room",
      SenderId: "signal:user:alice",
      GroupChannel: "ops-room",
      ChatType: "direct",
      Timestamp: 123,
    });

    const result = await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher });

    expect(hookMocks.runner.runBeforeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "command body",
        body: "agent body",
        channel: "telegram",
        senderId: "signal:user:alice",
        isGroup: true,
        timestamp: 123,
      }),
      expect.objectContaining({
        channelId: "telegram",
        senderId: "signal:user:alice",
      }),
    );
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:999",
        payload: expect.objectContaining({
          text: "Blocked",
          mediaUrl: "https://example.com/tts-synth.opus",
          audioAsVoice: true,
        }),
      }),
    );
    expect(result.queuedFinal).toBe(true);
  });

  it("suppresses before_dispatch handled reply when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true, text: "Blocked" });
    const dispatcher = createDispatcher();
    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx({ SessionKey: "test:session" }),
      cfg: emptyConfig,
      dispatcher,
    });
    // Hook handled the message (no model dispatch)
    expect(hookMocks.runner.runBeforeDispatch).toHaveBeenCalled();
    // But delivery must be suppressed
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
  });

  it("continues default dispatch when hook returns not handled", async () => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: false });
    const dispatcher = createDispatcher();
    await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "model reply" }),
    });
    expect(hookMocks.runner.runBeforeDispatch).toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "model reply" });
  });
});

describe("sendPolicy deny — suppress delivery, not processing (#53328)", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_dispatch",
    );
    hookMocks.runner.runReplyDispatch.mockResolvedValue(undefined);
    hookMocks.runner.runBeforeDispatch.mockResolvedValue(undefined);
  });

  it("still calls the replyResolver when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    // The agent MUST process the message (replyResolver called)
    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("passes suppressUserDelivery to tail reply_dispatch when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    hookMocks.runner.runReplyDispatch.mockImplementation(async (event: unknown) => {
      const candidate = event as { isTailDispatch?: boolean };
      if (candidate.isTailDispatch) {
        return {
          handled: true,
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        };
      }
      return undefined;
    });
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      SessionKey: "test:session",
      AcpDispatchTailAfterReset: true,
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "agent reply" }),
    });

    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        isTailDispatch: true,
        sendPolicy: "deny",
        suppressUserDelivery: true,
      }),
      expect.any(Object),
    );
  });

  it("suppresses final reply delivery when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    // Delivery MUST be suppressed
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
  });

  it("suppresses tool result delivery when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    let capturedOnToolResult: ((payload: ReplyPayload) => Promise<void>) | undefined;
    const replyResolver = vi.fn(
      async (_ctx: MsgContext, opts?: GetReplyOptions, _cfg?: OpenClawConfig) => {
        capturedOnToolResult = opts?.onToolResult as
          | ((payload: ReplyPayload) => Promise<void>)
          | undefined;
        return { text: "reply" } satisfies ReplyPayload;
      },
    );
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    // Trigger a tool result — delivery should be suppressed
    expect(capturedOnToolResult).toBeDefined();
    await capturedOnToolResult!({ text: "tool output" });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it("suppresses block reply delivery when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    let capturedOnBlockReply:
      | ((payload: ReplyPayload, context?: unknown) => Promise<void>)
      | undefined;
    const replyResolver = vi.fn(
      async (_ctx: MsgContext, opts?: GetReplyOptions, _cfg?: OpenClawConfig) => {
        capturedOnBlockReply = opts?.onBlockReply as
          | ((payload: ReplyPayload, context?: unknown) => Promise<void>)
          | undefined;
        return [] as ReplyPayload[];
      },
    );
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    // Trigger a block reply — delivery should be suppressed
    expect(capturedOnBlockReply).toBeDefined();
    await capturedOnBlockReply!({ text: "streaming chunk" });
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("delivers replies normally when sendPolicy is allow", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers replies normally when sendPolicy is unset (defaults to allow)", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses the fast-abort reply under sendPolicy deny", async () => {
    // Fast-abort runs before sendPolicy in the old code, so the abort reply
    // leaked. Under the guard, the abort is still recorded but no reply is
    // dispatched. See #53328.
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "/stop",
      SessionKey: "test:session",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
  });

  it("delivers the fast-abort reply normally when sendPolicy is allow (regression guard)", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "hi" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "/stop",
      SessionKey: "test:session",
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted.",
    });
  });

  it("skips plugin-bound claim hook under deny and falls through to suppressed agent dispatch", async () => {
    // Plugin-bound inbound handlers can emit outbound replies we cannot
    // rewind. Under deny, skip the plugin claim entirely and let the agent
    // process the message with delivery suppressed. See #53328.
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-deny",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:deny-test",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/tmp/plugin",
      },
    } satisfies SessionBindingRecord);
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:deny-test",
      To: "discord:channel:deny-test",
      AccountId: "default",
      SessionKey: "agent:main:discord:channel:deny-test",
      Body: "observed message",
    });

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    // Binding is still tracked (touch runs before the gate)...
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-deny");
    // ...but the plugin claim hook MUST NOT be invoked under deny — the
    // plugin can't be trusted to honor suppressDelivery on its outbound path.
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
    // Agent still processes the message (the whole point of the PR)...
    expect(replyResolver).toHaveBeenCalledTimes(1);
    // ...but no final reply is delivered.
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });
});
