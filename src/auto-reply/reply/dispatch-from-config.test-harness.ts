// Tests dispatch-from-config runtime selection, hooks, and provider handoff.
import { vi, type Mock } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { ChannelMessagingAdapter } from "../../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurnInput,
} from "../../plugin-sdk/acp-runtime.js";
import { clearPluginCommands } from "../../plugins/commands.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  agentEventMocks,
  createDispatcher,
  diagnosticMocks,
  hookMocks,
  internalHookMocks,
  messageAuditMocks,
  mocks,
  noAbortResult,
  parseGenericThreadSessionInfo,
  resetPluginTtsAndThreadMocks,
  runtimePluginMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  stageSandboxMediaMocks,
  threadInfoMocks,
  transcriptMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { buildTestCtx } from "./test-ctx.js";

export type ResolveInboundConversationParams = Parameters<
  NonNullable<ChannelMessagingAdapter["resolveInboundConversation"]>
>[0];

export const automaticGroupReplyConfig = {
  messages: {
    groupChat: {
      visibleReplies: "automatic",
    },
  },
} as const satisfies OpenClawConfig;

export const messageToolGroupReplyConfig = {
  messages: {
    groupChat: {
      visibleReplies: "message_tool",
    },
  },
} as const satisfies OpenClawConfig;

export const automaticDirectReplyConfig = {
  messages: {
    visibleReplies: "automatic",
  },
} as const satisfies OpenClawConfig;

export let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;

export let dispatchFromConfigTesting: typeof import("./dispatch-from-config.test-support.js").testing;

let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;

export let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acp-runtime.js").tryDispatchAcpReplyHook;

export let createReplyOperation: typeof import("./reply-run-registry.js").createReplyOperation;

export let replyRunRegistry: typeof import("./reply-run-registry.js").replyRunRegistry;

let replyRunTesting: typeof import("./reply-run-registry.test-support.js").testing;

export let admitReplyTurn: typeof import("./reply-turn-admission.js").admitReplyTurn;

export let runWithReplyOperationLifecycleAdmission: typeof import("./reply-turn-admission.js").runWithReplyOperationLifecycleAdmission;

type DispatchReplyArgs = Parameters<
  typeof import("./dispatch-from-config.js").dispatchReplyFromConfig
>[0];

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

export function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

type MockAcpRuntime = AcpRuntime & {
  ensureSession: Mock<(input: AcpRuntimeEnsureInput) => Promise<AcpRuntimeHandle>>;
  runTurn: Mock<(input: AcpRuntimeTurnInput) => AsyncIterable<AcpRuntimeEvent>>;
  cancel: Mock<(input: { handle: AcpRuntimeHandle; reason?: string }) => Promise<void>>;
  close: Mock<(input: { handle: AcpRuntimeHandle; reason: string }) => Promise<void>>;
};

export function createAcpRuntime(events: AcpRuntimeEvent[]): MockAcpRuntime {
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

export function firstMockCall(
  mockFn: ReturnType<typeof vi.fn>,
  label: string,
  index = 0,
): unknown[] {
  const call = mockFn.mock.calls[index] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return call;
}

export function firstMockArg(
  mockFn: ReturnType<typeof vi.fn>,
  label: string,
  index = 0,
  argIndex = 0,
): unknown {
  return firstMockCall(mockFn, label, index)[argIndex];
}

export function firstToolResultPayload(dispatcher: ReplyDispatcher): ReplyPayload | undefined {
  return firstMockArg(
    dispatcher.sendToolResult as ReturnType<typeof vi.fn>,
    "tool result",
  ) as ReplyPayload;
}

export function firstFinalReplyPayload(dispatcher: ReplyDispatcher): ReplyPayload | undefined {
  return firstMockArg(
    dispatcher.sendFinalReply as ReturnType<typeof vi.fn>,
    "final reply",
  ) as ReplyPayload;
}

export function firstRouteReplyCall(): Record<string, unknown> {
  const call = firstMockArg(mocks.routeReply, "route reply");
  if (!call || typeof call !== "object") {
    throw new Error("expected route reply params");
  }
  return call as Record<string, unknown>;
}

export function installThreadingTestPlugin(params: { defaultAccountId?: string; id: string }) {
  const plugin = createChannelTestPluginBase({ id: params.id });
  const defaultAccountId = params.defaultAccountId;
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: params.id,
        source: "test",
        plugin: {
          ...plugin,
          config: defaultAccountId
            ? { ...plugin.config, defaultAccountId: () => defaultAccountId }
            : plugin.config,
          threading: {
            resolveReplyToMode: () => "all",
          },
        },
      },
    ]),
  );
}

export function requireToolResultHandler(
  handler: GetReplyOptions["onToolResult"] | undefined,
): NonNullable<GetReplyOptions["onToolResult"]> {
  if (typeof handler !== "function") {
    throw new Error("expected onToolResult handler");
  }
  return handler;
}

export function requireBlockReplyHandler(
  handler: GetReplyOptions["onBlockReply"] | undefined,
): NonNullable<GetReplyOptions["onBlockReply"]> {
  if (typeof handler !== "function") {
    throw new Error("expected onBlockReply handler");
  }
  return handler;
}

export async function dispatchTwiceWithFreshDispatchers(
  params: Omit<DispatchReplyArgs, "dispatcher">,
) {
  const first = await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
  const second = await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
  return [first, second] as const;
}

export function messageAuditEvents(): Array<Record<string, unknown>> {
  return messageAuditMocks.emitTrustedMessageAuditEvent.mock.calls.map(([event]) =>
    event && typeof event === "object" ? (event as Record<string, unknown>) : {},
  );
}

export const globalBeforeAll0 = async () => {
  ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
  ({ testing: dispatchFromConfigTesting } = await import("./dispatch-from-config.test-support.js"));
  await import("./dispatch-acp.js");
  await import("./dispatch-acp-command-bypass.js");
  await import("./dispatch-acp-tts.runtime.js");
  await import("./dispatch-acp-session.runtime.js");
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acp-runtime.js"));
  ({ createReplyOperation, replyRunRegistry } = await import("./reply-run-registry.js"));
  ({ testing: replyRunTesting } = await import("./reply-run-registry.test-support.js"));
  ({ admitReplyTurn, runWithReplyOperationLifecycleAdmission } =
    await import("./reply-turn-admission.js"));
};

export const describe0BeforeEach0 = () => {
  clearAgentHarnesses();
  clearPluginCommands();
  resetPluginTtsAndThreadMocks();
  // This suite keeps richer channel registry and ACP hook wiring local.
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
      shouldSuppressLocalPayloadPrompt: ({
        payload,
        hint,
      }: {
        payload: ReplyPayload;
        hint?: { nativeRouteActive?: boolean };
      }) =>
        hint?.nativeRouteActive === true &&
        Boolean(
          payload.channelData &&
          typeof payload.channelData === "object" &&
          !Array.isArray(payload.channelData) &&
          payload.channelData.execApproval,
        ),
    },
  };
  const signalTestPlugin = {
    ...createChannelTestPluginBase({
      id: "signal",
      capabilities: {
        chatTypes: ["direct"],
        nativeCommands: true,
      },
    }),
    outbound: {
      deliveryMode: "direct",
      shouldSuppressLocalPayloadPrompt: ({
        cfg,
        payload,
        hint,
      }: {
        cfg: OpenClawConfig;
        payload: ReplyPayload;
        hint?: { kind?: string; approvalKind?: string; nativeRouteActive?: boolean };
      }) =>
        hint?.kind === "approval-pending" &&
        hint.approvalKind === "exec" &&
        hint.nativeRouteActive === true &&
        cfg.approvals?.exec?.enabled === true &&
        Boolean(
          payload.channelData &&
          typeof payload.channelData === "object" &&
          !Array.isArray(payload.channelData) &&
          payload.channelData.execApproval,
        ),
    },
  };
  const passiveThreadingTestPlugins = ["slack", "telegram", "feishu", "mattermost", "imessage"].map(
    (id) => {
      const plugin = createChannelTestPluginBase({ id });
      return {
        pluginId: id,
        source: "test" as const,
        plugin: {
          ...plugin,
          threading: {
            resolveReplyToMode: () => "all" as const,
          },
        },
      };
    },
  );
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: discordTestPlugin,
      },
      {
        pluginId: "signal",
        source: "test",
        plugin: signalTestPlugin,
      },
      ...passiveThreadingTestPlugins,
    ]),
  );
  acpManagerRuntimeMocks.getAcpSessionManager.mockReset();
  acpManagerRuntimeMocks.getAcpSessionManager.mockReturnValue(createMockAcpSessionManager());
  replyRunTesting.resetReplyRunRegistry();
  resetInboundDedupe();
  mocks.isRoutableChannel.mockReset();
  mocks.isRoutableChannel.mockImplementation((channel) =>
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
  );
  mocks.routeReply.mockReset();
  mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
  acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
  diagnosticMocks.logMessageQueued.mockClear();
  diagnosticMocks.logMessageProcessed.mockClear();
  diagnosticMocks.logSessionStateChange.mockClear();
  diagnosticMocks.markDiagnosticSessionProgress.mockClear();
  diagnosticMocks.requestStuckDiagnosticSessionRecovery.mockReset();
  diagnosticMocks.requestStuckDiagnosticSessionRecovery.mockResolvedValue({
    status: "skipped",
    action: "keep_lane",
    reason: "active_reply_work",
  });
  diagnosticMocks.logMessageDispatchStarted.mockClear();
  diagnosticMocks.logMessageDispatchCompleted.mockClear();
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
  acpMocks.readAcpSessionMeta.mockReset();
  acpMocks.readAcpSessionMeta.mockReturnValue(null);
  acpMocks.upsertAcpSessionMeta.mockReset();
  acpMocks.upsertAcpSessionMeta.mockResolvedValue(null);
  acpMocks.getAcpRuntimeBackend.mockReset();
  acpMocks.requireAcpRuntimeBackend.mockReset();
  agentEventMocks.emitAgentEvent.mockReset();
  agentEventMocks.emitAgentAuditEvent.mockReset();
  agentEventMocks.onAgentEvent.mockReset();
  agentEventMocks.onAgentEvent.mockReturnValue(() => {});
  messageAuditMocks.enabled = true;
  messageAuditMocks.emitTrustedMessageAuditEvent.mockReset();
  sessionBindingMocks.listBySession.mockReset();
  sessionBindingMocks.listBySession.mockReturnValue([]);
  sessionBindingMocks.resolveByConversation.mockReset();
  sessionBindingMocks.resolveByConversation.mockReturnValue(null);
  sessionBindingMocks.touch.mockReset();
  sessionStoreMocks.currentEntry = undefined;
  sessionStoreMocks.entriesBySessionKey.clear();
  sessionStoreMocks.loadSessionEntry.mockReset();
  sessionStoreMocks.loadSessionEntry.mockImplementation(() => sessionStoreMocks.currentEntry);
  sessionStoreMocks.loadSessionStoreEntry.mockReset();
  sessionStoreMocks.loadSessionStoreEntry.mockImplementation(() => sessionStoreMocks.currentEntry);
  sessionStoreMocks.loadSessionStore.mockReset();
  sessionStoreMocks.loadSessionStore.mockReturnValue({});
  sessionStoreMocks.readSessionEntry.mockReset();
  sessionStoreMocks.readSessionEntry.mockImplementation(() => sessionStoreMocks.currentEntry);
  sessionStoreMocks.resolveStorePath.mockReset();
  sessionStoreMocks.resolveStorePath.mockReturnValue("/tmp/mock-sessions.json");
  sessionStoreMocks.resolveSessionStoreEntry.mockReset();
  sessionStoreMocks.resolveSessionStoreEntry.mockImplementation(
    (params: { store: Record<string, Record<string, unknown>>; sessionKey: string }) => ({
      existing:
        params.store[params.sessionKey] ??
        sessionStoreMocks.entriesBySessionKey.get(params.sessionKey) ??
        sessionStoreMocks.currentEntry,
    }),
  );
  transcriptMocks.persistAcpDispatchTranscript.mockClear();
  transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();
  stageSandboxMediaMocks.stageSandboxMedia.mockReset();
  stageSandboxMediaMocks.stageSandboxMedia.mockResolvedValue({ staged: new Map() });
  runtimePluginMocks.ensureRuntimePluginsLoaded.mockClear();
};

export const createHookCtx = (overrides: Partial<MsgContext> = {}) =>
  buildTestCtx({
    Body: "hello",
    BodyForAgent: "hello",
    BodyForCommands: "hello",
    From: "user1",
    Surface: "telegram",
    ChatType: "private",
    ...overrides,
  });

export const describe1BeforeEach0 = () => {
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
};

export const describe2BeforeEach0 = () => {
  resetInboundDedupe();
  sessionStoreMocks.currentEntry = undefined;
  sessionBindingMocks.resolveByConversation.mockReset();
  sessionBindingMocks.resolveByConversation.mockReturnValue(null);
  sessionBindingMocks.touch.mockReset();
  hookMocks.registry.plugins = [];
  hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
  hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
    status: "no_handler",
  });
  hookMocks.runner.hasHooks.mockImplementation(
    (hookName?: string) => hookName === "reply_dispatch",
  );
  hookMocks.runner.runReplyDispatch.mockResolvedValue(undefined);
  hookMocks.runner.runBeforeDispatch.mockResolvedValue(undefined);
  threadInfoMocks.parseSessionThreadInfo.mockReset();
  threadInfoMocks.parseSessionThreadInfo.mockImplementation(parseGenericThreadSessionInfo);
};
