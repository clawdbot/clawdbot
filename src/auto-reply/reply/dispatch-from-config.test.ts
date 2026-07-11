// Tests dispatch-from-config runtime selection, hooks, and provider handoff.
import { AsyncResource } from "node:async_hooks";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { clearAgentHarnesses, registerAgentHarness } from "../../agents/harness/registry.js";
import type { ChannelMessagingAdapter } from "../../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearApprovalNativeRouteStateForTest,
  createApprovalNativeRouteReporter,
} from "../../infra/approval-native-route-coordinator.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { StuckSessionRecoveryOutcome } from "../../logging/diagnostic-session-recovery.js";
import type {
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurnInput,
} from "../../plugin-sdk/acp-runtime.js";
import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import type {
  PluginHookBeforeDispatchResult,
  PluginHookReplyDispatchResult,
  PluginTargetedInboundClaimOutcome,
} from "../../plugins/hooks.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  interruptSessionWorkAdmissions,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import { settleReplyDispatcher } from "../dispatch-dispatcher.js";
import { copyReplyPayloadMetadata, getReplyPayloadMetadata } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import { setReplyPayloadMetadata, type GetReplyOptions, type ReplyPayload } from "../types.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import { PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE } from "./provider-request-error-classifier.js";
import {
  createReplyDispatcher,
  type ReplyDispatchBeforeDeliver,
  type ReplyDispatcher,
} from "./reply-dispatcher.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { buildTestCtx } from "./test-ctx.js";

type AbortResult = {
  handled: boolean;
  aborted: boolean;
  rejectionReason?: "finalizing";
  stoppedSubagents?: number;
};
type ResolveInboundConversationParams = Parameters<
  NonNullable<ChannelMessagingAdapter["resolveInboundConversation"]>
>[0];

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
  tryFastAbortFromMessage: vi.fn<() => Promise<AbortResult>>(async () => ({
    handled: false,
    aborted: false,
  })),
}));
const globalMocks = vi.hoisted(() => ({
  logVerbose: vi.fn(),
}));
const diagnosticMocks = vi.hoisted(() => ({
  logMessageDispatchCompleted: vi.fn(),
  logMessageDispatchStarted: vi.fn(),
  logMessageQueued: vi.fn(),
  logMessageProcessed: vi.fn(),
  logSessionStateChange: vi.fn(),
  markDiagnosticSessionProgress: vi.fn(),
  requestStuckDiagnosticSessionRecovery: vi.fn<() => Promise<StuckSessionRecoveryOutcome>>(
    async () => ({
      status: "skipped" as const,
      action: "keep_lane" as const,
      reason: "active_reply_work" as const,
    }),
  ),
}));
const messageAuditMocks = vi.hoisted(() => ({
  enabled: true,
  emitTrustedMessageAuditEvent: vi.fn<(event: unknown) => void>(),
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
    runInboundClaimForPluginOutcome: vi.fn<
      (
        pluginId?: string,
        event?: unknown,
        context?: unknown,
      ) => Promise<PluginTargetedInboundClaimOutcome>
    >(async () => ({ status: "no_handler" as const })),
    runMessageReceived: vi.fn(async () => {}),
    runBeforeDispatch: vi.fn<
      (eventValue: unknown, _ctx: unknown) => Promise<PluginHookBeforeDispatchResult | undefined>
    >(async () => undefined),
    runReplyDispatch: vi.fn<
      (eventValue: unknown, _ctx: unknown) => Promise<PluginHookReplyDispatchResult | undefined>
    >(async () => undefined),
    runReplyPayloadSending: vi.fn(async () => undefined),
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
  readAcpSessionMeta: vi.fn<(params: { sessionKey: string; cfg?: OpenClawConfig }) => unknown>(
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
  entriesBySessionKey: new Map<string, Record<string, unknown>>(),
  loadSessionEntry: vi.fn((..._args: unknown[]) => sessionStoreMocks.currentEntry),
  loadSessionStoreEntry: vi.fn(() => sessionStoreMocks.currentEntry),
  loadSessionStore: vi.fn(() => ({})),
  readSessionEntry: vi.fn(() => sessionStoreMocks.currentEntry),
  resolveStorePath: vi.fn(() => "/tmp/mock-sessions.json"),
  resolveSessionStoreEntry: vi.fn(
    (params: {
      store: Record<string, Record<string, unknown>>;
      sessionKey: string;
    }): { existing: Record<string, unknown> | undefined } => ({
      existing:
        params.store[params.sessionKey] ??
        sessionStoreMocks.entriesBySessionKey.get(params.sessionKey) ??
        sessionStoreMocks.currentEntry,
    }),
  ),
  updateSessionStoreEntry: vi.fn(
    async (params: {
      update: (entry: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    }) => {
      if (!sessionStoreMocks.currentEntry) {
        return null;
      }
      const patch = await params.update(sessionStoreMocks.currentEntry);
      if (!patch) {
        return sessionStoreMocks.currentEntry;
      }
      sessionStoreMocks.currentEntry = { ...sessionStoreMocks.currentEntry, ...patch };
      return sessionStoreMocks.currentEntry;
    },
  ),
}));
const acpManagerRuntimeMocks = vi.hoisted(() => ({
  getAcpSessionManager: vi.fn(),
}));
const agentEventMocks = vi.hoisted(() => ({
  emitAgentAuditEvent: vi.fn(),
  emitAgentEvent: vi.fn(),
  onAgentEvent: vi.fn<(listener: unknown) => () => void>(() => () => {}),
}));
const ttsMocks = vi.hoisted(() => {
  const state = {
    synthesizeFinalAudio: false,
    synthesizeToolAudio: false,
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
          trustedLocalMedia: true,
        };
      }
      if (
        state.synthesizeToolAudio &&
        params.kind === "tool" &&
        typeof params.payload?.text === "string" &&
        params.payload.text.trim()
      ) {
        return {
          ...params.payload,
          mediaUrl: "https://example.com/tts-tool.opus",
          audioAsVoice: true,
          trustedLocalMedia: true,
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
const transcriptMocks = vi.hoisted(() => ({
  persistAcpDispatchTranscript: vi.fn(async (_params: unknown) => undefined),
  appendAssistantMessageToSessionTranscript: vi.fn(async (_params: unknown) => ({
    ok: true,
    sessionFile: "/tmp/session.jsonl",
    messageId: "message-1",
  })),
}));
const replyMediaPathMocks = vi.hoisted(() => ({
  createReplyMediaPathNormalizer: vi.fn(
    (_params?: unknown) => async (payload: ReplyPayload) => payload,
  ),
}));
const stageSandboxMediaMocks = vi.hoisted(() => ({
  stageSandboxMedia: vi.fn<(params: unknown) => Promise<{ staged: Map<string, string> }>>(
    async () => ({ staged: new Map() }),
  ),
}));
const runtimePluginMocks = vi.hoisted(() => ({
  ensureRuntimePluginsLoaded: vi.fn(),
}));
const conversationBindingMocks = vi.hoisted(() => {
  type BindingMsgContext = {
    OriginatingChannel?: string | null;
    Surface?: string | null;
    Provider?: string | null;
    AccountId?: string | null;
    MessageThreadId?: string | number | null;
    ThreadParentId?: string | null;
    SenderId?: string | null;
    SessionKey?: string | null;
    ParentSessionKey?: string | null;
    OriginatingTo?: string | null;
    To?: string | null;
    From?: string | null;
    NativeChannelId?: string | null;
  };
  type BindingConfig = {
    channels?: Record<string, { defaultAccount?: string | null } | undefined>;
  };

  const normalizeText = (value: string | number | null | undefined) =>
    typeof value === "number" ? `${value}` : (value ?? "").trim();
  const normalizeChannel = (value: string | null | undefined) => normalizeText(value).toLowerCase();
  const resolveChannel = (ctx: BindingMsgContext, commandChannel?: string | null) =>
    normalizeChannel(ctx.OriginatingChannel ?? commandChannel ?? ctx.Surface ?? ctx.Provider);
  const resolveAccountId = (ctx: BindingMsgContext, cfg: BindingConfig, channel: string) =>
    normalizeText(ctx.AccountId) ||
    normalizeText(cfg.channels?.[channel]?.defaultAccount) ||
    "default";
  const resolveTarget = (channel: string, value: string | null | undefined) => {
    const target = normalizeText(value);
    if (!target) {
      return undefined;
    }
    const channelPrefix = `${channel}:`;
    return target.toLowerCase().startsWith(channelPrefix)
      ? target.slice(channelPrefix.length)
      : target;
  };
  const resolveThreadId = (ctx: BindingMsgContext) =>
    normalizeText(ctx.MessageThreadId) || undefined;

  const resolveConversationBindingContextFromMessage = vi.fn(
    (params: { cfg: BindingConfig; ctx: BindingMsgContext }) => {
      const channel = resolveChannel(params.ctx);
      if (!channel) {
        return null;
      }
      const threadId = resolveThreadId(params.ctx);
      const baseConversationId =
        resolveTarget(channel, params.ctx.OriginatingTo) ?? resolveTarget(channel, params.ctx.To);
      const conversationId = threadId ?? baseConversationId;
      if (!conversationId) {
        return null;
      }
      const parentConversationId =
        threadId && baseConversationId && baseConversationId !== threadId
          ? baseConversationId
          : resolveTarget(channel, params.ctx.ThreadParentId);
      return {
        channel,
        accountId: resolveAccountId(params.ctx, params.cfg, channel),
        conversationId,
        ...(parentConversationId ? { parentConversationId } : {}),
        ...(threadId ? { threadId } : {}),
      };
    },
  );

  return {
    resolveConversationBindingAccountIdFromMessage: (params: {
      ctx: BindingMsgContext;
      cfg: BindingConfig;
      commandChannel?: string | null;
    }) =>
      resolveAccountId(params.ctx, params.cfg, resolveChannel(params.ctx, params.commandChannel)),
    resolveConversationBindingChannelFromMessage: (
      ctx: BindingMsgContext,
      commandChannel?: string | null,
    ) => resolveChannel(ctx, commandChannel),
    resolveConversationBindingContextFromAcpCommand: (params: {
      cfg: BindingConfig;
      ctx: BindingMsgContext;
      command?: { to?: string | null; senderId?: string | null };
      sessionKey?: string | null;
      parentSessionKey?: string | null;
    }) =>
      resolveConversationBindingContextFromMessage({
        cfg: params.cfg,
        ctx: {
          ...params.ctx,
          SenderId: params.command?.senderId ?? params.ctx.SenderId,
          SessionKey: params.sessionKey ?? params.ctx.SessionKey,
          ParentSessionKey: params.parentSessionKey ?? params.ctx.ParentSessionKey,
          To: params.command?.to ?? params.ctx.To,
        },
      }),
    resolveConversationBindingContextFromMessage,
    resolveConversationBindingThreadIdFromMessage: (ctx: BindingMsgContext) => resolveThreadId(ctx),
  };
});
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

vi.mock("../../globals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../globals.js")>();
  return {
    ...actual,
    logVerbose: globalMocks.logVerbose,
  };
});

vi.mock("../../logging/diagnostic.js", () => ({
  logMessageDispatchCompleted: diagnosticMocks.logMessageDispatchCompleted,
  logMessageDispatchStarted: diagnosticMocks.logMessageDispatchStarted,
  logMessageQueued: diagnosticMocks.logMessageQueued,
  logMessageProcessed: diagnosticMocks.logMessageProcessed,
  logSessionStateChange: diagnosticMocks.logSessionStateChange,
  markDiagnosticSessionProgress: diagnosticMocks.markDiagnosticSessionProgress,
  isStuckSessionRecoveryEnabled: (config?: { diagnostics?: { enabled?: boolean } }) =>
    config?.diagnostics?.enabled !== false,
  requestStuckDiagnosticSessionRecovery: diagnosticMocks.requestStuckDiagnosticSessionRecovery,
  resolveStuckSessionWarnMs: (config?: { diagnostics?: { stuckSessionWarnMs?: number } }) =>
    config?.diagnostics?.stuckSessionWarnMs ?? 120_000,
  resolveStuckSessionAbortMs: (
    config: { diagnostics?: { stuckSessionAbortMs?: number } } | undefined,
    stuckSessionWarnMs: number,
  ) =>
    Math.max(
      stuckSessionWarnMs,
      config?.diagnostics?.stuckSessionAbortMs ?? Math.max(300_000, stuckSessionWarnMs * 3),
    ),
}));
vi.mock("../../audit/message-audit-events.js", () => ({
  emitTrustedMessageAuditEvent: messageAuditMocks.emitTrustedMessageAuditEvent,
  hasTrustedMessageAuditListeners: () => messageAuditMocks.enabled,
}));
vi.mock("../../config/sessions/thread-info.js", () => ({
  parseSessionThreadInfo: (sessionKey: string | undefined) =>
    threadInfoMocks.parseSessionThreadInfo(sessionKey),
  parseSessionThreadInfoFast: (sessionKey: string | undefined) =>
    threadInfoMocks.parseSessionThreadInfo(sessionKey),
}));
vi.mock("./dispatch-from-config.runtime.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  loadSessionStoreEntry: sessionStoreMocks.loadSessionStoreEntry,
  loadSessionStore: sessionStoreMocks.loadSessionStore,
  readSessionEntry: sessionStoreMocks.readSessionEntry,
  resolveSessionStoreEntry: sessionStoreMocks.resolveSessionStoreEntry,
  resolveStorePath: sessionStoreMocks.resolveStorePath,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
  updateSessionStoreEntry: sessionStoreMocks.updateSessionStoreEntry,
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => sessionStoreMocks.loadSessionEntry(...args),
  };
});

vi.mock("../../plugins/hook-runner-global.js", () => ({
  initializeGlobalHookRunner: vi.fn(),
  getGlobalHookRunner: () => hookMocks.runner,
  getGlobalPluginRegistry: () => hookMocks.registry,
  resetGlobalHookRunner: vi.fn(),
}));
vi.mock("../../acp/runtime/session-meta.js", () => ({
  listAcpSessionEntries: acpMocks.listAcpSessionEntries,
  readAcpSessionEntry: acpMocks.readAcpSessionEntry,
  readAcpSessionMeta: acpMocks.readAcpSessionMeta,
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
vi.mock("../../bindings/records.js", () => ({
  resolveConversationBindingRecord: (conversation: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  }) => sessionBindingMocks.resolveByConversation(conversation),
  touchConversationBindingRecord: (...args: [bindingId: string, at?: number]) =>
    sessionBindingMocks.touch(...args),
}));
vi.mock("../../infra/agent-events.js", () => ({
  emitAgentAuditEvent: (params: unknown) => agentEventMocks.emitAgentAuditEvent(params),
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
      data?: Record<string, unknown>;
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
      data: metadata.data,
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
vi.mock("./stage-sandbox-media.runtime.js", () => ({
  stageSandboxMedia: (params: unknown) => stageSandboxMediaMocks.stageSandboxMedia(params),
}));
vi.mock("../../plugins/runtime-plugins.runtime.js", () => ({
  ensureRuntimePluginsLoaded: runtimePluginMocks.ensureRuntimePluginsLoaded,
}));
vi.mock("./conversation-binding-input.js", () => ({
  resolveConversationBindingAccountIdFromMessage:
    conversationBindingMocks.resolveConversationBindingAccountIdFromMessage,
  resolveConversationBindingChannelFromMessage:
    conversationBindingMocks.resolveConversationBindingChannelFromMessage,
  resolveConversationBindingContextFromAcpCommand:
    conversationBindingMocks.resolveConversationBindingContextFromAcpCommand,
  resolveConversationBindingContextFromMessage:
    conversationBindingMocks.resolveConversationBindingContextFromMessage,
  resolveConversationBindingThreadIdFromMessage:
    conversationBindingMocks.resolveConversationBindingThreadIdFromMessage,
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
vi.mock("./dispatch-acp-transcript.runtime.js", () => ({
  persistAcpDispatchTranscript: (params: unknown) =>
    transcriptMocks.persistAcpDispatchTranscript(params),
}));
vi.mock("../../config/sessions/transcript.js", () => ({
  appendAssistantMessageToSessionTranscript: (params: unknown) =>
    transcriptMocks.appendAssistantMessageToSessionTranscript(params),
}));
vi.mock("./dispatch-acp-session.runtime.js", () => ({
  readAcpSessionEntry: (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
    acpMocks.readAcpSessionEntry(params),
}));
vi.mock("../../tts/tts-config.js", () => ({
  normalizeTtsAutoMode: (value: unknown) => ttsMocks.normalizeTtsAutoMode(value),
  resolveConfiguredTtsMode: (cfg: OpenClawConfig) => ttsMocks.resolveTtsConfig(cfg).mode,
  shouldCleanTtsDirectiveText: () => true,
  shouldAttemptTtsPayload: () => true,
}));

const noAbortResult = { handled: false, aborted: false } as const;
const emptyConfig = {} as OpenClawConfig;
const automaticGroupReplyConfig = {
  messages: {
    groupChat: {
      visibleReplies: "automatic",
    },
  },
} as const satisfies OpenClawConfig;
const messageToolGroupReplyConfig = {
  messages: {
    groupChat: {
      visibleReplies: "message_tool",
    },
  },
} as const satisfies OpenClawConfig;
const automaticDirectReplyConfig = {
  messages: {
    visibleReplies: "automatic",
  },
} as const satisfies OpenClawConfig;
let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let dispatchFromConfigTesting: typeof import("./dispatch-from-config.js").testing;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acp-runtime.js").tryDispatchAcpReplyHook;
let createReplyOperation: typeof import("./reply-run-registry.js").createReplyOperation;
let replyRunRegistry: typeof import("./reply-run-registry.js").replyRunRegistry;
let replyRunTesting: typeof import("./reply-run-registry.js").__testing;
let admitReplyTurn: typeof import("./reply-turn-admission.js").admitReplyTurn;
let runWithReplyOperationLifecycleAdmission: typeof import("./reply-turn-admission.js").runWithReplyOperationLifecycleAdmission;
type DispatchReplyArgs = Parameters<
  typeof import("./dispatch-from-config.js").dispatchReplyFromConfig
>[0];

beforeAll(async () => {
  ({ dispatchReplyFromConfig, testing: dispatchFromConfigTesting } =
    await import("./dispatch-from-config.js"));
  await import("./dispatch-acp.js");
  await import("./dispatch-acp-command-bypass.js");
  await import("./dispatch-acp-tts.runtime.js");
  await import("./dispatch-acp-session.runtime.js");
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acp-runtime.js"));
  ({
    createReplyOperation,
    replyRunRegistry,
    __testing: replyRunTesting,
  } = await import("./reply-run-registry.js"));
  ({ admitReplyTurn, runWithReplyOperationLifecycleAdmission } =
    await import("./reply-turn-admission.js"));
});

function createDispatcher(): ReplyDispatcher {
  let beforeDeliver: ReplyDispatchBeforeDeliver | undefined;
  const beforeDeliverTasks: Promise<unknown>[] = [];
  const runBeforeDeliver = (kind: "tool" | "block" | "final", payload: ReplyPayload): void => {
    if (!beforeDeliver) {
      return;
    }
    beforeDeliverTasks.push(Promise.resolve(beforeDeliver(payload, { kind })));
  };
  return {
    sendToolResult: vi.fn((payload) => {
      runBeforeDeliver("tool", payload);
      return true;
    }),
    sendBlockReply: vi.fn((payload) => {
      runBeforeDeliver("block", payload);
      return true;
    }),
    sendFinalReply: vi.fn((payload) => {
      runBeforeDeliver("final", payload);
      return true;
    }),
    appendBeforeDeliver: vi.fn((hook) => {
      const previousBeforeDeliver = beforeDeliver;
      beforeDeliver = previousBeforeDeliver
        ? async (payload, info) => {
            const previousPayload = await previousBeforeDeliver(payload, info);
            return previousPayload
              ? hook(copyReplyPayloadMetadata(payload, previousPayload), info)
              : null;
          }
        : hook;
    }),
    waitForIdle: vi.fn(async () => {
      await Promise.all(beforeDeliverTasks);
    }),
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

function firstMockCall(mockFn: ReturnType<typeof vi.fn>, label: string, index = 0): unknown[] {
  const call = mockFn.mock.calls[index] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return call;
}

function firstMockArg(
  mockFn: ReturnType<typeof vi.fn>,
  label: string,
  index = 0,
  argIndex = 0,
): unknown {
  return firstMockCall(mockFn, label, index)[argIndex];
}

function firstToolResultPayload(dispatcher: ReplyDispatcher): ReplyPayload | undefined {
  return firstMockArg(
    dispatcher.sendToolResult as ReturnType<typeof vi.fn>,
    "tool result",
  ) as ReplyPayload;
}

function firstFinalReplyPayload(dispatcher: ReplyDispatcher): ReplyPayload | undefined {
  return firstMockArg(
    dispatcher.sendFinalReply as ReturnType<typeof vi.fn>,
    "final reply",
  ) as ReplyPayload;
}

function firstRouteReplyCall(): Record<string, unknown> {
  const call = firstMockArg(mocks.routeReply, "route reply");
  if (!call || typeof call !== "object") {
    throw new Error("expected route reply params");
  }
  return call as Record<string, unknown>;
}

function installThreadingTestPlugin(params: { defaultAccountId?: string; id: string }) {
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

function requireToolResultHandler(
  handler: GetReplyOptions["onToolResult"] | undefined,
): NonNullable<GetReplyOptions["onToolResult"]> {
  if (typeof handler !== "function") {
    throw new Error("expected onToolResult handler");
  }
  return handler;
}

function requireBlockReplyHandler(
  handler: GetReplyOptions["onBlockReply"] | undefined,
): NonNullable<GetReplyOptions["onBlockReply"]> {
  if (typeof handler !== "function") {
    throw new Error("expected onBlockReply handler");
  }
  return handler;
}

async function dispatchTwiceWithFreshDispatchers(params: Omit<DispatchReplyArgs, "dispatcher">) {
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

function messageAuditEvents(): Array<Record<string, unknown>> {
  return messageAuditMocks.emitTrustedMessageAuditEvent.mock.calls.map(([event]) =>
    event && typeof event === "object" ? (event as Record<string, unknown>) : {},
  );
}

describe("dispatchReplyFromConfig", () => {
  beforeEach(() => {
    clearAgentHarnesses();
    clearPluginCommands();
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
    const passiveThreadingTestPlugins = [
      "slack",
      "telegram",
      "feishu",
      "mattermost",
      "imessage",
    ].map((id) => {
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
    });
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
    clearApprovalNativeRouteStateForTest();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReset();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReturnValue(createMockAcpSessionManager());
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
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
    pluginConversationBindingMocks.shownFallbackNoticeBindingIds.clear();
    sessionBindingMocks.resolveByConversation.mockReset();
    sessionBindingMocks.resolveByConversation.mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.entriesBySessionKey.clear();
    sessionStoreMocks.loadSessionEntry.mockReset();
    sessionStoreMocks.loadSessionEntry.mockImplementation(() => sessionStoreMocks.currentEntry);
    sessionStoreMocks.loadSessionStoreEntry.mockReset();
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(
      () => sessionStoreMocks.currentEntry,
    );
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
    threadInfoMocks.parseSessionThreadInfo.mockReset();
    threadInfoMocks.parseSessionThreadInfo.mockImplementation(parseGenericThreadSessionInfo);
    ttsMocks.state.synthesizeFinalAudio = false;
    ttsMocks.state.synthesizeToolAudio = false;
    ttsMocks.maybeApplyTtsToPayload.mockClear();
    ttsMocks.normalizeTtsAutoMode.mockClear();
    ttsMocks.resolveTtsConfig.mockClear();
    ttsMocks.resolveTtsConfig.mockReturnValue({
      mode: "final",
    });
    transcriptMocks.persistAcpDispatchTranscript.mockClear();
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();
    replyMediaPathMocks.createReplyMediaPathNormalizer.mockReset();
    replyMediaPathMocks.createReplyMediaPathNormalizer.mockReturnValue(
      async (payload: ReplyPayload) => payload,
    );
    stageSandboxMediaMocks.stageSandboxMedia.mockReset();
    stageSandboxMediaMocks.stageSandboxMedia.mockResolvedValue({ staged: new Map() });
    runtimePluginMocks.ensureRuntimePluginsLoaded.mockClear();
  });

  it("loads runtime plugins before reading inbound hook state", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      SessionKey: "agent:main:main",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const pluginLoadOptions = firstMockArg(
      runtimePluginMocks.ensureRuntimePluginsLoaded,
      "runtime plugin load",
    ) as { config?: unknown; workspaceDir?: unknown };
    expect(pluginLoadOptions.config).toBe(cfg);
    expect(typeof pluginLoadOptions.workspaceDir).toBe("string");
    expect(runtimePluginMocks.ensureRuntimePluginsLoaded.mock.invocationCallOrder[0]).toBeLessThan(
      hookMocks.runner.hasHooks.mock.invocationCallOrder[0],
    );
  });

  it("returns session metadata changes marked during reply resolution", async () => {
    setNoAbort();
    const sessionKey = "agent:main:main";
    const dispatcher = createDispatcher();
    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        SessionKey: sessionKey,
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async (ctx) => {
        markCommandSessionMetadataChanged({ ctx, sessionKey });
        return { text: "goal updated" };
      },
    });

    expect(result.sessionMetadataChanges).toEqual([{ sessionKey, reason: "command-metadata" }]);
  });

  it("notifies session metadata changes before later dispatch errors", async () => {
    setNoAbort();
    const sessionKey = "agent:main:main";
    const dispatcher = createDispatcher();
    dispatcher.sendFinalReply = vi.fn(() => {
      throw new Error("delivery failed");
    });
    const onSessionMetadataChanges = vi.fn();

    await expect(
      dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "telegram",
          SessionKey: sessionKey,
        }),
        cfg: emptyConfig,
        dispatcher,
        onSessionMetadataChanges,
        replyResolver: async (ctx) => {
          markCommandSessionMetadataChanged({ ctx, sessionKey });
          return { text: "goal updated" };
        },
      }),
    ).rejects.toThrow("delivery failed");

    expect(onSessionMetadataChanges).toHaveBeenCalledWith([
      { sessionKey, reason: "command-metadata" },
    ]);
  });

  it("skips pre-dispatch admission when the caller already aborted", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691294:topic:3731";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const abortController = new AbortController();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    abortController.abort();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        SessionKey: sessionKey,
        ChatType: "group",
        IsForum: true,
        MessageSid: "27784",
        MessageThreadId: 3731,
        TransportThreadId: 3731,
        To: "telegram:-1003774691294:topic:3731",
        BodyForAgent: "superseded while waiting",
      }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyOptions: { abortSignal: abortController.signal },
      replyResolver,
    });

    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "blocked",
        outcome: "skipped",
        reasonCode: "reply_operation_aborted",
      }),
    );
    activeOperation.complete();
  });

  it("skips a Telegram topic heartbeat turn while a reply operation is active", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691294:topic:3731";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "user-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(
      async () => ({ text: "heartbeat should not run" }) satisfies ReplyPayload,
    );

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        SessionKey: sessionKey,
        ChatType: "group",
        IsForum: true,
        MessageSid: "heartbeat",
        MessageThreadId: 3731,
        TransportThreadId: 3731,
        To: "telegram:-1003774691294:topic:3731",
        BodyForAgent: "[OpenClaw heartbeat poll]",
      }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyOptions: { isHeartbeat: true },
      replyResolver,
    });

    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(replyRunRegistry.get(sessionKey)).toBe(activeOperation);
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "blocked",
        outcome: "skipped",
        reasonCode: "reply_operation_active",
      }),
    );
    activeOperation.complete();
  });

  it("does not route when Provider matches OriginatingChannel (even if Surface is missing)", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "slack", defaultAccountId: "work" });
    const cfg = automaticDirectReplyConfig;
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
    const replyDispatchCall = firstMockCall(hookMocks.runner.runReplyDispatch, "reply dispatch") as
      | [
          {
            originatingAccountId?: unknown;
            shouldRouteToOriginating?: unknown;
          },
          unknown,
        ]
      | undefined;
    expect(replyDispatchCall?.[0]?.shouldRouteToOriginating).toBe(false);
    expect(replyDispatchCall?.[0]?.originatingAccountId).toBe("work");
  });

  it("mirrors ownerless same-channel Slack finals after successful delivery", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "slack" });
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
      ChatType: "group",
      SessionKey: "agent:main:slack:channel:C123",
      MessageSid: "slack-message-1",
    });
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { runId: "slack-run-1" },
      replyResolver: async () => ({ text: "Slack command reply" }),
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      sessionKey: "agent:main:slack:channel:C123",
      agentId: "main",
      text: "Slack command reply",
      mediaUrls: undefined,
      idempotencyKey: "channel-final:slack-message-1:0",
      deliveryMirror: {
        kind: "channel-final",
        sourceMessageId: "slack-message-1",
      },
      storePath: "/tmp/mock-sessions.json",
      updateMode: "inline",
      config: emptyConfig,
      beforeMessageWrite: expect.any(Function),
    });
  });

  it("mirrors reset acknowledgements into the canonically prepared Slack session", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const dispatcher = createDispatcher();
    const sessionKey = "Agent:Main:Slack:Channel:C123";
    const preparedSessionKey = "agent:main:slack:channel:c123";
    sessionStoreMocks.currentEntry = {
      sessionId: "previous-session",
      updatedAt: Date.now(),
    };
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: "slack-reset-message",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        (
          opts as GetReplyOptions & {
            onSessionPrepared?: (binding: {
              sessionKey?: string;
              sessionId: string;
              storePath?: string;
            }) => void;
          }
        ).onSessionPrepared?.({
          sessionKey: preparedSessionKey,
          sessionId: "new-session",
          storePath: "/tmp/rotated-sessions.json",
        });
        return { text: "✅ New session started." };
      },
    });
    await settleReplyDispatcher({ dispatcher });

    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        expectedSessionId: "new-session",
        storePath: "/tmp/rotated-sessions.json",
        text: "✅ New session started.",
      }),
    );
  });

  it.each([
    ["embedded", { assistantMessageIndex: 7 }],
    ["runtime-owned", { assistantTranscriptOwned: true }],
  ])("does not mirror %s finals with a runtime transcript owner", async (_name, metadata) => {
    setNoAbort();
    const dispatcher = createDispatcher();
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        SessionKey: "agent:main:slack:channel:C123",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () =>
        setReplyPayloadMetadata({ text: "Persisted runtime reply" }, metadata),
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("records stale-foreground suppressed CLI-owned finals without duplicating answer text", async () => {
    setNoAbort();
    const dispatcher = createReplyDispatcher({
      deliver: vi.fn(async () => undefined),
      beforeDeliver: (payload, info) => {
        if (info.kind !== "final") {
          return payload;
        }
        setReplyPayloadMetadata(payload, {
          foregroundDeliverySuppression: { reason: "stale-foreground" },
        });
        return null;
      },
    });
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        SessionKey: "agent:main:slack:channel:C123",
        MessageSid: "slack-message-cli",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        (
          opts as GetReplyOptions & {
            onSessionPrepared?: (binding: {
              sessionKey?: string;
              sessionId: string;
              storePath?: string;
            }) => void;
          }
        ).onSessionPrepared?.({
          sessionKey: "agent:main:slack:channel:c123",
          sessionId: "prepared-session",
          storePath: "/tmp/prepared-sessions.json",
        });
        return setReplyPayloadMetadata(
          { text: "The CLI answer already lives in the transcript." },
          { assistantTranscriptOwned: true },
        );
      },
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      sessionKey: "agent:main:slack:channel:C123",
      agentId: "main",
      expectedSessionId: "prepared-session",
      text: "Channel final suppressed before delivery: stale foreground",
      mediaUrls: undefined,
      idempotencyKey: "channel-final-suppressed:slack-message-cli:0",
      deliveryMirror: {
        kind: "channel-final-suppressed",
        reason: "stale-foreground",
        sourceMessageId: "slack-message-cli",
      },
      storePath: "/tmp/prepared-sessions.json",
      updateMode: "inline",
      config: emptyConfig,
      beforeMessageWrite: expect.any(Function),
    });
  });

  it("disables routed delivery mirrors for CLI-owned finals", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    mocks.routeReply.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    installThreadingTestPlugin({ id: "telegram", defaultAccountId: "default" });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:999",
        AccountId: "default",
        SessionKey: "agent:main:telegram:group:999",
      }),
      cfg: automaticDirectReplyConfig,
      dispatcher,
      replyResolver: async () =>
        setReplyPayloadMetadata(
          { text: "Persisted routed CLI reply" },
          { assistantTranscriptOwned: true },
        ),
    });

    expect(result.queuedFinal).toBe(true);
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { text: "Persisted routed CLI reply" },
        mirror: false,
      }),
    );
  });

  it("uses accepted steered inbound audio for final TTS", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      SessionKey: "agent:main:whatsapp:direct:chat-1",
      BodyForAgent: "text turn",
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const operation = (
        opts as
          | {
              replyOperation?: ReturnType<typeof createReplyOperation>;
            }
          | undefined
      )?.replyOperation;
      expect(operation?.acceptedSteeredInboundAudio).toBe(false);
      operation?.markAcceptedSteeredInboundAudio();
      return { text: "reply to steered audio" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticDirectReplyConfig,
      dispatcher,
      replyResolver,
    });

    const finalTtsCall = ttsMocks.maybeApplyTtsToPayload.mock.calls.find(
      ([params]) => (params as { kind?: string }).kind === "final",
    )?.[0] as { inboundAudio?: boolean } | undefined;
    expect(finalTtsCall?.inboundAudio).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.mediaUrl).toBe("https://example.com/tts-synth.opus");
  });

  it("passes reply policy to routed block delivery", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const slackPlugin = createChannelTestPluginBase({ id: "slack" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            ...slackPlugin,
            config: {
              ...slackPlugin.config,
              listAccountIds: () => ["work"],
              defaultAccountId: () => "work",
            },
            threading: {
              resolveReplyToMode: ({ accountId }: { accountId?: string | null }) =>
                accountId === "work" ? "off" : "all",
            },
          },
        },
      ]),
    );
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
      ChatType: "channel",
      SessionKey: "agent:main:slack:channel:C123",
    });
    const cfg = {} as OpenClawConfig;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({
        text: "partial",
        replyToId: "999.000",
        replyToTag: true,
      });
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        channel: "slack",
        replyKind: "block",
        replyDelivery: {
          chatType: "channel",
          replyToMode: "off",
        },
      }),
    );
  });

  it("mirrors the delivered ownerless Slack text after dispatcher hook rewrites", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    dispatcher.appendBeforeDeliver?.((payload, info) =>
      info.kind === "final" ? { ...payload, text: "Redacted Slack reply" } : payload,
    );
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        SessionKey: "agent:main:slack:channel:C123",
        MessageSid: "slack-message-2",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "Secret Slack reply" }),
    });
    await settleReplyDispatcher({ dispatcher });

    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Redacted Slack reply",
        idempotencyKey: "channel-final:slack-message-2:0",
      }),
    );
  });

  it("does not mirror ownerless Slack finals removed by dispatcher hooks", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    dispatcher.appendBeforeDeliver?.((payload, info) =>
      info.kind === "final"
        ? { ...payload, text: "", mediaUrl: undefined, mediaUrls: undefined }
        : payload,
    );
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        SessionKey: "agent:main:slack:channel:C123",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "Hidden Slack reply" }),
    });
    await settleReplyDispatcher({ dispatcher });

    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("records routed Slack thread id on dispatch-owned reply operations", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "user:U1",
      ChatType: "direct",
      SessionKey: "agent:main:slack:direct:U1",
      MessageThreadId: "501.000",
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const operation = (
        opts as { replyOperation?: { routeThreadId?: string | number } } | undefined
      )?.replyOperation;
      expect(operation?.routeThreadId).toBe("501.000");
      return { text: "hi" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("lets a different Slack DM routed thread reach reply resolution while another thread is active", async () => {
    setNoAbort();
    const sessionKey = "agent:main:slack:direct:U1";
    const sessionId = "active-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    let inBandMutationRan = false;
    const rotatedSessionId = "rotated-session";
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
        true,
      );
      await runExclusiveSessionLifecycleMutation({
        scope: "/tmp/mock-sessions.json",
        identities: [sessionKey, sessionId],
        run: async () => {
          inBandMutationRan = true;
          sessionStoreMocks.currentEntry = {
            sessionId: rotatedSessionId,
            updatedAt: Date.now(),
          };
          (
            opts as
              | (GetReplyOptions & {
                  onSessionPrepared?: (binding: {
                    sessionKey: string;
                    sessionId: string;
                    storePath: string;
                  }) => void;
                })
              | undefined
          )?.onSessionPrepared?.({
            sessionKey,
            sessionId: rotatedSessionId,
            storePath: "/tmp/mock-sessions.json",
          });
        },
      });
      return { text: "thread B reply" } satisfies ReplyPayload;
    });

    try {
      const resultPromise = dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          OriginatingTo: "user:U1",
          ChatType: "direct",
          SessionKey: sessionKey,
          MessageThreadId: "501.000",
          BodyForAgent: "second top-level DM",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
      });

      const result = await Promise.race([
        resultPromise,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 1_000);
        }),
      ]);
      if (result === "timed-out") {
        activeOperation.complete();
        await resultPromise;
        throw new Error("Slack routed thread was blocked by the active reply operation");
      }

      expect(result).toMatchObject({
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 0 },
      });
      expect(replyResolver).toHaveBeenCalledTimes(1);
      expect(inBandMutationRan).toBe(true);
      expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    } finally {
      activeOperation.complete();
    }
  });

  it("releases a Slack bypass lease when the competing routed thread changes during admission", async () => {
    setNoAbort();
    const sessionKey = "agent:main:slack:direct:U2";
    const sessionId = "active-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const originalOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    originalOperation.setPhase("running");
    let replacementOperation: ReturnType<typeof createReplyOperation> | undefined;
    let releaseMutation: () => void = () => {};
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let signalMutationEntered: () => void = () => {};
    const mutationEntered = new Promise<void>((resolve) => {
      signalMutationEntered = resolve;
    });
    let lifecycleMutation: Promise<void> | undefined;
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "before_dispatch") as () => boolean,
    );
    hookMocks.runner.runBeforeDispatch.mockImplementationOnce(async () => {
      lifecycleMutation = runExclusiveSessionLifecycleMutation({
        scope: "/tmp/mock-sessions.json",
        identities: [sessionKey, sessionId],
        run: async () => {
          signalMutationEntered();
          await mutationGate;
        },
      });
      await mutationEntered;
      setTimeout(() => {
        originalOperation.complete();
        replacementOperation = createReplyOperation({
          sessionKey,
          sessionId,
          resetTriggered: false,
          routeThreadId: "501.000",
        });
        replacementOperation.setPhase("running");
        releaseMutation();
      }, 0);
      return undefined;
    });
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);

    try {
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          OriginatingTo: "user:U2",
          ChatType: "direct",
          SessionKey: sessionKey,
          MessageThreadId: "501.000",
          BodyForAgent: "same routed thread after replacement",
        }),
        cfg: emptyConfig,
        dispatcher: createDispatcher(),
        replyResolver,
      });
      await lifecycleMutation;

      expect(result).toMatchObject({ queuedFinal: false });
      expect(replyResolver).not.toHaveBeenCalled();
      expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
        false,
      );
    } finally {
      releaseMutation();
      originalOperation.complete();
      replacementOperation?.complete();
      await lifecycleMutation;
    }
  });

  it("holds a Slack bypass lease until an abort-insensitive resolver settles", async () => {
    setNoAbort();
    const sessionKey = "agent:main:slack:direct:U3";
    const sessionId = "active-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    activeOperation.setPhase("running");
    let releaseResolver: () => void = () => {};
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    let signalResolverEntered: () => void = () => {};
    const resolverEntered = new Promise<void>((resolve) => {
      signalResolverEntered = resolve;
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      signalResolverEntered();
      await resolverGate;
      await requireBlockReplyHandler(opts?.onBlockReply)({ text: "stale late block" });
      return { text: "late reply" } satisfies ReplyPayload;
    });
    const dispatcher = createDispatcher();
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U3",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        BodyForAgent: "abort-insensitive routed thread",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    await resolverEntered;
    activeOperation.complete();

    let mutationRan = false;
    const externalLifecycleRequest = new AsyncResource("slack-bypass-settle-race");
    const mutation = externalLifecycleRequest.runInAsyncScope(
      async () =>
        await runExclusiveSessionLifecycleMutation({
          scope: "/tmp/mock-sessions.json",
          identities: [sessionKey, sessionId],
          prepare: async () => {
            await interruptSessionWorkAdmissions({
              scope: "/tmp/mock-sessions.json",
              identities: [sessionKey, sessionId],
            });
          },
          run: async () => {
            mutationRan = true;
          },
        }),
    );
    const result = await dispatch;

    expect(result.queuedFinal).toBe(false);
    expect(mutationRan).toBe(false);
    expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
      true,
    );

    releaseResolver();
    await mutation;

    expect(mutationRan).toBe(true);
    expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
      false,
    );
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    externalLifecycleRequest.emitDestroy();
  });

  it("bounds Slack bypass lease cleanup when dispatcher idle never settles", async () => {
    setNoAbort();
    const sessionKey = "agent:main:slack:direct:U4";
    const sessionId = "active-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    dispatcher.waitForIdle = vi.fn(async () => await new Promise<void>(() => {}));
    dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy = () => ({
      maxTimeoutMs: 25,
      shouldExtend: () => false,
    });

    try {
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          OriginatingTo: "user:U4",
          ChatType: "direct",
          SessionKey: sessionKey,
          MessageThreadId: "501.000",
          BodyForAgent: "hung delivery barrier",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => undefined,
      });

      expect(result.queuedFinal).toBe(false);
      await vi.waitFor(
        () => {
          expect(
            isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId]),
          ).toBe(false);
        },
        { timeout: 500 },
      );
    } finally {
      activeOperation.complete();
    }
  });

  it("holds a Slack bypass lease until queued delivery settles before revalidation", async () => {
    setNoAbort();
    const sessionKey = "agent:main:slack:direct:U5";
    const sessionId = "active-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    activeOperation.setPhase("running");
    let releaseDelivery: () => void = () => {};
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createDispatcher();
    let holdDelivery = false;
    dispatcher.waitForIdle = vi.fn(async () => {
      if (holdDelivery) {
        await deliveryGate;
      }
    });
    const externalLifecycleRequest = new AsyncResource("slack-bypass-delivery-race");
    let allowLifecycleInterrupt: () => void = () => {};
    const lifecycleInterruptGate = new Promise<void>((resolve) => {
      allowLifecycleInterrupt = resolve;
    });
    let signalMutationPrepared: () => void = () => {};
    const mutationPrepared = new Promise<void>((resolve) => {
      signalMutationPrepared = resolve;
    });
    let signalResolverReturning: () => void = () => {};
    const resolverReturning = new Promise<void>((resolve) => {
      signalResolverReturning = resolve;
    });
    let mutationRan = false;
    let mutation: Promise<void> | undefined;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      holdDelivery = true;
      await requireBlockReplyHandler(opts?.onBlockReply)({ text: "queued block" });
      mutation = externalLifecycleRequest.runInAsyncScope(
        async () =>
          await runExclusiveSessionLifecycleMutation({
            scope: "/tmp/mock-sessions.json",
            identities: [sessionKey, sessionId],
            prepare: async () => {
              signalMutationPrepared();
              await lifecycleInterruptGate;
              await interruptSessionWorkAdmissions({
                scope: "/tmp/mock-sessions.json",
                identities: [sessionKey, sessionId],
              });
            },
            run: async () => {
              mutationRan = true;
            },
          }),
      );
      signalResolverReturning();
      return undefined;
    });

    try {
      const dispatch = dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          OriginatingTo: "user:U5",
          ChatType: "direct",
          SessionKey: sessionKey,
          MessageThreadId: "501.000",
          BodyForAgent: "hold queued delivery",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
      });
      await Promise.all([mutationPrepared, resolverReturning]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      allowLifecycleInterrupt();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(dispatcher.sendBlockReply).toHaveBeenCalledOnce();
      expect(mutationRan).toBe(false);
      expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
        true,
      );

      releaseDelivery();
      await dispatch;
      await mutation;

      expect(mutationRan).toBe(true);
    } finally {
      allowLifecycleInterrupt();
      releaseDelivery();
      activeOperation.complete();
      await mutation;
      externalLifecycleRequest.emitDestroy();
    }
  });

  it("runs ACP tail dispatch inside a borrowed Slack lifecycle admission", async () => {
    setNoAbort();
    const sessionKey = "agent:main:slack:direct:U6";
    const sessionId = "active-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    activeOperation.setPhase("running");
    let initiatingAdmissionExcluded = false;
    let mutationRan = false;
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "reply_dispatch") as () => boolean,
    );
    hookMocks.runner.runReplyDispatch.mockImplementation(async (event: unknown) => {
      if (!(event as { isTailDispatch?: boolean }).isTailDispatch) {
        return undefined;
      }
      await runExclusiveSessionLifecycleMutation({
        scope: "/tmp/mock-sessions.json",
        identities: [sessionKey, sessionId],
        prepare: async () => {
          initiatingAdmissionExcluded = await interruptSessionWorkAdmissions({
            scope: "/tmp/mock-sessions.json",
            identities: [sessionKey, sessionId],
            timeoutMs: 25,
          });
        },
        run: async () => {
          mutationRan = true;
        },
      });
      return {
        handled: true,
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    });

    try {
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          OriginatingTo: "user:U6",
          ChatType: "direct",
          SessionKey: sessionKey,
          MessageThreadId: "501.000",
          BodyForAgent: "run tail after reset",
          AcpDispatchTailAfterReset: true,
        }),
        cfg: emptyConfig,
        dispatcher: createDispatcher(),
        replyResolver: async () => undefined,
      });

      expect(result.queuedFinal).toBe(false);
      expect(initiatingAdmissionExcluded).toBe(true);
      expect(mutationRan).toBe(true);
    } finally {
      activeOperation.complete();
    }
  });

  it("keeps non-Slack routed direct turns behind the active reply operation", async () => {
    setNoAbort();
    installThreadingTestPlugin({ id: "telegram" });
    const sessionKey = "agent:main:telegram:direct:1";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);

    const resultPromise = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "user:1",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        BodyForAgent: "second telegram direct turn",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    let settled = false;
    void resultPromise.finally(() => {
      settled = true;
    });

    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      expect(replyResolver).not.toHaveBeenCalled();
    } finally {
      activeOperation.complete();
      await resultPromise;
    }
  });

  it("lets Gateway-owned turns reach queue resolution while a reply operation is active", async () => {
    setNoAbort();
    const sessionKey = "agent:main:main";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);

    try {
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "webchat",
          Surface: "webchat",
          SessionKey: sessionKey,
          BodyForAgent: "queue this turn",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: {
          queuedFollowupLifecycle: {
            onEnqueued: vi.fn(),
            onComplete: vi.fn(),
          },
        },
        replyResolver,
      });

      expect(result).toMatchObject({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      });
      expect(replyResolver).toHaveBeenCalledTimes(1);
      expect(replyRunRegistry.get(sessionKey)).toBe(activeOperation);
    } finally {
      activeOperation.complete();
    }
  });

  it("clears stale active reply operations for terminal sessions and retries admission", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691294";
    const sessionId = "failed-session";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    sessionStoreMocks.currentEntry = {
      sessionId,
      updatedAt: Date.now(),
      status: "failed",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "fresh reply" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: "visible-after-failure",
        To: "telegram:-1003774691294",
        BodyForAgent: "@openclaw recover",
      }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver,
    });

    expect(activeOperation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyRunRegistry.isActive(sessionKey)).toBe(false);
  });

  it("does not kill a sibling recovery turn when a second visible turn races the same terminal snapshot", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691295";
    const sessionId = "failed-session-race";
    // Leftover stuck run from the failed lifecycle; both racing turns read the
    // same terminal store snapshot below.
    const staleOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    staleOperation.setPhase("running");
    sessionStoreMocks.currentEntry = {
      sessionId,
      updatedAt: Date.now(),
      status: "failed",
    };

    let releaseFirstTurn: () => void = () => {};
    const firstResolverGate = new Promise<void>((release) => {
      releaseFirstTurn = release;
    });
    let signalFirstResolverEntered: () => void = () => {};
    const firstTurnEntered = new Promise<void>((resolve) => {
      signalFirstResolverEntered = resolve;
    });
    const firstReplyResolver = vi.fn(async () => {
      signalFirstResolverEntered();
      await firstResolverGate;
      return { text: "first recovery reply" } satisfies ReplyPayload;
    });
    const secondReplyResolver = vi.fn(
      async () => ({ text: "second reply" }) satisfies ReplyPayload,
    );
    const firstDispatcher = createDispatcher();
    const secondDispatcher = createDispatcher();

    const buildRaceCtx = (messageSid: string) =>
      buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: messageSid,
        To: "telegram:-1003774691295",
        BodyForAgent: "@openclaw recover",
      });

    const firstTurn = dispatchReplyFromConfig({
      ctx: buildRaceCtx("visible-race-first"),
      cfg: automaticGroupReplyConfig,
      dispatcher: firstDispatcher,
      replyResolver: firstReplyResolver,
    });

    // First turn cleared the leftover run and now owns the in-flight recovery
    // operation; capture it before the second turn races in.
    await firstTurnEntered;
    expect(staleOperation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    const recoveryOperation = replyRunRegistry.get(sessionKey);
    expect(recoveryOperation).toBeDefined();
    expect(recoveryOperation).not.toBe(staleOperation);

    const secondTurn = dispatchReplyFromConfig({
      ctx: buildRaceCtx("visible-race-second"),
      cfg: automaticGroupReplyConfig,
      dispatcher: secondDispatcher,
      replyResolver: secondReplyResolver,
    });

    // Give the second turn time to run its admission/recovery path. With the
    // bug it would force-fail the first turn's fresh recovery operation here.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(recoveryOperation?.result).toBeNull();
    expect(secondReplyResolver).not.toHaveBeenCalled();

    releaseFirstTurn();
    const firstResult = await firstTurn;
    const secondResult = await secondTurn;

    // The first recovery completed normally; the second turn was never allowed
    // to kill it and got its own admission once the first finished.
    expect(recoveryOperation?.result).toMatchObject({ kind: "completed" });
    expect(firstReplyResolver).toHaveBeenCalledTimes(1);
    expect(secondReplyResolver).toHaveBeenCalledTimes(1);
    expect(firstResult).toMatchObject({ queuedFinal: true });
    expect(secondResult).toMatchObject({ queuedFinal: true });
    expect(firstDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(secondDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(replyRunRegistry.isActive(sessionKey)).toBe(false);
  });

  it("marks a clean no-stale terminal recovery so a racing visible turn cannot force-clear it", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691297";
    const sessionId = "failed-session-no-stale-race";
    // No leftover op is pre-registered: the first visible turn reaches the clean
    // admission path (nothing to force-clear). Both racing turns read the same
    // terminal store snapshot below.
    sessionStoreMocks.currentEntry = {
      sessionId,
      updatedAt: Date.now(),
      status: "failed",
    };

    let releaseFirstTurn: () => void = () => {};
    const firstResolverGate = new Promise<void>((release) => {
      releaseFirstTurn = release;
    });
    let signalFirstResolverEntered: () => void = () => {};
    const firstTurnEntered = new Promise<void>((resolve) => {
      signalFirstResolverEntered = resolve;
    });
    const firstReplyResolver = vi.fn(async () => {
      signalFirstResolverEntered();
      await firstResolverGate;
      return { text: "first recovery reply" } satisfies ReplyPayload;
    });
    const secondReplyResolver = vi.fn(
      async () => ({ text: "second reply" }) satisfies ReplyPayload,
    );
    const firstDispatcher = createDispatcher();
    const secondDispatcher = createDispatcher();

    const buildRaceCtx = (messageSid: string) =>
      buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: messageSid,
        To: "telegram:-1003774691295",
        BodyForAgent: "@openclaw recover",
      });

    const firstTurn = dispatchReplyFromConfig({
      ctx: buildRaceCtx("visible-no-stale-first"),
      cfg: automaticGroupReplyConfig,
      dispatcher: firstDispatcher,
      replyResolver: firstReplyResolver,
    });

    // First turn admitted cleanly and now owns the in-flight recovery operation;
    // capture it before the second turn races in.
    await firstTurnEntered;
    const recoveryOperation = replyRunRegistry.get(sessionKey);
    expect(recoveryOperation).toBeDefined();
    // The marker must be set on the clean no-stale admission path too; without it
    // the racing second visible turn would force-clear this op (#86827).
    expect(recoveryOperation?.terminalRecovery).toBe(true);

    const secondTurn = dispatchReplyFromConfig({
      ctx: buildRaceCtx("visible-no-stale-second"),
      cfg: automaticGroupReplyConfig,
      dispatcher: secondDispatcher,
      replyResolver: secondReplyResolver,
    });

    // Give the second turn time to run its admission/recovery path. With the
    // bug it would force-fail the first turn's fresh recovery operation here.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(recoveryOperation?.result).toBeNull();
    expect(secondReplyResolver).not.toHaveBeenCalled();

    releaseFirstTurn();
    const firstResult = await firstTurn;
    const secondResult = await secondTurn;

    // The first recovery completed normally; the second turn was never allowed
    // to kill it and got its own admission once the first finished.
    expect(recoveryOperation?.result).toMatchObject({ kind: "completed" });
    expect(firstReplyResolver).toHaveBeenCalledTimes(1);
    expect(secondReplyResolver).toHaveBeenCalledTimes(1);
    expect(firstResult).toMatchObject({ queuedFinal: true });
    expect(secondResult).toMatchObject({ queuedFinal: true });
    expect(firstDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(secondDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(replyRunRegistry.isActive(sessionKey)).toBe(false);
  });

  it("does not force-clear an active recovery operation for a heartbeat turn on a terminal session", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691296";
    const sessionId = "failed-session-heartbeat";
    sessionStoreMocks.currentEntry = {
      sessionId,
      updatedAt: Date.now(),
      status: "failed",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(
      async () => ({ text: "heartbeat should not run" }) satisfies ReplyPayload,
    );

    // A concurrent visible turn already cleared the failed leftover and admitted
    // a fresh recovery operation. Register it inside the fast-abort seam, which
    // runs after the early heartbeat short-circuit but before admission, so the
    // heartbeat reaches the terminal force-clear branch with this op active. The
    // op is intentionally NOT marked `terminalRecovery`, so only the visible-turn
    // guard can stop the heartbeat from force-failing it.
    let recoveryOperation: ReturnType<typeof createReplyOperation> | undefined;

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: "heartbeat-after-failure",
        To: "telegram:-1003774691296",
        BodyForAgent: "[OpenClaw heartbeat poll]",
      }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyOptions: { isHeartbeat: true },
      fastAbortResolver: async () => {
        recoveryOperation = createReplyOperation({
          sessionKey,
          sessionId,
          resetTriggered: false,
        });
        recoveryOperation.setPhase("running");
        return { handled: false, aborted: false };
      },
      formatAbortReplyTextResolver: () => "aborted",
      replyResolver,
    });

    // The heartbeat left the active visible recovery operation untouched and
    // skipped itself instead of force-clearing the in-flight visible turn.
    expect(recoveryOperation).toBeDefined();
    expect(recoveryOperation?.result).toBeNull();
    expect(replyRunRegistry.get(sessionKey)).toBe(recoveryOperation);
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    recoveryOperation?.complete();
  });

  it("rejects a stale turn without clearing the operation for the rotated session", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691297";
    // Terminal store snapshot still reports the failed lifecycle's session id.
    sessionStoreMocks.currentEntry = {
      sessionId: "failed-session-rotated",
      updatedAt: Date.now(),
      status: "failed",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(
      async () => ({ text: "visible recovery reply" }) satisfies ReplyPayload,
    );

    // A concurrent reset/rotation admitted a fresh op under the same session key
    // but with a NEW session id, after this turn already captured the stale
    // terminal snapshot. Register it inside the fast-abort seam, which runs after
    // the early short-circuit but before admission, so the visible turn reaches
    // the terminal force-clear branch with this op active. The op is NOT marked
    // `terminalRecovery`, so only the session-id guard can stop the force-clear.
    let freshOperation: ReturnType<typeof createReplyOperation> | undefined;
    let signalFreshRegistered: () => void = () => {};
    const freshRegistered = new Promise<void>((resolve) => {
      signalFreshRegistered = resolve;
    });

    const turn = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: "visible-after-rotation",
        To: "telegram:-1003774691297",
        BodyForAgent: "@openclaw recover",
      }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      fastAbortResolver: async () => {
        freshOperation = createReplyOperation({
          sessionKey,
          sessionId: "fresh-rotated-session",
          resetTriggered: false,
        });
        freshOperation.setPhase("running");
        signalFreshRegistered();
        return { handled: false, aborted: false };
      },
      formatAbortReplyTextResolver: () => "aborted",
      replyResolver,
    });

    // Let the visible turn run its admission/force-clear path. With the bug it
    // would force-fail the rotated op here, mistaking a valid in-flight reply for
    // the stale terminal leftover and recreating the message loss (#86827).
    await freshRegistered;
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });

    // The session-id guard keeps the rotated op untouched while the stale turn
    // is invalidated instead of later crossing the reset boundary.
    expect(freshOperation).toBeDefined();
    expect(freshOperation?.result).toBeNull();
    expect(replyRunRegistry.get(sessionKey)).toBe(freshOperation);
    expect(replyResolver).not.toHaveBeenCalled();

    freshOperation?.complete();
    await expect(turn).rejects.toThrow(/changed while starting work/i);
    expect(replyResolver).not.toHaveBeenCalled();
    expect(replyRunRegistry.isActive(sessionKey)).toBe(false);
  });

  it("routes when OriginatingChannel differs from Provider", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
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
    const routeCall = firstRouteReplyCall() as
      | {
          accountId?: unknown;
          channel?: unknown;
          groupId?: unknown;
          isGroup?: unknown;
          threadId?: unknown;
          to?: unknown;
        }
      | undefined;
    expect(routeCall?.channel).toBe("telegram");
    expect(routeCall?.to).toBe("telegram:999");
    expect(routeCall?.accountId).toBe("acc-1");
    expect(routeCall?.threadId).toBe(123);
    expect(routeCall?.isGroup).toBe(true);
    expect(routeCall?.groupId).toBe("telegram:999");
  });

  it("routes exec-event replies using persisted session delivery context when current turn has no originating route", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    sessionStoreMocks.currentEntry = {
      deliveryContext: {
        channel: "telegram",
        to: "telegram:999",
        accountId: "acc-1",
      },
      lastChannel: "telegram",
      lastTo: "telegram:999",
      lastAccountId: "acc-1",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "exec-event",
      Surface: "exec-event",
      SessionKey: "agent:main:main",
      AccountId: undefined,
      OriginatingChannel: undefined,
      OriginatingTo: undefined,
    });

    const replyResolver = async () =>
      ({ text: "hi", mediaUrl: "https://example.test/reply.png" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall() as
      | { accountId?: unknown; channel?: unknown; to?: unknown }
      | undefined;
    expect(routeCall?.channel).toBe("telegram");
    expect(routeCall?.to).toBe("telegram:999");
    expect(routeCall?.accountId).toBe("acc-1");
    const normalizerOptions = replyMediaPathMocks.createReplyMediaPathNormalizer.mock
      .calls[0]?.[0] as { accountId?: unknown; messageProvider?: unknown } | undefined;
    expect(normalizerOptions?.messageProvider).toBe("telegram");
    expect(normalizerOptions?.accountId).toBe("acc-1");
    const replyDispatchCall = firstMockCall(hookMocks.runner.runReplyDispatch, "reply dispatch") as
      | [
          {
            originatingAccountId?: unknown;
            originatingChannel?: unknown;
            originatingThreadId?: unknown;
            originatingTo?: unknown;
            shouldRouteToOriginating?: unknown;
          },
          unknown,
        ]
      | undefined;
    expect(replyDispatchCall?.[0]?.shouldRouteToOriginating).toBe(true);
    expect(replyDispatchCall?.[0]?.originatingChannel).toBe("telegram");
    expect(replyDispatchCall?.[0]?.originatingTo).toBe("telegram:999");
    expect(typeof replyDispatchCall?.[1]).toBe("object");
  });

  it("routes sessions_send internal webchat handoffs through persisted external delivery context", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "feishu" });
    sessionStoreMocks.currentEntry = {
      route: {
        channel: "feishu",
        accountId: "work",
        target: { to: "user:ou_123", chatType: "channel" },
        thread: { id: "thread:om_123", source: "explicit" },
      },
      chatType: "channel",
      deliveryContext: {
        channel: "feishu",
        to: "user:ou_123",
        accountId: "work",
        threadId: "thread:om_123",
      },
      lastChannel: "feishu",
      lastTo: "user:ou_123",
      lastAccountId: "work",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      SessionKey: "agent:main:feishu:direct:ou_123",
      AccountId: undefined,
      OriginatingChannel: "webchat",
      OriginatingTo: "session:dashboard",
      ChatType: "direct",
      InputProvenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceChannel: "webchat",
      },
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall() as
      | {
          accountId?: unknown;
          channel?: unknown;
          replyDelivery?: unknown;
          threadId?: unknown;
          to?: unknown;
        }
      | undefined;
    expect(routeCall?.channel).toBe("feishu");
    expect(routeCall?.to).toBe("user:ou_123");
    expect(routeCall?.accountId).toBe("work");
    expect(routeCall?.threadId).toBe("thread:om_123");
    expect(routeCall?.replyDelivery).toEqual({
      chatType: "channel",
      replyToMode: "all",
    });
    const replyDispatchCall = firstMockCall(hookMocks.runner.runReplyDispatch, "reply dispatch") as
      | [
          {
            originatingAccountId?: unknown;
            originatingChannel?: unknown;
            originatingChatType?: unknown;
            originatingThreadId?: unknown;
            originatingTo?: unknown;
            shouldRouteToOriginating?: unknown;
          },
          unknown,
        ]
      | undefined;
    expect(replyDispatchCall?.[0]?.shouldRouteToOriginating).toBe(true);
    expect(replyDispatchCall?.[0]?.originatingChannel).toBe("feishu");
    expect(replyDispatchCall?.[0]?.originatingTo).toBe("user:ou_123");
    expect(replyDispatchCall?.[0]?.originatingAccountId).toBe("work");
    expect(replyDispatchCall?.[0]?.originatingThreadId).toBe("thread:om_123");
    expect(replyDispatchCall?.[0]?.originatingChatType).toBe("channel");
  });

  it("routes exec-event replies using last route fields when delivery context is missing", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    sessionStoreMocks.currentEntry = {
      lastChannel: "discord",
      lastTo: "channel:123",
      lastAccountId: "default",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "exec-event",
      Surface: "exec-event",
      SessionKey: "agent:main:main",
      AccountId: undefined,
      OriginatingChannel: undefined,
      OriginatingTo: undefined,
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall() as
      | { accountId?: unknown; channel?: unknown; to?: unknown }
      | undefined;
    expect(routeCall?.channel).toBe("discord");
    expect(routeCall?.to).toBe("channel:123");
    expect(routeCall?.accountId).toBe("default");
  });

  it("honors sendPolicy deny for recovered exec-event delivery channel", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    sessionStoreMocks.currentEntry = {
      deliveryContext: {
        channel: "telegram",
        to: "telegram:999",
        accountId: "acc-1",
      },
      lastChannel: "telegram",
      lastTo: "telegram:999",
      lastAccountId: "acc-1",
    };
    const cfg = {
      session: {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { channel: "telegram" } }],
        },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "exec-event",
      Surface: "exec-event",
      SessionKey: "agent:main:main",
      AccountId: undefined,
      OriginatingChannel: undefined,
      OriginatingTo: undefined,
    });

    const replyResolver = vi.fn(async () => ({ text: "hi" }) satisfies ReplyPayload);
    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
    const replyDispatchCall = firstMockCall(hookMocks.runner.runReplyDispatch, "reply dispatch") as
      | [
          {
            originatingChannel?: unknown;
            originatingTo?: unknown;
            sendPolicy?: unknown;
            shouldRouteToOriginating?: unknown;
            suppressUserDelivery?: unknown;
          },
          unknown,
        ]
      | undefined;
    expect(replyDispatchCall?.[0]?.sendPolicy).toBe("deny");
    expect(replyDispatchCall?.[0]?.suppressUserDelivery).toBe(true);
    expect(replyDispatchCall?.[0]?.shouldRouteToOriginating).toBe(true);
    expect(replyDispatchCall?.[0]?.originatingChannel).toBe("telegram");
    expect(replyDispatchCall?.[0]?.originatingTo).toBe("telegram:999");
    expect(typeof replyDispatchCall?.[1]).toBe("object");
  });

  it("falls back to thread-scoped session key when current ctx has no MessageThreadId", async () => {
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

    expect(resolveRoutedDeliveryThreadId({ ctx, sessionKey: ctx.SessionKey })).toBe("post-root");
  });

  it("uses Slack DM TransportThreadId when ReplyToId is the current message", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "slack" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      SessionKey: "agent:main:slack:direct:u123",
      AccountId: "default",
      ChatType: "direct",
      MessageSid: "101.000",
      ReplyToId: "101.000",
      TransportThreadId: "101.000",
      MessageThreadId: undefined,
      OriginatingChannel: "slack",
      OriginatingTo: "user:U123",
      ExplicitDeliverRoute: true,
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const routeCall = firstRouteReplyCall() as { threadId?: string | number } | undefined;
    expect(routeCall?.threadId).toBe("101.000");
  });

  it("does not resurrect a cleared route thread from origin metadata", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "mattermost" });
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

    const routeCall = firstRouteReplyCall() as
      | { channel?: string; to?: string; threadId?: string | number }
      | undefined;
    expect(routeCall?.channel).toBe("mattermost");
    expect(routeCall?.to).toBe("channel:CHAN1");
    expect(routeCall?.threadId).toBeUndefined();
  });

  it("forces suppressTyping when routing to a different originating channel", async () => {
    setNoAbort();
    installThreadingTestPlugin({ id: "telegram" });
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
    installThreadingTestPlugin({ id: "telegram" });
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
    const routeCall = firstRouteReplyCall() as { channel?: unknown; to?: unknown } | undefined;
    expect(routeCall?.channel).toBe("telegram");
    expect(routeCall?.to).toBe("telegram:999");
  });

  it("routes Feishu replies when provider is webchat and origin metadata points to Feishu", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "feishu" });
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
    const routeCall = firstRouteReplyCall() as { channel?: unknown; to?: unknown } | undefined;
    expect(routeCall?.channel).toBe("feishu");
    expect(routeCall?.to).toBe("ou_feishu_direct_123");
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
    installThreadingTestPlugin({ id: "imessage" });
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
    installThreadingTestPlugin({ id: "imessage" });
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
    const routeCall = firstRouteReplyCall() as
      | { channel?: unknown; policyConversationType?: unknown; to?: unknown }
      | undefined;
    expect(routeCall?.channel).toBe("imessage");
    expect(routeCall?.policyConversationType).toBe("direct");
    expect(routeCall?.to).toBe("imessage:+15550001111");
  });

  it("routes media-only tool results when summaries are suppressed", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    const cfg = automaticGroupReplyConfig;
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
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({
        text: "NO_REPLY",
        mediaUrls: ["https://example.com/tts-routed.opus"],
      });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const normalizerOptions = replyMediaPathMocks.createReplyMediaPathNormalizer.mock
      .calls[0]?.[0] as { cfg?: unknown; messageProvider?: unknown } | undefined;
    expect(normalizerOptions?.cfg).toBe(cfg);
    expect(normalizerOptions?.messageProvider).toBe("telegram");
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledTimes(1);
    const routed = firstRouteReplyCall() as { payload?: ReplyPayload } | undefined;
    expect(routed?.payload?.mediaUrls).toEqual(["https://example.com/tts-routed.opus"]);
    expect(routed?.payload?.text).toBeUndefined();
  });

  it("provides onToolResult in DM sessions", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = {
      ...emptyConfig,
      agents: { defaults: { verboseDefault: "on" } },
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
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "tool output" });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith({ text: "tool output" });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("does not synthesize hidden text-only tool summaries into TTS media", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeToolAudio = true;
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
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "tool output" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tool" }),
    );
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("suppresses late text-only tool results after final delivery starts", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      ChatType: "channel",
      IsForum: true,
      SessionKey: "agent:main:discord:channel:C1",
    });
    let lateToolResult: NonNullable<GetReplyOptions["onToolResult"]> | undefined;

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      lateToolResult = requireToolResultHandler(opts?.onToolResult);
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    await lateToolResult?.({ text: "failed command output", isError: true });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it("suppresses group tool summaries but still forwards tool media", async () => {
    setNoAbort();
    const cfg = automaticGroupReplyConfig;
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
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 exec: ls" });
      await onToolResult({
        text: "NO_REPLY",
        mediaUrls: ["https://example.com/tts-group.opus"],
      });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: false },
    });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    const sent = firstToolResultPayload(dispatcher);
    expect(sent?.mediaUrls).toEqual(["https://example.com/tts-group.opus"]);
    expect(sent?.text).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("keeps group tool summaries suppressed when the channel omits the quiet-default flag", async () => {
    setNoAbort();
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 exec: ls" });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("allows group tool summaries when session verbose is enabled without a channel quiet-default flag", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 exec: ls" });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)?.text).toBe("🔧 exec: ls");
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("allows group tool summaries when the agent verbose default is enabled", async () => {
    setNoAbort();
    const cfg = {
      ...automaticGroupReplyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } as const satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "matrix",
      Surface: "matrix",
      ChatType: "group",
      From: "matrix:group:!room:example.org",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 exec: pwd" });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)?.text).toBe("🔧 exec: pwd");
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("keeps group tool summaries suppressed when session verbose is disabled", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = {
      ...automaticGroupReplyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } as const satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:456@g.us",
      SessionKey: "agent:main:whatsapp:group:456@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 exec: date" });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("allows group tool summaries when verbose is enabled during the run", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:789@g.us",
      SessionKey: "agent:main:whatsapp:group:789@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      sessionStoreMocks.currentEntry = {
        verboseLevel: "on",
      };
      await onToolResult({ text: "🔧 exec: whoami" });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)?.text).toBe("🔧 exec: whoami");
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("keeps tool-error fallbacks available when verbose is disabled during the run", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:789@g.us",
      SessionKey: "agent:main:whatsapp:group:789@g.us",
    });
    let receivedOptions: GetReplyOptions | undefined;

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      receivedOptions = opts;
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      sessionStoreMocks.currentEntry = {
        verboseLevel: "off",
      };
      await onToolResult({ text: "🔧 exec: failed", isError: true });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(receivedOptions?.suppressToolErrorWarnings).toBeUndefined();
    expect(receivedOptions?.shouldSuppressToolErrorWarnings?.()).toBe(false);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("forwards channel-owned group progress callbacks while verbose is off", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:group:-100123",
      SessionKey: "agent:main:telegram:group:-100123",
    });
    const onToolStart = vi.fn();
    const onItemEvent = vi.fn();
    const onPlanUpdate = vi.fn();
    const onApprovalEvent = vi.fn();
    const onCommandOutput = vi.fn();
    const onPatchSummary = vi.fn();
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();
    const onToolResult = vi.fn();

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      await opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running exec" });
      await opts?.onPlanUpdate?.({ phase: "update", steps: ["Run command"] });
      await opts?.onApprovalEvent?.({ phase: "requested", command: "pnpm test" });
      await opts?.onCommandOutput?.({ phase: "end", name: "exec", status: "ok", exitCode: 0 });
      await opts?.onPatchSummary?.({ phase: "end", summary: "1 modified" });
      await opts?.onCompactionStart?.();
      await opts?.onCompactionEnd?.();
      await opts?.onToolResult?.({ text: "exec: ok" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        suppressDefaultToolProgressMessages: true,
        onToolStart,
        onItemEvent,
        onPlanUpdate,
        onApprovalEvent,
        onCommandOutput,
        onPatchSummary,
        onCompactionStart,
        onCompactionEnd,
        onToolResult,
      },
    });

    expect(onToolStart).toHaveBeenCalledWith({ name: "exec", phase: "start" });
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "1",
      kind: "tool",
      progressText: "running exec",
    });
    expect(onPlanUpdate).toHaveBeenCalledWith({ phase: "update", steps: ["Run command"] });
    expect(onApprovalEvent).toHaveBeenCalledWith({
      phase: "requested",
      command: "pnpm test",
    });
    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      name: "exec",
      status: "ok",
      exitCode: 0,
    });
    expect(onPatchSummary).toHaveBeenCalledWith({ phase: "end", summary: "1 modified" });
    expect(onCompactionStart).toHaveBeenCalledTimes(1);
    expect(onCompactionEnd).toHaveBeenCalledTimes(1);
    expect(onToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("forwards only opted-in tool lifecycle feedback while verbose is off", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
    });
    const onToolStart = vi.fn();
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      await opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running exec" });
      await opts?.onCommandOutput?.({ phase: "end", name: "exec", status: "ok", exitCode: 0 });
      await opts?.onCompactionStart?.();
      await opts?.onCompactionEnd?.();
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        allowToolLifecycleWhenProgressHidden: true,
        onToolStart,
        onItemEvent,
        onCommandOutput,
        onCompactionStart,
        onCompactionEnd,
      },
    });

    expect(onToolStart).toHaveBeenCalledWith({ name: "exec", phase: "start" });
    expect(onItemEvent).not.toHaveBeenCalled();
    expect(onCommandOutput).not.toHaveBeenCalled();
    expect(onCompactionStart).toHaveBeenCalledTimes(1);
    expect(onCompactionEnd).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("does not forward compaction lifecycle feedback while verbose is off by default", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
    });
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onCompactionStart?.();
      await opts?.onCompactionEnd?.();
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        onCompactionStart,
        onCompactionEnd,
      },
    });

    expect(onCompactionStart).not.toHaveBeenCalled();
    expect(onCompactionEnd).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers verbose inter-tool commentary as standalone progress messages before the tool summary", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    let commentaryEnabled: boolean | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      commentaryEnabled = opts?.commentaryProgressEnabled;
      await opts?.onItemEvent?.({
        itemId: "c1",
        kind: "preamble",
        progressText: "checking the config first",
      });
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(commentaryEnabled).toBe(true);
    const sendToolResult = dispatcher.sendToolResult as ReturnType<typeof vi.fn>;
    expect(sendToolResult).toHaveBeenCalledTimes(2);
    expect((sendToolResult.mock.calls[0]?.[0] as ReplyPayload | undefined)?.text).toBe(
      "💬 checking the config first",
    );
    expect((sendToolResult.mock.calls[1]?.[0] as ReplyPayload | undefined)?.text).toBe(
      "🔧 exec: ls",
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("starts a preamble item before a later partial callback", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const callbackOrder: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      void opts?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "checking first",
      });
      void opts?.onPartialReply?.({ text: "answer after preamble" });
      return { text: "done" };
    };

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "whatsapp" }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        preserveProgressCallbackStartOrder: true,
        suppressDefaultToolProgressMessages: true,
        onItemEvent: () => {
          callbackOrder.push("item");
        },
        onPartialReply: () => {
          callbackOrder.push("partial");
        },
      },
    });

    expect(callbackOrder).toEqual(["item", "partial"]);
  });

  it("flushes trailing verbose commentary before the final reply", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onItemEvent?.({
        itemId: "c1",
        kind: "preamble",
        progressText: "wrapping up",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const sendToolResult = dispatcher.sendToolResult as ReturnType<typeof vi.fn>;
    const sendFinalReply = dispatcher.sendFinalReply as ReturnType<typeof vi.fn>;
    expect(sendToolResult).toHaveBeenCalledTimes(1);
    expect((sendToolResult.mock.calls[0]?.[0] as ReplyPayload | undefined)?.text).toBe(
      "💬 wrapping up",
    );
    expect(sendFinalReply).toHaveBeenCalledTimes(1);
    expect(sendToolResult.mock.invocationCallOrder[0]).toBeLessThan(
      sendFinalReply.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
    );
  });

  it("collapses snapshot updates for one commentary item into a single message", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onItemEvent?.({ itemId: "c1", kind: "preamble", progressText: "drafting" });
      await opts?.onItemEvent?.({
        itemId: "c1",
        kind: "preamble",
        progressText: "drafting a refined plan",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const sendToolResult = dispatcher.sendToolResult as ReturnType<typeof vi.fn>;
    expect(sendToolResult).toHaveBeenCalledTimes(1);
    expect((sendToolResult.mock.calls[0]?.[0] as ReplyPayload | undefined)?.text).toBe(
      "💬 drafting a refined plan",
    );
  });

  it("flushes the previous commentary block when a new item starts", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onItemEvent?.({ itemId: "c1", kind: "preamble", progressText: "first block" });
      await opts?.onItemEvent?.({ itemId: "c2", kind: "preamble", progressText: "second block" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const sendToolResult = dispatcher.sendToolResult as ReturnType<typeof vi.fn>;
    expect(sendToolResult).toHaveBeenCalledTimes(2);
    expect((sendToolResult.mock.calls[0]?.[0] as ReplyPayload | undefined)?.text).toBe(
      "💬 first block",
    );
    expect((sendToolResult.mock.calls[1]?.[0] as ReplyPayload | undefined)?.text).toBe(
      "💬 second block",
    );
  });

  it("drops retracted commentary that has not been delivered", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onItemEvent?.({ itemId: "c1", kind: "preamble", progressText: "scratch that" });
      await opts?.onItemEvent?.({ itemId: "c1", kind: "preamble", progressText: "" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("keeps commentary out of standalone progress while verbose is off", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:group:-100123",
      SessionKey: "agent:main:telegram:group:-100123",
    });
    const onItemEvent = vi.fn();

    let commentaryEnabled: boolean | undefined = false;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      commentaryEnabled = opts?.commentaryProgressEnabled;
      await opts?.onItemEvent?.({
        itemId: "c1",
        kind: "preamble",
        progressText: "quiet thought",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true, onItemEvent },
    });

    expect(commentaryEnabled).toBeUndefined();
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "c1",
      kind: "preamble",
      progressText: "quiet thought",
    });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it("reports verbose progress visibility to the channel", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    let isActive: (() => boolean) | undefined;
    let activeDuringRun: boolean | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      activeDuringRun = isActive?.();
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        onVerboseProgressVisibility: (getter) => {
          isActive = getter;
        },
      },
    });

    expect(activeDuringRun).toBe(true);

    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    let isActiveOff: (() => boolean) | undefined;
    let activeDuringOffRun: boolean | undefined;
    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver: async () => {
        activeDuringOffRun = isActiveOff?.();
        return { text: "done" } satisfies ReplyPayload;
      },
      replyOptions: {
        onVerboseProgressVisibility: (getter) => {
          isActiveOff = getter;
        },
      },
    });

    expect(activeDuringOffRun).toBe(false);
  });

  it("forwards channel-owned group progress callbacks while source delivery is suppressed", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:group:-100123",
      SessionKey: "agent:main:telegram:group:-100123",
    });
    const onToolStart = vi.fn();
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    const onToolResult = vi.fn();

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      await opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running exec" });
      await opts?.onCommandOutput?.({ phase: "end", name: "exec", status: "ok", exitCode: 0 });
      await opts?.onToolResult?.({ text: "exec: ok" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolStart,
        onItemEvent,
        onCommandOutput,
        onToolResult,
      },
    });

    expect(onToolStart).toHaveBeenCalledWith({ name: "exec", phase: "start" });
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "1",
      kind: "tool",
      progressText: "running exec",
    });
    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      name: "exec",
      status: "ok",
      exitCode: 0,
    });
    expect(onToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "automatic",
      cfg: automaticGroupReplyConfig,
      expectedUserRequestMode: "automatic",
      expectedStableMode: "automatic",
    },
    {
      name: "message-tool",
      cfg: messageToolGroupReplyConfig,
      expectedUserRequestMode: "message_tool_only",
      expectedStableMode: "message_tool_only",
    },
  ] as const)(
    "threads $name session-stable source delivery mode to reply runs",
    async ({ cfg, expectedUserRequestMode, expectedStableMode }) => {
      setNoAbort();
      const dispatcher = createDispatcher();
      type CapturedReplyOptions = GetReplyOptions & {
        sessionPromptSourceReplyDeliveryMode?: GetReplyOptions["sourceReplyDeliveryMode"];
      };
      const seen: Array<{
        effective?: GetReplyOptions["sourceReplyDeliveryMode"];
        stable?: GetReplyOptions["sourceReplyDeliveryMode"];
      }> = [];
      const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: CapturedReplyOptions) => {
        seen.push({
          effective: opts?.sourceReplyDeliveryMode,
          stable: opts?.sessionPromptSourceReplyDeliveryMode,
        });
        return { text: "done" } satisfies ReplyPayload;
      });
      const baseCtx = {
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "group",
        From: "telegram:group:-100123",
        SessionKey: "agent:main:telegram:group:-100123",
      };

      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          ...baseCtx,
          Body: "@bot check this",
          CommandBody: "@bot check this",
        }),
        cfg,
        dispatcher,
        replyResolver,
      });
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          ...baseCtx,
          Body: "@bot check this",
          CommandBody: "@bot check this",
          InboundEventKind: "room_event",
        }),
        cfg,
        dispatcher,
        replyResolver,
      });

      expect(seen).toEqual([
        { effective: expectedUserRequestMode, stable: expectedStableMode },
        { effective: "message_tool_only", stable: expectedStableMode },
      ]);
    },
  );

  it("forwards channel-owned room-event progress callbacks while source delivery is suppressed", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      InboundEventKind: "room_event",
      From: "telegram:group:-100123",
      SessionKey: "agent:main:telegram:group:-100123",
    });
    const onToolStart = vi.fn();
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    let commentaryEnabled: boolean | undefined;

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      commentaryEnabled = opts?.commentaryProgressEnabled;
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      await opts?.onItemEvent?.({
        itemId: "c1",
        kind: "preamble",
        progressText: "checking the channel state",
      });
      await opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running exec" });
      await opts?.onCommandOutput?.({ phase: "end", name: "exec", status: "ok", exitCode: 0 });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolStart,
        onItemEvent,
        onCommandOutput,
      },
    });

    expect(commentaryEnabled).toBe(true);
    expect(onToolStart).toHaveBeenCalledWith({ name: "exec", phase: "start" });
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "c1",
      kind: "preamble",
      progressText: "checking the channel state",
    });
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "1",
      kind: "tool",
      progressText: "running exec",
    });
    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      name: "exec",
      status: "ok",
      exitCode: 0,
    });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("exposes live tool-summary state to reply_dispatch hooks", () => {
    let shouldSendToolSummaries = false;
    const event = dispatchFromConfigTesting.createReplyDispatchEvent({
      shouldSendToolSummaries: () => shouldSendToolSummaries,
    } as never) as { shouldSendToolSummaries: boolean };

    expect(event.shouldSendToolSummaries).toBe(false);
    shouldSendToolSummaries = true;
    expect(event.shouldSendToolSummaries).toBe(true);
  });

  it("forwards direct native progress callbacks while verbose is off", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      From: "telegram:123",
      SessionKey: "agent:main:telegram:dm:123",
    });
    const onToolStart = vi.fn();
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    let commentaryEnabled: boolean | undefined;

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      commentaryEnabled = opts?.commentaryProgressEnabled;
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      await opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running exec" });
      await opts?.onCommandOutput?.({ phase: "end", name: "exec", status: "ok", exitCode: 0 });
      await opts?.onToolResult?.({ text: "🔧 exec: ok" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolStart,
        onItemEvent,
        onCommandOutput,
      },
    });

    expect(onToolStart).toHaveBeenCalledWith({ name: "exec", phase: "start" });
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "1",
      kind: "tool",
      progressText: "running exec",
    });
    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      name: "exec",
      status: "ok",
      exitCode: 0,
    });
    expect(commentaryEnabled).toBe(true);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("suppresses direct native progress callbacks when send policy denies delivery", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sendPolicy: "deny",
      verboseLevel: "off",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      From: "telegram:123",
      SessionKey: "agent:main:telegram:dm:123",
    });
    const onToolStart = vi.fn();
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    let commentaryEnabled: boolean | undefined;

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      commentaryEnabled = opts?.commentaryProgressEnabled;
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      await opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running exec" });
      await opts?.onCommandOutput?.({ phase: "end", name: "exec", status: "ok", exitCode: 0 });
      await opts?.onToolResult?.({ text: "exec: ok" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolStart,
        onItemEvent,
        onCommandOutput,
      },
    });

    expect(onToolStart).not.toHaveBeenCalled();
    expect(onItemEvent).not.toHaveBeenCalled();
    expect(onCommandOutput).not.toHaveBeenCalled();
    expect(commentaryEnabled).toBeUndefined();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
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
    const cfg = automaticGroupReplyConfig;
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

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    const normalizerOptions = replyMediaPathMocks.createReplyMediaPathNormalizer.mock
      .calls[0]?.[0] as { cfg?: unknown; messageProvider?: unknown } | undefined;
    expect(normalizerOptions?.cfg).toBe(cfg);
    expect(normalizerOptions?.messageProvider).toBe("webchat");
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("delivers tool summaries in forum topic sessions when verbose is enabled", async () => {
    setNoAbort();
    const cfg = {
      ...automaticGroupReplyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
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
    expect(firstToolResultPayload(dispatcher)?.text).toBe("🔧 exec: ls");
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers deterministic exec approval tool payloads in groups", async () => {
    setNoAbort();
    const cfg = automaticGroupReplyConfig;
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
    const toolPayload = firstToolResultPayload(dispatcher);
    expect(toolPayload?.text).toBe(
      "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
    );
    expect(toolPayload?.channelData).toStrictEqual({
      execApproval: {
        approvalId: "117ba06d-1111-2222-3333-444444444444",
        approvalSlug: "117ba06d",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "NO_REPLY" });
  });

  it("sends tool results via dispatcher in DM sessions", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      agents: { defaults: { verboseDefault: "on" } },
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
      // Simulate tool result emission
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(firstToolResultPayload(dispatcher)?.text).toBe("🔧 exec: ls");
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers native tool summaries and tool media", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      agents: { defaults: { verboseDefault: "on" } },
    } satisfies OpenClawConfig;
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
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 tools/sessions_send" });
      await onToolResult({
        mediaUrl: "https://example.com/tts-native.opus",
      });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(2);
    expect(firstToolResultPayload(dispatcher)?.text).toBe("🔧 tools/sessions_send");
    const sent = firstMockArg(
      dispatcher.sendToolResult as ReturnType<typeof vi.fn>,
      "tool result",
      1,
    ) as ReplyPayload;
    expect(sent.mediaUrl).toBe("https://example.com/tts-native.opus");
    expect(sent.text).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("bypasses final TTS for status notices", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });
    const notice = {
      text: "Model Fallback: openai/gpt-5.5",
      isFallbackNotice: true,
    } satisfies ReplyPayload;

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver: async () => notice,
    });

    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(notice);
  });

  it("renders the first plan update as a status notice without generic working statuses", async () => {
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

    expect(firstToolResultPayload(dispatcher)).toMatchObject({
      text: "1. Inspect code\n2. Patch code\n3. Run tests",
      isStatusNotice: true,
    });
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("sends only one plan status notice per reply run", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      agents: { defaults: { verboseDefault: "on" } },
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
        steps: ["Inspect code"],
      });
      await opts?.onPlanUpdate?.({
        phase: "update",
        steps: ["Inspect code", "Patch code"],
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)).toMatchObject({
      text: "1. Inspect code",
      isStatusNotice: true,
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("suppresses generic patch working statuses when verbose is enabled", async () => {
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

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("delivers Slack non-DM verbose progress when verbose is enabled", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      messages: automaticGroupReplyConfig.messages,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      ChatType: "channel",
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
      await opts?.onPatchSummary?.({
        phase: "end",
        title: "apply patch",
        summary: "1 added, 2 modified",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("suppresses plan notices when session verbose is off", async () => {
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

  it("refreshes verbose progress with session entry snapshots", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    sessionStoreMocks.loadSessionStoreEntry.mockReturnValue({ verboseLevel: "on" });
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
      sessionStoreMocks.loadSessionStore.mockClear();
      sessionStoreMocks.resolveSessionStoreEntry.mockClear();
      sessionStoreMocks.loadSessionStoreEntry.mockClear();
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

    expect(sessionStoreMocks.loadSessionStoreEntry).toHaveBeenCalledWith({
      agentId: "main",
      storePath: "/tmp/mock-sessions.json",
      sessionKey: "agent:main:main",
      readConsistency: "latest",
      clone: false,
    });
    expect(sessionStoreMocks.loadSessionStore).not.toHaveBeenCalled();
    expect(sessionStoreMocks.resolveSessionStoreEntry).not.toHaveBeenCalled();
    expect(firstToolResultPayload(dispatcher)).toMatchObject({
      text: "1. Inspect code\n2. Patch code\n3. Run tests",
      isStatusNotice: true,
    });
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

  it("keeps failed tools compact when preview tool-progress suppression is enabled", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const onCommandOutput = vi.fn();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      ChatType: "channel",
      IsForum: true,
      SessionKey: "agent:main:discord:channel:C1",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onCommandOutput?.({
        phase: "end",
        title: "Exec",
        name: "exec",
        status: "failed",
        exitCode: 1,
      });
      await opts?.onToolResult?.({ text: "raw failed command output", isError: true });
      return { text: "done" } satisfies ReplyPayload;
    };

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onCommandOutput,
      },
    });

    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      title: "Exec",
      name: "exec",
      status: "failed",
      exitCode: 1,
    });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("suppresses tool error payloads when messages.suppressToolErrors is enabled", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const onToolResult = vi.fn();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:main",
    });

    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({ text: "⚠️ 🛠️ sqlite3 failed", isError: true });
      return { text: "handled" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: {
        agents: { defaults: { verboseDefault: "on" } },
        messages: {
          suppressToolErrors: true,
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onToolResult },
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "handled" });
  });

  it("keeps message-tool-only failed tool output compact in normal verbose mode", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const onCommandOutput = vi.fn();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:direct:U1",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onCommandOutput?.({
        phase: "end",
        title: "Exec",
        name: "exec",
        status: "failed",
        exitCode: 2,
      });
      await opts?.onToolResult?.({
        text: "🛠️ Bash: `ls /tmp/missing`\n```txt\nNo such file or directory\n```",
        isError: true,
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onCommandOutput,
      },
    });

    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      title: "Exec",
      name: "exec",
      status: "failed",
      exitCode: 2,
    });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("keeps terminal tool-error fallbacks available when message-tool-only error text is hidden", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:direct:U1",
    });
    let receivedOptions: GetReplyOptions | undefined;

    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      receivedOptions = opts;
      expect(opts?.shouldSuppressToolErrorWarnings?.()).toBeUndefined();
      await opts?.onToolResult?.({
        text: "🛠️ Bash: `ls /tmp/missing`\n```txt\nNo such file or directory\n```",
        isError: true,
      });
      expect(opts?.shouldSuppressToolErrorWarnings?.()).toBeUndefined();
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(receivedOptions?.suppressToolErrorWarnings).toBeUndefined();
    expect(receivedOptions?.shouldSuppressToolErrorWarnings?.()).toBeUndefined();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("allows message-tool-only failed tool output in verbose full mode", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "full",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:direct:U1",
    });
    const failedOutput = {
      text: "🛠️ Bash: `ls /tmp/missing`\n```txt\nNo such file or directory\n```",
      isError: true,
    } satisfies ReplyPayload;

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.(failedOutput);
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(failedOutput);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("suppresses terminal tool-error fallbacks when regular verbose progress is visible", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const onCommandOutput = vi.fn();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:direct:U1",
    });
    let receivedOptions: GetReplyOptions | undefined;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      receivedOptions = opts;
      expect(opts?.shouldSuppressToolErrorWarnings?.()).toBeUndefined();
      await opts?.onCommandOutput?.({
        phase: "end",
        name: "exec",
        status: "failed",
        exitCode: 1,
      });
      return { text: "done" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onCommandOutput },
    });

    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      name: "exec",
      status: "failed",
      exitCode: 1,
    });
    expect(receivedOptions?.suppressToolErrorWarnings).toBeUndefined();
    expect(receivedOptions?.shouldSuppressToolErrorWarnings?.()).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("keeps tool-error fallbacks eligible when a channel declines failed progress", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const onCommandOutput = vi.fn(async () => false as const);
    const onItemEvent = vi.fn(async () => false as const);
    const ctx = buildTestCtx({
      Provider: "discord",
      ChatType: "direct",
      SessionKey: "agent:main:discord:direct:U1",
    });
    let receivedOptions: GetReplyOptions | undefined;
    let commandOutputResult: false | void = undefined;
    let itemEventResult: false | void = undefined;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      receivedOptions = opts;
      commandOutputResult = await opts?.onCommandOutput?.({
        phase: "end",
        name: "exec",
        status: "failed",
        exitCode: 1,
      });
      itemEventResult = await opts?.onItemEvent?.({
        kind: "tool",
        phase: "end",
        name: "exec",
        status: "failed",
      });
      return { text: "done" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onCommandOutput, onItemEvent },
    });

    expect(onCommandOutput).toHaveBeenCalledTimes(1);
    expect(onItemEvent).toHaveBeenCalledTimes(1);
    expect(commandOutputResult).toBe(false);
    expect(itemEventResult).toBe(false);
    expect(receivedOptions?.shouldSuppressToolErrorWarnings?.()).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("suppresses terminal tool-error fallbacks in group sessions when verbose progress is visible", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const onItemEvent = vi.fn();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });
    let receivedOptions: GetReplyOptions | undefined;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      receivedOptions = opts;
      expect(opts?.shouldSuppressToolErrorWarnings?.()).toBeUndefined();
      await opts?.onItemEvent?.({
        itemId: "item-1",
        kind: "tool",
        name: "exec",
        status: "failed",
      });
      return { text: "done" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onItemEvent },
    });

    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "item-1",
      kind: "tool",
      name: "exec",
      status: "failed",
    });
    expect(receivedOptions?.suppressToolErrorWarnings).toBeUndefined();
    expect(receivedOptions?.shouldSuppressToolErrorWarnings?.()).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("keeps terminal tool-error fallbacks available when verbose turns on after a quiet failure", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "off",
    };
    const dispatcher = createDispatcher();
    const onCommandOutput = vi.fn();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:direct:U1",
    });
    let receivedOptions: GetReplyOptions | undefined;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      receivedOptions = opts;
      await opts?.onCommandOutput?.({
        phase: "end",
        name: "exec",
        status: "failed",
        exitCode: 1,
      });
      sessionStoreMocks.currentEntry = {
        ...sessionStoreMocks.currentEntry,
        verboseLevel: "on",
      };
      expect(opts?.shouldSuppressToolErrorWarnings?.()).toBeUndefined();
      return { text: "done" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        onCommandOutput,
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(onCommandOutput).not.toHaveBeenCalled();
    expect(receivedOptions?.suppressToolErrorWarnings).toBeUndefined();
    expect(receivedOptions?.shouldSuppressToolErrorWarnings?.()).toBeUndefined();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("does not pre-latch terminal tool-error suppression when diagnostics are disabled", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:direct:U1",
    });
    let receivedOptions: GetReplyOptions | undefined;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      receivedOptions = opts;
      expect(opts?.shouldSuppressToolErrorWarnings?.()).toBeUndefined();
      sessionStoreMocks.currentEntry = {
        ...sessionStoreMocks.currentEntry,
        verboseLevel: "off",
      };
      expect(opts?.shouldSuppressToolErrorWarnings?.()).toBe(false);
      return { text: "done" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: { diagnostics: { enabled: false } } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(receivedOptions?.suppressToolErrorWarnings).toBeUndefined();
    expect(receivedOptions?.shouldSuppressToolErrorWarnings?.()).toBe(false);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("keeps terminal tool-error fallbacks available in verbose full mode", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "full",
    };
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:direct:U1",
    });
    let receivedOptions: GetReplyOptions | undefined;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      receivedOptions = opts;
      return { text: "done" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(receivedOptions?.suppressToolErrorWarnings).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("delivers text-only tool summaries when verbose overrides preview suppression", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = emptyConfig;
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

    expect(dispatcher.sendToolResult).toHaveBeenCalledWith({ text: "🔧 exec: ls" });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("delivers plan status when verbose overrides preview suppression", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = emptyConfig;
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
        explanation: "Inspect code.",
        steps: ["Patch code"],
      });
      await opts?.onApprovalEvent?.({
        phase: "requested",
        status: "pending",
        command: "pnpm test",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).toHaveBeenNthCalledWith(1, {
      text: "1. Patch code",
      isStatusNotice: true,
    });
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("delivers verbose tool summaries despite message-tool-only source suppression", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:main",
    });

    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({ text: "🛠️ `pwd (agent)`" });
      return { text: "done" } satisfies ReplyPayload;
    };

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith({ text: "🛠️ `pwd (agent)`" });
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("keeps verbose tool summaries suppressed for room events", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      ChatType: "channel",
      InboundEventKind: "room_event",
      SessionKey: "agent:main:discord:channel:C1",
    });

    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({ text: "🛠️ `pwd (agent)`" });
      return { text: "done" } satisfies ReplyPayload;
    };

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers verbose tool summaries for Discord channel message-tool-only turns", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      ChatType: "channel",
      IsForum: true,
      SessionKey: "agent:main:discord:channel:C1",
    });

    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({ text: "🛠️ `pwd (agent)`" });
      return { text: "done" } satisfies ReplyPayload;
    };

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith({ text: "🛠️ `pwd (agent)`" });
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
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
    expect(firstToolResultPayload(dispatcher)?.mediaUrl).toBe(
      "https://example.com/tts-preview.opus",
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("delivers deterministic exec approval tool payloads for native commands with progress suppression", async () => {
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

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)?.channelData).toStrictEqual({
      execApproval: {
        approvalId: "117ba06d-1111-2222-3333-444444444444",
        approvalSlug: "117ba06d",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "NO_REPLY" });
  });

  it("fast-aborts without calling the reply resolver", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "message_received") as () => boolean,
    );
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-fast-abort",
      targetSessionKey: "plugin-binding:test:fast-abort",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "direct:stop-hook",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "test-plugin",
        pluginRoot: "/tmp/test-plugin",
      },
    } satisfies SessionBindingRecord);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "/stop",
      SessionKey: "agent:main:telegram:direct:stop-hook",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted.",
    });
    expect(hookMocks.runner.runMessageReceived).toHaveBeenCalledOnce();
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledOnce();
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-fast-abort");
  });

  it("reports when a fast abort is rejected during finalization", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: false,
      rejectionReason: "finalizing",
    });
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "telegram", Body: "/stop" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      formatAbortReplyTextResolver: (_stopped, rejectionReason) =>
        rejectionReason === "finalizing" ? "already finalizing" : "aborted",
    });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "already finalizing",
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
        stream: { deliveryMode: "live", coalesceIdleMs: 0, maxChunkChars: 128 },
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
    const ensureSessionOptions = firstMockArg(runtime.ensureSession, "ensure session") as
      | { agent?: unknown; mode?: unknown; sessionKey?: unknown }
      | undefined;
    expect(ensureSessionOptions?.sessionKey).toBe("agent:codex-acp:session-1");
    expect(ensureSessionOptions?.agent).toBe("codex");
    expect(ensureSessionOptions?.mode).toBe("persistent");
    const blockCalls = (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(blockCalls.length).toBeGreaterThan(0);
    const streamedText = blockCalls.map((call) => (call[0] as ReplyPayload).text ?? "").join("");
    expect(streamedText).toContain("hello");
    expect(streamedText).toContain("world");
    const finalPayload = firstFinalReplyPayload(dispatcher);
    expect(finalPayload?.text).toBe("hello world");
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

    const lifecycleEvent = agentEventMocks.emitAgentEvent.mock.calls
      .map(
        (call) =>
          call[0] as {
            data?: { phase?: unknown };
            runId?: unknown;
            sessionKey?: unknown;
            stream?: unknown;
          },
      )
      .find((event) => event.runId === "run-acp-lifecycle-end" && event.data?.phase === "end");
    expect(lifecycleEvent?.sessionKey).toBe("agent:codex-acp:session-1");
    expect(lifecycleEvent?.stream).toBe("lifecycle");
    expect(lifecycleEvent?.data?.phase).toBe("end");
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

    const lifecycleEvent = agentEventMocks.emitAgentEvent.mock.calls
      .map(
        (call) =>
          call[0] as {
            data?: { error?: unknown; phase?: unknown };
            runId?: unknown;
            sessionKey?: unknown;
            stream?: unknown;
          },
      )
      .find((event) => event.runId === "run-acp-lifecycle-error" && event.data?.phase === "error");
    expect(lifecycleEvent?.sessionKey).toBe("agent:codex-acp:session-1");
    expect(lifecycleEvent?.stream).toBe("lifecycle");
    expect(lifecycleEvent?.data?.phase).toBe("error");
    expect(String(lifecycleEvent?.data?.error)).toContain("ACP exploded");
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        outcome: "failed",
        errorCode: "message_processing_failed",
        reasonCode: "acp_dispatch_failed",
      }),
    );
    expect(JSON.stringify(messageAuditEvents()[0])).not.toContain("ACP exploded");
  });

  it("audits aborted ACP turns as skipped", async () => {
    setNoAbort();
    const abortController = new AbortController();
    const runtime = createAcpRuntime([]);
    runtime.runTurn.mockImplementation(async function* () {
      abortController.abort();
      yield { type: "done" };
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
    hookMocks.runner.runReplyDispatch.mockImplementationOnce(async (event, contextUnknown) => {
      const context = contextUnknown as Record<string, unknown>;
      return (
        (await tryDispatchAcpReplyHook(
          event as never,
          {
            ...context,
            abortSignal: abortController.signal,
          } as never,
        )) ?? undefined
      );
    });

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
        BodyForAgent: "stop this turn",
      }),
      cfg: {
        diagnostics: { enabled: true },
        acp: {
          enabled: true,
          dispatch: { enabled: true },
          stream: { coalesceIdleMs: 0, maxChunkChars: 128 },
        },
      } as OpenClawConfig,
      dispatcher: createDispatcher(),
    });

    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "blocked",
        outcome: "skipped",
        reasonCode: "acp_dispatch_aborted",
      }),
    );
    expect(messageAuditEvents()[0]).not.toHaveProperty("errorCode");
    const diagnosticEvent = diagnosticMocks.logMessageProcessed.mock.calls
      .map(([event]) => event as { outcome?: unknown; reason?: unknown })
      .find((event) => event.reason === "acp_aborted");
    expect(diagnosticEvent?.outcome).toBe("completed");
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

    const bindingLookup = firstMockArg(
      sessionBindingMocks.resolveByConversation,
      "conversation binding lookup",
    ) as { accountId?: unknown; channel?: unknown; conversationId?: unknown } | undefined;
    expect(bindingLookup?.channel).toBe("discord");
    expect(bindingLookup?.accountId).toBe("work");
    expect(bindingLookup?.conversationId).toBe("thread-1");
    expect(firstToolResultPayload(dispatcher)?.text).toContain("not currently loaded");
    expect(replyResolver).toHaveBeenCalled();
  });

  it("retargets reply_dispatch to a bound generic ACP session before model fallback", async () => {
    setNoAbort();
    const sourceSessionKey = "agent:main:discord:C123";
    const boundSessionKey = "agent:opencode:acp:bound-session";
    const sourceStorePath = "/tmp/main-sessions.json";
    const targetStorePath = "/tmp/opencode-sessions.json";
    const sourceEntry = { sessionId: "source-session-id", updatedAt: Date.now() };
    const targetEntry = { sessionId: "target-session-id", updatedAt: Date.now() };
    const stores: Record<string, Record<string, Record<string, unknown>>> = {
      [sourceStorePath]: { [sourceSessionKey]: sourceEntry },
      [targetStorePath]: { [boundSessionKey]: targetEntry },
    };
    sessionStoreMocks.resolveStorePath.mockImplementation(
      (_configuredPath?: unknown, options?: { agentId?: string }) =>
        options?.agentId === "opencode" ? targetStorePath : sourceStorePath,
    );
    sessionStoreMocks.loadSessionStore.mockImplementation(
      (storePath?: string) => (storePath ? stores[storePath] : undefined) ?? {},
    );
    sessionStoreMocks.resolveSessionStoreEntry.mockImplementation(
      (params?: { store: Record<string, Record<string, unknown>>; sessionKey: string }) => ({
        existing: params?.store[params.sessionKey],
      }),
    );
    sessionStoreMocks.loadSessionEntry.mockImplementation((paramsUnknown: unknown) => {
      const params = paramsUnknown as { sessionKey: string; storePath: string };
      return stores[params.storePath]?.[params.sessionKey];
    });
    const runtime = createAcpRuntime([
      { type: "text_delta", text: "Bound ACP reply" },
      { type: "done" },
    ]);
    acpMocks.readAcpSessionEntry.mockImplementation(
      (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
        params.sessionKey === boundSessionKey
          ? {
              sessionKey: boundSessionKey,
              storeSessionKey: boundSessionKey,
              cfg: {},
              storePath: "/tmp/mock-sessions.json",
              entry: {},
              acp: {
                backend: "acpx",
                agent: "opencode",
                runtimeSessionName: "runtime:opencode",
                mode: "persistent",
                state: "idle",
                lastActivityAt: Date.now(),
              },
            }
          : null,
    );
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });
    const boundConversationBinding = {
      bindingId: "binding-acp-current",
      targetSessionKey: boundSessionKey,
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "C123",
      },
      status: "active",
      boundAt: Date.now(),
    } satisfies SessionBindingRecord;
    sessionBindingMocks.resolveByConversation.mockReturnValue(boundConversationBinding);
    sessionBindingMocks.listBySession.mockImplementation((targetSessionKey: string) =>
      targetSessionKey === boundSessionKey ? [boundConversationBinding] : [],
    );

    const cfg = {
      acp: {
        enabled: true,
        dispatch: { enabled: true },
        stream: { deliveryMode: "live", coalesceIdleMs: 0, maxChunkChars: 256 },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "fallback reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:C123",
      To: "discord:C123",
      AccountId: "default",
      SessionKey: sourceSessionKey,
      BodyForAgent: "continue",
    });

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result.queuedFinal).toBe(true);
    expect(sessionBindingMocks.resolveByConversation).toHaveBeenCalledWith({
      channel: "discord",
      accountId: "default",
      conversationId: "C123",
    });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-acp-current");
    expect(sessionStoreMocks.loadSessionEntry).toHaveBeenCalledWith({
      storePath: sourceStorePath,
      sessionKey: sourceSessionKey,
      readConsistency: "latest",
    });
    expect(sessionStoreMocks.loadSessionEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: targetStorePath,
        sessionKey: sourceSessionKey,
      }),
    );
    const ensureSessionOptions = firstMockArg(runtime.ensureSession, "ensure session") as
      | { agent?: unknown; sessionKey?: unknown }
      | undefined;
    expect(ensureSessionOptions?.sessionKey).toBe(boundSessionKey);
    expect(ensureSessionOptions?.agent).toBe("opencode");
    const runTurnOptions = firstMockArg(runtime.runTurn, "run turn") as
      | { text?: unknown }
      | undefined;
    expect(runTurnOptions?.text).toBe("continue");
    expect(replyResolver).not.toHaveBeenCalled();
    const blockPayload = firstMockArg(
      dispatcher.sendBlockReply as ReturnType<typeof vi.fn>,
      "block reply",
    ) as ReplyPayload | undefined;
    expect(blockPayload?.text).toBe("Bound ACP reply");
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
        stream: { deliveryMode: "live", coalesceIdleMs: 0, maxChunkChars: 256 },
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

    const blockTexts: string[] = [];
    for (const call of (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mock.calls) {
      const text = ((call[0] as ReplyPayload).text ?? "").trim();
      if (text.length > 0) {
        blockTexts.push(text);
      }
    }
    expect(blockTexts).toEqual(["What do you want to work on?"]);
    const finalPayload = firstFinalReplyPayload(dispatcher);
    expect(finalPayload?.text).toBe("What do you want to work on?");
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
        stream: { deliveryMode: "live", coalesceIdleMs: 0, maxChunkChars: 256 },
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

  it("normalizes accumulated block TTS-only media before final delivery", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    replyMediaPathMocks.createReplyMediaPathNormalizer.mockReturnValue(
      async (payload: ReplyPayload) => ({
        ...payload,
        mediaUrl: "/tmp/openclaw-media/normalized-tts.ogg",
        mediaUrls: ["/tmp/openclaw-media/normalized-tts.ogg"],
      }),
    );
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "feishu",
      Surface: "feishu",
      SessionKey: "agent:main:feishu:ou_user",
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "Hello from block streaming." });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    const normalizerOptions = replyMediaPathMocks.createReplyMediaPathNormalizer.mock
      .calls[0]?.[0] as { messageProvider?: unknown } | undefined;
    expect(normalizerOptions?.messageProvider).toBe("feishu");
    const finalPayload = firstFinalReplyPayload(dispatcher);
    expect(finalPayload?.mediaUrl).toBe("/tmp/openclaw-media/normalized-tts.ogg");
    expect(finalPayload?.mediaUrls).toStrictEqual(["/tmp/openclaw-media/normalized-tts.ogg"]);
    expect(finalPayload?.audioAsVoice).toBe(true);
    expect(finalPayload?.spokenText).toBe("Hello from block streaming.");
    expect(finalPayload?.trustedLocalMedia).toBe(true);
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

    const closeOptions = firstMockArg(runtime.close, "runtime close") as
      | { reason?: unknown }
      | undefined;
    expect(closeOptions?.reason).toBe("oneshot-complete");
  });

  it("deduplicates inbound messages by MessageSid and origin", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      AccountId: "default",
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

  it("keeps message-tool-only delivery mode on duplicate inbound returns", async () => {
    setNoAbort();
    const cfg = {
      messages: {
        groupChat: { visibleReplies: "message_tool" },
      },
    } satisfies OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "channel",
      To: "telegram:chat:123",
      MessageSid: "msg-tool-only-duplicate",
      SessionKey: "agent:main:telegram:channel:123",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    const [first, duplicate] = await dispatchTwiceWithFreshDispatchers({
      ctx,
      cfg,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(first.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(duplicate.sourceReplyDeliveryMode).toBe("message_tool_only");
  });

  it("does not mark duplicate inbound returns as tool-only when message is unavailable", async () => {
    setNoAbort();
    const cfg = {
      messages: {
        groupChat: { visibleReplies: "message_tool" },
      },
      tools: { allow: ["read"] },
    } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "channel",
      To: "telegram:chat:123",
      MessageSid: "msg-tool-unavailable-duplicate",
      SessionKey: "agent:main:telegram:channel:123",
    });
    const replyResolver = vi.fn(async () => ({ text: "visible fallback" }) as ReplyPayload);

    const [first, duplicate] = await dispatchTwiceWithFreshDispatchers({
      ctx,
      cfg,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(first.sourceReplyDeliveryMode).toBeUndefined();
    expect(duplicate.sourceReplyDeliveryMode).toBeUndefined();
  });

  it("keeps local discord exec approval tool prompts when the native runtime is inactive", async () => {
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

    expect(firstToolResultPayload(dispatcher)?.text).toBe("Approval required.");
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("done");
  });

  it("suppresses local discord exec approval tool prompts when the native runtime is active", async () => {
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
    const reporter = createApprovalNativeRouteReporter({
      handledKinds: new Set(["exec"]),
      channel: "discord",
      channelLabel: "Discord",
      accountId: "default",
      requestGateway: async <T>() => ({ ok: true }) as T,
    });
    reporter.start();
    try {
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
      expect(firstFinalReplyPayload(dispatcher)?.text).toBe("done");
    } finally {
      await reporter.stop();
    }
  });

  it("keeps local signal exec approval tool prompts when the native runtime is inactive", async () => {
    setNoAbort();
    const cfg = {
      channels: {
        signal: {
          enabled: true,
        },
      },
      approvals: {
        exec: {
          enabled: true,
        },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "signal",
      Surface: "signal",
      AccountId: "default",
      SessionKey: "agent:main:signal:+15551230000",
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, options?: GetReplyOptions) => {
      await options?.onToolResult?.({
        text: "Approval required.",
        channelData: {
          execApproval: {
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            approvalKind: "exec",
            sessionKey: "agent:main:signal:+15551230000",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      });
      return { text: "done" } as ReplyPayload;
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(firstToolResultPayload(dispatcher)?.text).toBe("Approval required.");
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("done");
  });

  it("suppresses local signal exec approval tool prompts when the native runtime is active", async () => {
    setNoAbort();
    const cfg = {
      channels: {
        signal: {
          enabled: true,
        },
      },
      approvals: {
        exec: {
          enabled: true,
        },
      },
    } as OpenClawConfig;
    const reporter = createApprovalNativeRouteReporter({
      handledKinds: new Set(["exec"]),
      channel: "signal",
      channelLabel: "Signal",
      accountId: "default",
      requestGateway: async <T>() => ({ ok: true }) as T,
    });
    reporter.start();
    try {
      const dispatcher = createDispatcher();
      const ctx = buildTestCtx({
        Provider: "signal",
        Surface: "signal",
        AccountId: "default",
        SessionKey: "agent:main:signal:+15551230000",
      });
      const replyResolver = vi.fn(async (_ctx: MsgContext, options?: GetReplyOptions) => {
        await options?.onToolResult?.({
          text: "Approval required.",
          channelData: {
            execApproval: {
              approvalId: "12345678-1234-1234-1234-123456789012",
              approvalSlug: "12345678",
              approvalKind: "exec",
              sessionKey: "agent:main:signal:+15551230000",
              allowedDecisions: ["allow-once", "allow-always", "deny"],
            },
          },
        });
        return { text: "done" } as ReplyPayload;
      });

      await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

      expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
      expect(firstFinalReplyPayload(dispatcher)?.text).toBe("done");
    } finally {
      await reporter.stop();
    }
  });

  it("keeps local signal exec approval tool prompts when top-level exec approvals are disabled", async () => {
    setNoAbort();
    const cfg = {
      channels: {
        signal: {
          enabled: true,
        },
      },
      approvals: {
        exec: {
          enabled: false,
        },
      },
    } as OpenClawConfig;
    const reporter = createApprovalNativeRouteReporter({
      handledKinds: new Set(["exec"]),
      channel: "signal",
      channelLabel: "Signal",
      accountId: "default",
      requestGateway: async <T>() => ({ ok: true }) as T,
    });
    reporter.start();
    try {
      const dispatcher = createDispatcher();
      const ctx = buildTestCtx({
        Provider: "signal",
        Surface: "signal",
        AccountId: "default",
        SessionKey: "agent:main:signal:+15551230000",
      });
      const replyResolver = vi.fn(async (_ctx: MsgContext, options?: GetReplyOptions) => {
        await options?.onToolResult?.({
          text: "Approval required.",
          channelData: {
            execApproval: {
              approvalId: "12345678-1234-1234-1234-123456789012",
              approvalSlug: "12345678",
              approvalKind: "exec",
              sessionKey: "agent:main:signal:+15551230000",
              allowedDecisions: ["allow-once", "allow-always", "deny"],
            },
          },
        });
        return { text: "done" } as ReplyPayload;
      });

      await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

      expect(firstToolResultPayload(dispatcher)?.text).toBe("Approval required.");
      expect(firstFinalReplyPayload(dispatcher)?.text).toBe("done");
    } finally {
      await reporter.stop();
    }
  });

  it("deduplicates same-agent inbound replies across main and direct session keys", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockReturnValue(false);
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
    installThreadingTestPlugin({ id: "telegram" });
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

    const [event, hookContext] = firstMockCall(
      hookMocks.runner.runMessageReceived,
      "message received hook",
    ) as
      | [
          {
            content?: unknown;
            from?: unknown;
            metadata?: Record<string, unknown>;
            timestamp?: unknown;
          },
          { accountId?: unknown; channelId?: unknown; conversationId?: unknown },
        ]
      | [];
    expect(event?.from).toBe(ctx.From);
    expect(event?.content).toBe("/search hello");
    expect(event?.timestamp).toBe(1710000000000);
    expect(event?.metadata?.originatingChannel).toBe("Telegram");
    expect(event?.metadata?.originatingTo).toBe("telegram:999");
    expect(event?.metadata?.messageId).toBe("sid-full");
    expect(event?.metadata?.senderId).toBe("user-1");
    expect(event?.metadata?.senderName).toBe("Alice");
    expect(event?.metadata?.senderUsername).toBe("alice");
    expect(event?.metadata?.senderE164).toBe("+15555550123");
    expect(event?.metadata?.guildId).toBe("guild-123");
    expect(event?.metadata?.channelName).toBe("alerts");
    expect(hookContext?.channelId).toBe("telegram");
    expect(hookContext?.accountId).toBe("acc-1");
    expect(hookContext?.conversationId).toBe("telegram:999");
  });

  it("does not emit shared message_received hooks when the channel emitted them itself", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "message_received") as () => boolean,
    );
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      CommandBody: "hello",
      RawBody: "hello",
      Body: "hello",
      AccountId: "default",
      MessageSid: "wa-msg-1",
      SessionKey: "agent:main:whatsapp:+15555550123",
      SuppressMessageReceivedHooks: true,
    });

    const replyResolver = vi.fn(async () => ({ text: "hi" }) satisfies ReplyPayload);
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runMessageReceived).not.toHaveBeenCalled();
    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalledWith(
      "message",
      "received",
      expect.anything(),
      expect.anything(),
    );
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
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
      SessionKey: "agent:main:hook-test",
    });
    const replyResolver = vi.fn(async () => ({ text: "core reply" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: true, counts: { tool: 0, block: 0, final: 0 } });
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    const [event, hookContext] = firstMockCall(
      hookMocks.runner.runMessageReceived,
      "message received hook",
    ) as
      | [
          { content?: unknown; from?: unknown; metadata?: Record<string, unknown> },
          { accountId?: unknown; channelId?: unknown; conversationId?: unknown },
        ]
      | [];
    expect(event?.from).toBe(ctx.From);
    expect(event?.content).toBe("who are you");
    expect(event?.metadata?.messageId).toBe("msg-claim-1");
    expect(event?.metadata?.originatingChannel).toBe("telegram");
    expect(event?.metadata?.originatingTo).toBe("telegram:-10099");
    expect(event?.metadata?.senderId).toBe("user-9");
    expect(event?.metadata?.senderUsername).toBe("ada");
    expect(event?.metadata?.threadId).toBe(77);
    expect(hookContext?.channelId).toBe("telegram");
    expect(hookContext?.accountId).toBe("default");
    expect(hookContext?.conversationId).toBe("telegram:-10099");
    const internalHookEvent = (
      internalHookMocks.triggerInternalHook.mock.calls as unknown as Array<
        [{ action?: unknown; sessionKey?: unknown; type?: unknown }]
      >
    )[0]?.[0];
    expect(internalHookEvent?.type).toBe("message");
    expect(internalHookEvent?.action).toBe("received");
    expect(internalHookEvent?.sessionKey).toBe("agent:main:hook-test");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("core reply");
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

    const createHookCall = firstMockCall(
      internalHookMocks.createInternalHookEvent,
      "internal hook event",
    ) as
      | [
          unknown,
          unknown,
          unknown,
          {
            channelId?: unknown;
            content?: unknown;
            from?: unknown;
            messageId?: unknown;
            metadata?: Record<string, unknown>;
          },
        ]
      | undefined;
    expect(createHookCall?.[0]).toBe("message");
    expect(createHookCall?.[1]).toBe("received");
    expect(createHookCall?.[2]).toBe("agent:main:main");
    expect(createHookCall?.[3]?.from).toBe(ctx.From);
    expect(createHookCall?.[3]?.content).toBe("/help");
    expect(createHookCall?.[3]?.channelId).toBe("telegram");
    expect(createHookCall?.[3]?.messageId).toBe("msg-42");
    expect(createHookCall?.[3]?.metadata?.guildId).toBe("guild-456");
    expect(createHookCall?.[3]?.metadata?.channelName).toBe("ops-room");
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

  it("falls back to CommandTargetSessionKey for internal hook when SessionKey is empty", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "hello",
      MessageSid: "msg-99",
    });
    (ctx as MsgContext).SessionKey = undefined;
    (ctx as MsgContext).CommandTargetSessionKey = "agent:main:discord:guild:123";

    const replyResolver = async () => ({ text: "reply" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const createHookCall = firstMockCall(
      internalHookMocks.createInternalHookEvent,
      "internal hook event",
    ) as [unknown, unknown, unknown, { content?: unknown; messageId?: unknown }] | undefined;
    expect(createHookCall?.[0]).toBe("message");
    expect(createHookCall?.[1]).toBe("received");
    expect(createHookCall?.[2]).toBe("agent:main:discord:guild:123");
    expect(createHookCall?.[3]?.content).toBe("hello");
    expect(createHookCall?.[3]?.messageId).toBe("msg-99");
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("routes native-command-redirect replies using the redirect target sessionKey for outbound delivery", async () => {
    // Regression test for the native redirect session-key contract:
    // when a native command targets a different session via
    // `CommandTargetSessionKey`, the agent runtime resolves its
    // `params.sessionKey` as `CommandTargetSessionKey ?? SessionKey`
    // (see `get-reply.ts`). Routed reply delivery must mirror that so
    // `agent_end` (fired with the runtime sessionKey) and the outbound
    // `message_sending` hook (fired with `OutboundSessionContext.key`)
    // see the same canonical key. Without this alignment, plugins
    // correlating per-turn state across `agent_end` and `message_sending`
    // would receive divergent keys on every native redirect.
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      AccountId: "acc-1",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      CommandSource: "native",
      SessionKey: "agent:main:slack:channel:CHAN1",
      CommandTargetSessionKey: "agent:main:telegram:direct:999",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledTimes(1);
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:999",
        sessionKey: "agent:main:telegram:direct:999",
        policySessionKey: "agent:main:telegram:direct:999",
      }),
    );
  });

  it("routes non-native (text) command replies using the inbound sessionKey for outbound delivery", async () => {
    // Companion regression test: for non-native commands the routed
    // reply must keep the inbound `SessionKey` as both the canonical
    // session key and the policy key, even if `CommandTargetSessionKey`
    // happens to be set on the context. This guards against accidental
    // generalization of the native-redirect branch.
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      AccountId: "acc-1",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      CommandSource: "text",
      SessionKey: "agent:main:slack:channel:CHAN1",
      CommandTargetSessionKey: "agent:main:telegram:direct:999",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledTimes(1);
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:999",
        sessionKey: "agent:main:slack:channel:CHAN1",
        policySessionKey: "agent:main:slack:channel:CHAN1",
      }),
    );
  });

  it("audits completed inbound message processing", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    vi.mocked(dispatcher.getQueuedCounts).mockReturnValue({ tool: 1, block: 0, final: 1 });
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "  ",
      AccountId: "acc-1",
      NativeChannelId: "  ",
      OriginatingTo: "C123",
      SenderId: "U123",
      SessionKey: "agent:main:slack:direct:C123",
      MessageSid: "msg-audit-1",
      MessageSidFull: "  ",
      ChatType: "dm",
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { runId: "run-audit-1" },
      replyResolver: async () => ({ text: "hi" }) satisfies ReplyPayload,
    });

    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledTimes(1);
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        occurredAt: expect.any(Number),
        kind: "message",
        action: "message.inbound.processed",
        status: "succeeded",
        actorType: "channel_sender",
        actorId: "U123",
        agentId: "main",
        runId: "run-audit-1",
        direction: "inbound",
        channel: "slack",
        conversationKind: "direct",
        outcome: "completed",
        durationMs: expect.any(Number),
        resultCount: 2,
        accountId: "acc-1",
        conversationId: "C123",
        messageId: "msg-audit-1",
      }),
    );
  });

  it("uses finalized reply-dispatch counts for the inbound terminal", async () => {
    setNoAbort();
    hookMocks.runner.runReplyDispatch.mockImplementationOnce(async (_event, contextUnknown) => {
      const context = contextUnknown as {
        recordProcessed: (outcome: "completed", options: { reason: string }) => void;
      };
      context.recordProcessed("completed", { reason: "acp_dispatch" });
      return {
        handled: true,
        queuedFinal: true,
        counts: { tool: 2, block: 3, final: 4 },
      };
    });
    const dispatcher = createDispatcher();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        MessageSid: "msg-audit-routed-counts",
      }),
      cfg: emptyConfig,
      dispatcher,
    });

    expect(result.counts).toEqual({ tool: 2, block: 3, final: 4 });
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        reasonCode: "acp_dispatch_completed",
        resultCount: 9,
      }),
    );
  });

  it("correlates inbound processing with the generated agent run", async () => {
    setNoAbort();

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "slack", Surface: "slack" }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async (_ctx, options) => {
        options?.onAgentRunStart?.("generated-run-audit-1");
        return { text: "hi" } satisfies ReplyPayload;
      },
    });

    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({ runId: "generated-run-audit-1" }),
    );
  });

  it("audits setup failures without replacing the dispatch error", async () => {
    setNoAbort();
    runtimePluginMocks.ensureRuntimePluginsLoaded.mockImplementationOnce(() => {
      throw new Error("setup failed");
    });

    await expect(
      dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "slack",
          Surface: "slack",
          MessageSid: "msg-audit-setup-failure",
        }),
        cfg: emptyConfig,
        dispatcher: createDispatcher(),
      }),
    ).rejects.toThrow("setup failed");

    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        outcome: "failed",
        errorCode: "message_processing_failed",
        resultCount: 0,
      }),
    );
    expect(JSON.stringify(messageAuditEvents()[0])).not.toContain("setup failed");
  });

  it("skips inbound audit attribution work when no listener is registered", async () => {
    setNoAbort();
    messageAuditMocks.enabled = false;

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "slack", Surface: "slack" }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "hi" }) satisfies ReplyPayload,
    });

    expect(messageAuditMocks.emitTrustedMessageAuditEvent).not.toHaveBeenCalled();
  });

  it("does not let an audit emission failure reject successful dispatch", async () => {
    setNoAbort();
    messageAuditMocks.emitTrustedMessageAuditEvent.mockImplementationOnce(() => {
      throw new Error("audit unavailable");
    });

    await expect(
      dispatchReplyFromConfig({
        ctx: buildTestCtx({ Provider: "slack", Surface: "slack" }),
        cfg: emptyConfig,
        dispatcher: createDispatcher(),
        replyResolver: async () => ({ text: "hi" }) satisfies ReplyPayload,
      }),
    ).resolves.toMatchObject({ counts: expect.any(Object) });
  });

  it("does not include message content or session identifiers in inbound audit events", async () => {
    setNoAbort();
    const privateBody = "private inbound body 7ca58b";
    const privateSessionKey = "agent:private:slack:direct:C999";
    const privateSenderName = "Private Sender Name 7ca58b";
    const privateSenderUsername = "private-sender-7ca58b";

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        AccountId: "acc-private",
        NativeChannelId: "C999",
        SessionKey: privateSessionKey,
        MessageSid: "msg-audit-private",
        Body: privateBody,
        BodyForAgent: privateBody,
        CommandBody: privateBody,
        RawBody: privateBody,
        SenderName: privateSenderName,
        SenderUsername: privateSenderUsername,
      }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "hi" }) satisfies ReplyPayload,
    });

    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledTimes(1);
    const event = messageAuditEvents()[0];
    const serializedEvent = JSON.stringify(event);
    expect(event).toEqual(
      expect.objectContaining({
        action: "message.inbound.processed",
        actorType: "system",
        actorId: "gateway",
      }),
    );
    expect(event).not.toHaveProperty("body");
    expect(event).not.toHaveProperty("sessionKey");
    expect(event).not.toHaveProperty("error");
    expect(serializedEvent).not.toContain(privateBody);
    expect(serializedEvent).not.toContain(privateSessionKey);
    expect(serializedEvent).not.toContain(privateSenderName);
    expect(serializedEvent).not.toContain(privateSenderUsername);
  });

  it("records the routing channel id ahead of surface and provider", async () => {
    setNoAbort();
    // SDK plugin channels may set only OriginatingChannel, and it is the id
    // outbound rows record; it must win over Surface/Provider variants.
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        OriginatingChannel: "clickclack",
        AccountId: "acc-plugin",
        MessageSid: "msg-audit-plugin-channel",
      }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "hi" }) satisfies ReplyPayload,
    });

    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledTimes(1);
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        action: "message.inbound.processed",
        channel: "clickclack",
      }),
    );
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

    expect(diagnosticMocks.logMessageDispatchStarted).toHaveBeenCalledWith({
      channel: "slack",
      sessionKey: "agent:main:main",
      source: "replyResolver",
    });
    expect(diagnosticMocks.logMessageDispatchCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        outcome: "completed",
        sessionKey: "agent:main:main",
        source: "replyResolver",
      }),
    );
    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logSessionStateChange).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      state: "processing",
      reason: "message_start",
    });
    const processedEvent = firstMockArg(
      diagnosticMocks.logMessageProcessed,
      "message processed",
    ) as { channel?: unknown; outcome?: unknown; sessionKey?: unknown } | undefined;
    expect(processedEvent?.channel).toBe("slack");
    expect(processedEvent?.outcome).toBe("completed");
    expect(processedEvent?.sessionKey).toBe("agent:main:main");
  });

  it("carries the session store UUID on interactive diagnostic events", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "test-uuid-1234",
    };
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
    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "test-uuid-1234",
        sessionKey: "agent:main:main",
      }),
    );
    expect(diagnosticMocks.logSessionStateChange).toHaveBeenCalledWith({
      sessionId: "test-uuid-1234",
      sessionKey: "agent:main:main",
      state: "processing",
      reason: "message_start",
    });
  });

  it("does not stamp a command target's UUID under the source session key", async () => {
    // Native command turn: runs in the source conversation but targets a
    // different session. resolveSessionStoreLookup is command-target-aware, so
    // its entry is the *target's* — while the lifecycle reports the *source*
    // key. The UUID must NOT be attached here, to avoid mis-associating a
    // session id with the wrong session key (agentweave#187).
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "target-session-uuid-9999",
    };
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      CommandSource: "native",
      SessionKey: "agent:main:source-convo",
      CommandTargetSessionKey: "agent:main:target-session",
      MessageSid: "msg-1",
      To: "slack:C123",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledTimes(1);
    const queued = diagnosticMocks.logMessageQueued.mock.calls[0]?.[0] as
      | { sessionId?: unknown; sessionKey?: unknown }
      | undefined;
    expect(queued?.sessionKey).toBe("agent:main:source-convo");
    expect(queued?.sessionId).toBeUndefined();
  });

  it("marks diagnostic progress for real reply events but not reply start callbacks", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      SessionKey: "agent:main:main",
      To: "slack:C123",
    });
    const onReplyStart = vi.fn(async () => {});
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onReplyStart?.();
      await opts?.onToolResult?.({ text: "tool progress" });
      return { text: "hi" };
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyOptions: { onReplyStart },
      replyResolver,
    });

    expect(onReplyStart).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.markDiagnosticSessionProgress).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.markDiagnosticSessionProgress).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
    });
  });

  it("forwards non-answer progress callbacks when source replies are suppressed", async () => {
    setNoAbort();
    const cfg = {
      diagnostics: { enabled: true },
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      ChatType: "channel",
      SessionKey: "agent:main:discord:channel:C1",
      To: "discord:channel:C1",
    });
    const callbacks = {
      toolStart: vi.fn(async () => {}),
      itemEvent: vi.fn(async () => {}),
      commandOutput: vi.fn(async () => {}),
    };
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onToolStart?.({ name: "lookup" });
      await opts?.onItemEvent?.({ progressText: "working" });
      await opts?.onCommandOutput?.({ output: "line", status: "running" });
      return { text: "hi" };
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolStart: callbacks.toolStart,
        onItemEvent: callbacks.itemEvent,
        onCommandOutput: callbacks.commandOutput,
      },
      replyResolver,
    });

    expect(callbacks.toolStart).toHaveBeenCalledTimes(1);
    expect(callbacks.itemEvent).toHaveBeenCalledTimes(1);
    expect(callbacks.commandOutput).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.markDiagnosticSessionProgress).toHaveBeenCalledTimes(3);
    expect(diagnosticMocks.markDiagnosticSessionProgress).toHaveBeenCalledWith({
      sessionKey: "agent:main:discord:channel:C1",
    });
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
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/workspace/openclaw",
        },
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
      OwnerAllowFrom: ["user-9"],
      GatewayClientScopes: ["operator.write"],
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
    const inboundClaimCall = hookMocks.runner.runInboundClaimForPluginOutcome.mock
      .calls[0] as unknown as
      | [
          unknown,
          {
            accountId?: unknown;
            channel?: unknown;
            content?: unknown;
            conversationId?: unknown;
            senderIsOwner?: unknown;
          },
          {
            accountId?: unknown;
            channelId?: unknown;
            conversationId?: unknown;
            pluginBinding?: { data?: Record<string, unknown> };
          },
        ]
      | undefined;
    expect(inboundClaimCall?.[0]).toBe("openclaw-codex-app-server");
    expect(inboundClaimCall?.[1]?.channel).toBe("discord");
    expect(inboundClaimCall?.[1]?.accountId).toBe("default");
    expect(inboundClaimCall?.[1]?.conversationId).toBe("channel:1481858418548412579");
    expect(inboundClaimCall?.[1]?.content).toBe("who are you");
    expect(inboundClaimCall?.[1]?.senderIsOwner).toBe(true);
    expect(inboundClaimCall?.[1]).not.toHaveProperty("gatewayClientScopes");
    expect(inboundClaimCall?.[2]?.channelId).toBe("discord");
    expect(inboundClaimCall?.[2]?.accountId).toBe("default");
    expect(inboundClaimCall?.[2]?.conversationId).toBe("channel:1481858418548412579");
    expect(inboundClaimCall?.[2]?.pluginBinding?.data?.kind).toBe("codex-app-server-session");
    expect(inboundClaimCall?.[2]?.pluginBinding?.data?.sessionFile).toBe("/tmp/session.jsonl");
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("holds session lifecycle mutation until an interrupted plugin claim exits", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "inbound_claim") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "test-plugin", status: "loaded" }];
    let resolveClaim: ((outcome: PluginTargetedInboundClaimOutcome) => void) | undefined;
    hookMocks.runner.runInboundClaimForPluginOutcome.mockImplementationOnce(
      async () =>
        await new Promise<PluginTargetedInboundClaimOutcome>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-lifecycle-race",
      targetSessionKey: "plugin-binding:test:race",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:lifecycle-race",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "test-plugin",
        pluginRoot: "/tmp/test-plugin",
      },
    } satisfies SessionBindingRecord);
    const sessionKey = "agent:main:discord:channel:lifecycle-race";
    const sessionId = "plugin-lifecycle-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const dispatcher = createDispatcher();
    const externalLifecycleRequest = new AsyncResource("external-lifecycle-request");
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      To: "discord:channel:lifecycle-race",
      AccountId: "default",
      SessionKey: sessionKey,
      Body: "hold this claim",
    });
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);
    const dispatch = dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });
    await vi.waitFor(() => {
      expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledOnce();
    });
    expect(replyRunRegistry.get(sessionKey)).toBeDefined();
    expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
      true,
    );

    let mutationRan = false;
    const mutation = externalLifecycleRequest.runInAsyncScope(
      async () =>
        await runExclusiveSessionLifecycleMutation({
          scope: "/tmp/mock-sessions.json",
          identities: [sessionKey, sessionId],
          prepare: async () => {
            await interruptSessionWorkAdmissions({
              scope: "/tmp/mock-sessions.json",
              identities: [sessionKey, sessionId],
            });
          },
          run: async () => {
            mutationRan = true;
          },
        }),
    );
    await vi.waitFor(() => {
      expect(replyRunRegistry.get(sessionKey)?.abortSignal.aborted).toBe(true);
    });
    expect(mutationRan).toBe(false);

    resolveClaim?.({
      status: "handled",
      result: { handled: true, reply: { text: "stale plugin reply" } },
    });
    const result = await dispatch;
    await mutation;

    expect(mutationRan).toBe(true);
    expect(result.queuedFinal).toBe(false);
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    externalLifecycleRequest.emitDestroy();
  });

  it("holds an owned lifecycle lease until abort-insensitive resolver work settles", async () => {
    setNoAbort();
    const sessionKey = "agent:main:discord:channel:owned-resolver-race";
    const sessionId = "owned-resolver-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    let releaseResolver: () => void = () => {};
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    let signalResolverEntered: () => void = () => {};
    const resolverEntered = new Promise<void>((resolve) => {
      signalResolverEntered = resolve;
    });
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      signalResolverEntered();
      await resolverGate;
      await requireBlockReplyHandler(opts?.onBlockReply)({ text: "stale late block" });
      return { text: "stale late final" } satisfies ReplyPayload;
    });
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        To: "discord:channel:owned-resolver-race",
        AccountId: "default",
        SessionKey: sessionKey,
        Body: "hold this resolver",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    await resolverEntered;

    const externalLifecycleRequest = new AsyncResource("external-owned-resolver-lifecycle");
    let mutationRan = false;
    const mutation = externalLifecycleRequest.runInAsyncScope(
      async () =>
        await runExclusiveSessionLifecycleMutation({
          scope: "/tmp/mock-sessions.json",
          identities: [sessionKey, sessionId],
          prepare: async () => {
            await interruptSessionWorkAdmissions({
              scope: "/tmp/mock-sessions.json",
              identities: [sessionKey, sessionId],
            });
          },
          run: async () => {
            mutationRan = true;
          },
        }),
    );

    try {
      const result = await dispatch;
      expect(result.queuedFinal).toBe(false);
      expect(mutationRan).toBe(false);
      expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
        true,
      );

      releaseResolver();
      await mutation;

      expect(mutationRan).toBe(true);
      expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    } finally {
      releaseResolver();
      await mutation;
      externalLifecycleRequest.emitDestroy();
    }
  });

  it("holds a lifecycle lease for plugin claims behind an active reply operation", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "inbound_claim") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "test-plugin", status: "loaded" }];
    let resolveClaim: ((outcome: PluginTargetedInboundClaimOutcome) => void) | undefined;
    hookMocks.runner.runInboundClaimForPluginOutcome.mockImplementationOnce(
      async () =>
        await new Promise<PluginTargetedInboundClaimOutcome>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-active-lifecycle-race",
      targetSessionKey: "plugin-binding:test:active-race",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:active-lifecycle-race",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "test-plugin",
        pluginRoot: "/tmp/test-plugin",
      },
    } satisfies SessionBindingRecord);
    const sessionKey = "agent:main:discord:channel:active-lifecycle-race";
    const sessionId = "plugin-active-lifecycle-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const existingOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    const dispatcher = createDispatcher();
    const externalLifecycleRequest = new AsyncResource("external-active-lifecycle-request");
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      To: "discord:channel:active-lifecycle-race",
      AccountId: "default",
      SessionKey: sessionKey,
      Body: "hold this overlapping claim",
    });
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);
    const dispatch = dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });
    await vi.waitFor(() => {
      expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledOnce();
    });
    expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
      true,
    );

    existingOperation.complete();
    expect(replyRunRegistry.get(sessionKey)).toBeUndefined();

    let mutationPrepared = false;
    let mutationRan = false;
    const mutation = externalLifecycleRequest.runInAsyncScope(
      async () =>
        await runExclusiveSessionLifecycleMutation({
          scope: "/tmp/mock-sessions.json",
          identities: [sessionKey, sessionId],
          prepare: async () => {
            mutationPrepared = true;
            await interruptSessionWorkAdmissions({
              scope: "/tmp/mock-sessions.json",
              identities: [sessionKey, sessionId],
            });
          },
          run: async () => {
            mutationRan = true;
          },
        }),
    );
    await vi.waitFor(() => {
      expect(mutationPrepared).toBe(true);
    });
    expect(mutationRan).toBe(false);

    resolveClaim?.({
      status: "handled",
      result: { handled: true, reply: { text: "stale plugin reply" } },
    });
    const result = await dispatch;
    await mutation;

    expect(mutationRan).toBe(true);
    expect(result.queuedFinal).toBe(false);
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    externalLifecycleRequest.emitDestroy();
  });

  it("does not abort the active owner when its in-band mutation interrupts borrowed work", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "inbound_claim") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "test-plugin", status: "loaded" }];
    let resolveClaim: ((outcome: PluginTargetedInboundClaimOutcome) => void) | undefined;
    hookMocks.runner.runInboundClaimForPluginOutcome.mockImplementationOnce(
      async () =>
        await new Promise<PluginTargetedInboundClaimOutcome>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-owner-mutation-race",
      targetSessionKey: "plugin-binding:test:owner-mutation-race",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:owner-mutation-race",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "test-plugin",
        pluginRoot: "/tmp/test-plugin",
      },
    } satisfies SessionBindingRecord);
    const sessionKey = "agent:main:discord:channel:owner-mutation-race";
    const sessionId = "owner-mutation-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const ownerAdmission = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath: "/tmp/mock-sessions.json",
      kind: "visible",
      resetTriggered: false,
    });
    expect(ownerAdmission.status).toBe("owned");
    if (ownerAdmission.status !== "owned") {
      throw new Error("expected active owner admission");
    }
    const ownerOperation = ownerAdmission.operation;
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        To: "discord:channel:owner-mutation-race",
        AccountId: "default",
        SessionKey: sessionKey,
        Body: "borrow the active lane",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    await vi.waitFor(() => {
      expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledOnce();
    });

    let mutationRan = false;
    const mutation = runWithReplyOperationLifecycleAdmission(ownerOperation, async () =>
      runExclusiveSessionLifecycleMutation({
        scope: "/tmp/mock-sessions.json",
        identities: [sessionKey, sessionId],
        prepare: async () => {
          await interruptSessionWorkAdmissions({
            scope: "/tmp/mock-sessions.json",
            identities: [sessionKey, sessionId],
          });
        },
        run: async () => {
          mutationRan = true;
        },
      }),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(ownerOperation.abortSignal.aborted).toBe(false);
    expect(mutationRan).toBe(false);

    resolveClaim?.({ status: "handled", result: { handled: true } });
    const result = await dispatch;
    await mutation;

    expect(result.queuedFinal).toBe(false);
    expect(ownerOperation.abortSignal.aborted).toBe(false);
    expect(ownerOperation.result).toBeNull();
    expect(replyRunRegistry.get(sessionKey)).toBe(ownerOperation);
    expect(mutationRan).toBe(true);
    expect(replyResolver).not.toHaveBeenCalled();
    ownerOperation.complete();
  });

  it("completes an owned reply operation interrupted during a plugin fallback notice", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "inbound_claim") as () => boolean,
    );
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "missing_plugin",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-interrupted-fallback",
      targetSessionKey: "plugin-binding:test:interrupted-fallback",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:interrupted-fallback",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "missing-plugin",
        pluginRoot: "/tmp/missing-plugin",
      },
    } satisfies SessionBindingRecord);
    const sessionKey = "agent:main:discord:channel:interrupted-fallback";
    const sessionId = "interrupted-fallback-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    let resolveNotice: ((result: { ok: true; messageId: string }) => void) | undefined;
    mocks.routeReply.mockImplementationOnce(
      async () =>
        await new Promise<{ ok: true; messageId: string }>((resolve) => {
          resolveNotice = resolve;
        }),
    );
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:interrupted-fallback",
        To: "discord:channel:interrupted-fallback",
        AccountId: "default",
        SessionKey: sessionKey,
        Body: "fall back",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    await vi.waitFor(() => {
      expect(mocks.routeReply).toHaveBeenCalledOnce();
    });
    const operation = replyRunRegistry.get(sessionKey);
    expect(operation).toBeDefined();

    let mutationRan = false;
    const externalLifecycleRequest = new AsyncResource("interrupted-fallback-lifecycle");
    const mutation = externalLifecycleRequest.runInAsyncScope(
      async () =>
        await runExclusiveSessionLifecycleMutation({
          scope: "/tmp/mock-sessions.json",
          identities: [sessionKey, sessionId],
          prepare: async () => {
            await interruptSessionWorkAdmissions({
              scope: "/tmp/mock-sessions.json",
              identities: [sessionKey, sessionId],
            });
          },
          run: async () => {
            mutationRan = true;
          },
        }),
    );
    await vi.waitFor(() => {
      expect(operation?.abortSignal.aborted).toBe(true);
    });
    expect(mutationRan).toBe(false);

    resolveNotice?.({ ok: true, messageId: "fallback-notice" });
    const result = await dispatch;
    await mutation;

    expect(result.queuedFinal).toBe(false);
    expect(operation?.result).toMatchObject({
      kind: "aborted",
      code: "aborted_for_restart",
    });
    expect(replyRunRegistry.isActive(sessionKey)).toBe(false);
    expect(mutationRan).toBe(true);
    expect(replyResolver).not.toHaveBeenCalled();
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "blocked",
        outcome: "skipped",
        reasonCode: "reply_operation_aborted",
      }),
    );
    expect(messageAuditEvents()[0]).not.toHaveProperty("errorCode");
    externalLifecycleRequest.emitDestroy();
  });

  it("stages remote iMessage media before plugin-bound inbound claim metadata reaches Codex", async () => {
    setNoAbort();
    const order: string[] = [];
    const rawPath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
    const stagedPath =
      "/tmp/openclaw-proof/.openclaw/media/remote-cache/agent-main-imessage/photo.jpg";
    stageSandboxMediaMocks.stageSandboxMedia.mockImplementationOnce(async (paramsUnknown) => {
      order.push("stage");
      const params = paramsUnknown as {
        ctx: MsgContext;
        sessionCtx: MsgContext;
        sessionKey?: string;
        workspaceDir?: string;
        remoteMediaMode?: string;
      };
      expect(params.sessionKey).toBe("agent:main:imessage:direct:user");
      expect(params.workspaceDir).toContain(".openclaw/workspace");
      expect(params.remoteMediaMode).toBe("cache");
      params.ctx.MediaPath = stagedPath;
      params.ctx.MediaPaths = [stagedPath];
      params.ctx.MediaUrl = stagedPath;
      params.ctx.MediaUrls = [stagedPath];
      params.sessionCtx.MediaPath = stagedPath;
      params.sessionCtx.MediaPaths = [stagedPath];
      params.sessionCtx.MediaUrl = stagedPath;
      params.sessionCtx.MediaUrls = [stagedPath];
      return { staged: new Map([[rawPath, stagedPath]]) };
    });
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockImplementationOnce(
      async (_plugin, event) => {
        order.push("claim");
        const claimEvent = event as { metadata?: Record<string, unknown> };
        expect(claimEvent.metadata?.mediaPath).toBe(stagedPath);
        expect(claimEvent.metadata?.mediaPaths).toEqual([stagedPath]);
        expect(claimEvent.metadata?.mediaUrl).toBe(stagedPath);
        expect(claimEvent.metadata?.mediaUrls).toEqual([stagedPath]);
        expect(claimEvent.metadata?.mediaPath).not.toBe(rawPath);
        expect(claimEvent.metadata?.mediaPaths).not.toContain(rawPath);
        return { status: "handled", result: { handled: true } };
      },
    );
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-imessage-codex-media",
      targetSessionKey: "plugin-binding:codex:imessage",
      targetKind: "session",
      conversation: {
        channel: "imessage",
        accountId: "default",
        conversationId: "chat:abc",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/plugins/openclaw-codex-app-server",
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/workspace/openclaw",
        },
      },
    } satisfies SessionBindingRecord);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "imessage",
      Surface: "imessage",
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:chat:abc",
      To: "imessage:chat:abc",
      AccountId: "default",
      SenderId: "user-9",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "what is this?",
      RawBody: "what is this?",
      Body: "what is this?",
      MessageSid: "msg-claim-imessage-media",
      SessionKey: "agent:main:imessage:direct:user",
      MediaPath: rawPath,
      MediaPaths: [rawPath],
      MediaUrl: rawPath,
      MediaUrls: [rawPath],
      MediaType: "image/jpeg",
      MediaTypes: ["image/jpeg"],
      MediaRemoteHost: "user@gateway-host",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(order).toEqual(["stage", "claim"]);
    expect(ctx.MediaStaged).not.toBe(true);
    expect(ctx.MediaPath).toBe(rawPath);
    expect(ctx.MediaPaths).toEqual([rawPath]);
    expect(stageSandboxMediaMocks.stageSandboxMedia).toHaveBeenCalledTimes(1);
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-imessage-codex-media");
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("leaves ordinary non-plugin remote iMessage media for get-reply staging", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "reply_dispatch") as () => boolean,
    );
    const rawPath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "imessage",
      Surface: "imessage",
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:chat:ordinary",
      To: "imessage:chat:ordinary",
      AccountId: "default",
      SenderId: "user-9",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "what is this?",
      RawBody: "what is this?",
      Body: "what is this?",
      MessageSid: "msg-ordinary-imessage-media",
      SessionKey: "agent:main:imessage:direct:user",
      MediaPath: rawPath,
      MediaPaths: [rawPath],
      MediaUrl: rawPath,
      MediaUrls: [rawPath],
      MediaType: "image/jpeg",
      MediaTypes: ["image/jpeg"],
      MediaRemoteHost: "user@gateway-host",
    });
    const replyResolver = vi.fn(async (receivedCtx: MsgContext) => {
      expect(receivedCtx.MediaStaged).not.toBe(true);
      expect(receivedCtx.MediaPath).toBe(rawPath);
      expect(receivedCtx.MediaPaths).toEqual([rawPath]);
      return { text: "agent reply" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(stageSandboxMediaMocks.stageSandboxMedia).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
    expect(ctx.MediaStaged).not.toBe(true);
    expect(ctx.MediaPath).toBe(rawPath);
    expect(ctx.MediaPaths).toEqual([rawPath]);
  });

  it("does not cache-stage remote iMessage media for message_received-only hooks", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "message_received") as () => boolean,
    );
    const rawPath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "imessage",
      Surface: "imessage",
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:chat:ordinary-hook",
      To: "imessage:chat:ordinary-hook",
      AccountId: "default",
      SenderId: "user-9",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "what is this?",
      RawBody: "what is this?",
      Body: "what is this?",
      MessageSid: "msg-ordinary-imessage-hook-media",
      SessionKey: "agent:main:imessage:direct:user",
      MediaPath: rawPath,
      MediaPaths: [rawPath],
      MediaUrl: rawPath,
      MediaUrls: [rawPath],
      MediaType: "image/jpeg",
      MediaTypes: ["image/jpeg"],
      MediaRemoteHost: "user@gateway-host",
    });
    const replyResolver = vi.fn(async (receivedCtx: MsgContext) => {
      expect(receivedCtx.MediaStaged).not.toBe(true);
      expect(receivedCtx.MediaPath).toBe(rawPath);
      expect(receivedCtx.MediaPaths).toEqual([rawPath]);
      return { text: "agent reply" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const [event] = firstMockCall(hookMocks.runner.runMessageReceived, "message received hook") as
      | [{ metadata?: Record<string, unknown> }]
      | [];
    expect(event?.metadata?.mediaPath).toBeUndefined();
    expect(event?.metadata?.mediaPaths).toBeUndefined();
    expect(event?.metadata?.mediaUrl).toBeUndefined();
    expect(event?.metadata?.mediaUrls).toBeUndefined();
    expect(event?.metadata?.mediaStagingPending).toBe(true);
    expect(event?.metadata?.mediaRemoteHost).toBe("user@gateway-host");
    expect(event?.metadata?.originalMediaPath).toBe(rawPath);
    expect(event?.metadata?.originalMediaPaths).toEqual([rawPath]);
    expect(event?.metadata?.originalMediaUrl).toBe(rawPath);
    expect(event?.metadata?.originalMediaUrls).toEqual([rawPath]);
    expect(event?.metadata?.originalMediaType).toBe("image/jpeg");
    expect(event?.metadata?.originalMediaTypes).toEqual(["image/jpeg"]);
    const internalHookCall = firstMockCall(
      internalHookMocks.createInternalHookEvent,
      "internal hook event",
    ) as
      | [
          unknown,
          unknown,
          unknown,
          {
            metadata?: Record<string, unknown>;
          },
        ]
      | undefined;
    expect(internalHookCall?.[3]?.metadata?.mediaStagingPending).toBe(true);
    expect(internalHookCall?.[3]?.metadata?.mediaRemoteHost).toBe("user@gateway-host");
    expect(internalHookCall?.[3]?.metadata?.originalMediaPath).toBe(rawPath);
    expect(internalHookCall?.[3]?.metadata?.originalMediaPaths).toEqual([rawPath]);
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(stageSandboxMediaMocks.stageSandboxMedia).not.toHaveBeenCalled();
    expect(ctx.MediaStaged).not.toBe(true);
    expect(ctx.MediaPath).toBe(rawPath);
    expect(ctx.MediaPaths).toEqual([rawPath]);
  });

  it("routes Discord thread plugin-owned bindings by raw thread id", async () => {
    setNoAbort();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "discord" }),
            messaging: {
              resolveInboundConversation: ({
                to,
                conversationId,
                threadId,
                threadParentId,
              }: ResolveInboundConversationParams) =>
                threadId
                  ? {
                      conversationId: String(threadId),
                      ...(threadParentId
                        ? { parentConversationId: `channel:${threadParentId}` }
                        : {}),
                    }
                  : { conversationId: to ?? conversationId },
            },
          },
        },
      ]),
    );
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true },
    });
    sessionBindingMocks.resolveByConversation.mockImplementation(
      (ref: {
        channel: string;
        accountId: string;
        conversationId: string;
        parentConversationId?: string;
      }) =>
        ref.channel === "discord" &&
        ref.accountId === "default" &&
        ref.conversationId === "1510164477642014740"
          ? ({
              bindingId: "binding-discord-thread",
              targetSessionKey: "plugin-binding:codex:thread",
              targetKind: "session",
              conversation: {
                channel: "discord",
                accountId: "default",
                conversationId: "1510164477642014740",
                parentConversationId: "channel:1510164477642014999",
              },
              status: "active",
              boundAt: 1710000000000,
              metadata: {
                pluginBindingOwner: "plugin",
                pluginId: "openclaw-codex-app-server",
                pluginRoot: "/plugins/openclaw-codex-app-server",
              },
            } satisfies SessionBindingRecord)
          : null,
    );
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:1510164477642014740",
      To: "channel:1510164477642014740",
      AccountId: "default",
      SenderId: "user-9",
      CommandAuthorized: true,
      WasMentioned: false,
      RawBody: "continue",
      Body: "continue",
      MessageSid: "msg-claim-discord-thread",
      MessageThreadId: "1510164477642014740",
      ThreadParentId: "1510164477642014999",
      SessionKey: "agent:main:discord:channel:1510164477642014740",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(sessionBindingMocks.resolveByConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        accountId: "default",
        conversationId: "1510164477642014740",
        parentConversationId: "channel:1510164477642014999",
      }),
    );
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledWith(
      "openclaw-codex-app-server",
      expect.objectContaining({
        channel: "discord",
        conversationId: "1510164477642014740",
        parentConversationId: "channel:1510164477642014999",
      }),
      expect.objectContaining({
        conversationId: "1510164477642014740",
        parentConversationId: "channel:1510164477642014999",
        pluginBinding: expect.objectContaining({ bindingId: "binding-discord-thread" }),
      }),
    );
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("does not run plugin-owned binding delivery when the caller already aborted", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true, reply: { text: "should not send" } },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-aborted-1",
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
        pluginRoot: "/workspace/openclaw-app-server",
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/workspace/openclaw",
        },
      },
    } satisfies SessionBindingRecord);
    const abortController = new AbortController();
    abortController.abort();
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
      MessageSid: "msg-claim-plugin-aborted-1",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyOptions: { abortSignal: abortController.signal },
      replyResolver,
    });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(sessionBindingMocks.touch).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("lets authorized plugin-owned binding commands fall through to command processing", async () => {
    setNoAbort();
    expect(
      registerPluginCommand(
        "codex",
        {
          name: "codex",
          description: "Control Codex app-server bindings",
          acceptsArgs: true,
          requireAuth: true,
          handler: vi.fn(async () => ({ continueAgent: true })),
        },
        { allowReservedCommandNames: true },
      ),
    ).toEqual({ ok: true });
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
      bindingId: "binding-command-escape-1",
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
        detachHint: "/codex detach",
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/workspace/openclaw",
        },
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
      CommandSource: "text",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "/codex detach",
      RawBody: "/codex detach",
      Body: "/codex detach",
      MessageSid: "msg-claim-plugin-command-escape",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "detached" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: true, counts: { tool: 0, block: 0, final: 0 } });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-command-escape-1");
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("detached");
  });

  it("keeps authorized unknown slash text in a plugin-owned binding routed to the bound plugin", async () => {
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
      bindingId: "binding-command-unknown-slash",
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
      CommandSource: "text",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "/notes keep this with the bound plugin",
      RawBody: "/notes keep this with the bound plugin",
      Body: "/notes keep this with the bound plugin",
      MessageSid: "msg-claim-plugin-command-unknown-slash",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-command-unknown-slash");
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledWith(
      "openclaw-codex-app-server",
      expect.objectContaining({ content: "/notes keep this with the bound plugin" }),
      expect.objectContaining({
        pluginBinding: expect.objectContaining({ bindingId: "binding-command-unknown-slash" }),
      }),
    );
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("keeps unauthorized plugin-owned binding slash replies suppressed while routed to the bound plugin", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true, reply: { text: "do not leak slash reply" } },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-command-escape-denied",
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
        detachHint: "/codex detach",
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
      ChatType: "channel",
      CommandSource: "text",
      CommandAuthorized: false,
      WasMentioned: false,
      CommandBody: "/codex detach",
      RawBody: "/codex detach",
      Body: "/codex detach",
      MessageSid: "msg-claim-plugin-command-denied",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-command-escape-denied");
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledWith(
      "openclaw-codex-app-server",
      expect.objectContaining({ content: "/codex detach" }),
      expect.objectContaining({
        pluginBinding: expect.objectContaining({ bindingId: "binding-command-escape-denied" }),
      }),
    );
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers plugin-owned binding replies returned by the owning inbound claim hook", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "codex", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true, reply: { text: "Codex native reply" } },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-reply-1",
      targetSessionKey: "plugin-binding:codex:reply123",
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
        pluginId: "codex",
        pluginRoot: "/plugins/codex",
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
      MessageSid: "msg-claim-plugin-reply",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "Codex native reply" });
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
    const inboundClaimCall = hookMocks.runner.runInboundClaimForPluginOutcome.mock
      .calls[0] as unknown as
      | [
          unknown,
          { accountId?: unknown; channel?: unknown; content?: unknown; conversationId?: unknown },
          { accountId?: unknown; channelId?: unknown; conversationId?: unknown },
        ]
      | undefined;
    expect(inboundClaimCall?.[0]).toBe("openclaw-codex-app-server");
    expect(inboundClaimCall?.[1]?.channel).toBe("discord");
    expect(inboundClaimCall?.[1]?.accountId).toBe("default");
    expect(inboundClaimCall?.[1]?.conversationId).toBe("1480574946919846079");
    expect(inboundClaimCall?.[1]?.content).toBe("who are you");
    expect(inboundClaimCall?.[2]?.channelId).toBe("discord");
    expect(inboundClaimCall?.[2]?.accountId).toBe("default");
    expect(inboundClaimCall?.[2]?.conversationId).toBe("1480574946919846079");
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
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
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

    const notice = firstMockArg(
      dispatcher.sendToolResult as ReturnType<typeof vi.fn>,
      "tool result",
    ) as ReplyPayload | undefined;
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
      cfg: { diagnostics: { enabled: true } } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    const finalNotice = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalNotice?.text).toContain("Plugin binding request failed.");
    expect(finalNotice?.text).not.toContain("boom");
    expect(replyResolver).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        outcome: "failed",
        errorCode: "message_processing_failed",
        reasonCode: "plugin_bound_error",
      }),
    );
    expect(messageAuditEvents()[0]).not.toHaveProperty("error");
    expect(JSON.stringify(messageAuditEvents()[0])).not.toContain("boom");
    const diagnosticEvent = diagnosticMocks.logMessageProcessed.mock.calls
      .map(([event]) => event as { outcome?: unknown; reason?: unknown })
      .find((event) => event.reason === "plugin-bound-error");
    expect(diagnosticEvent?.outcome).toBe("completed");
  });

  it("marks diagnostics skipped for duplicate inbound messages", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      AccountId: "default",
      MessageSid: "msg-dup",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchTwiceWithFreshDispatchers({
      ctx,
      cfg,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    const skippedEvent = diagnosticMocks.logMessageProcessed.mock.calls
      .map(([event]) => event as { channel?: unknown; outcome?: unknown; reason?: unknown })
      .find((event) => event.outcome === "skipped");
    expect(skippedEvent?.channel).toBe("whatsapp");
    expect(skippedEvent?.reason).toBe("duplicate");
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledTimes(2);
    const skippedAuditEvent = messageAuditEvents().find((event) => event.outcome === "skipped");
    expect(skippedAuditEvent).toEqual(
      expect.objectContaining({
        action: "message.inbound.processed",
        status: "blocked",
        actorType: "system",
        actorId: "gateway",
        direction: "inbound",
        channel: "whatsapp",
        outcome: "skipped",
        reasonCode: "duplicate",
      }),
    );
    expect(skippedAuditEvent).not.toHaveProperty("reason");
  });

  it("keeps duplicate skip diagnostics inside the active inbound trace", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      AccountId: "default",
      MessageSid: "msg-dup-trace",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);
    const inboundTrace = createDiagnosticTraceContext();
    const processedTraces: Array<{
      outcome?: unknown;
      reason?: unknown;
      traceId?: string;
      spanId?: string;
    }> = [];

    diagnosticMocks.logMessageProcessed.mockImplementation((event) => {
      const activeTrace = getActiveDiagnosticTraceContext();
      processedTraces.push({
        outcome: event.outcome,
        reason: event.reason,
        traceId: activeTrace?.traceId,
        spanId: activeTrace?.spanId,
      });
    });

    try {
      await runWithDiagnosticTraceContext(inboundTrace, () =>
        dispatchTwiceWithFreshDispatchers({
          ctx,
          cfg,
          replyResolver,
        }),
      );
    } finally {
      diagnosticMocks.logMessageProcessed.mockReset();
    }

    const skippedEvent = processedTraces.find((event) => event.outcome === "skipped");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(skippedEvent?.reason).toBe("duplicate");
    expect(skippedEvent?.traceId).toBe(inboundTrace.traceId);
    expect(skippedEvent?.spanId).toBe(inboundTrace.spanId);
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
    const errorEvent = diagnosticMocks.logMessageProcessed.mock.calls
      .map(([event]) => event as { channel?: unknown; error?: unknown; outcome?: unknown })
      .find((event) => event.outcome === "error");
    expect(errorEvent?.channel).toBe("whatsapp");
    expect(errorEvent?.error).toBe("Error: dispatch failed");
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledTimes(2);
    const failedAuditEvent = messageAuditEvents().find((event) => event.outcome === "failed");
    expect(failedAuditEvent).toEqual(
      expect.objectContaining({
        action: "message.inbound.processed",
        status: "failed",
        direction: "inbound",
        channel: "whatsapp",
        outcome: "failed",
        errorCode: "message_processing_failed",
      }),
    );
    expect(failedAuditEvent).not.toHaveProperty("error");
    expect(JSON.stringify(failedAuditEvent)).not.toContain("dispatch failed");
  });

  it("poisons inbound dedupe when dispatch fails after a block reply", async () => {
    setNoAbort();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550125",
      To: "whatsapp:+15555550125",
      AccountId: "default",
      MessageSid: "msg-dup-block-error",
      SessionKey: "agent:main:whatsapp:direct:+15555550125",
      CommandBody: "hello",
      RawBody: "hello",
      Body: "hello",
    });
    const firstDispatcher = createDispatcher();
    const replyResolver = vi.fn(
      async (_ctx: MsgContext, opts?: GetReplyOptions): Promise<ReplyPayload | undefined> => {
        await opts?.onBlockReply?.({ text: "partial answer" });
        throw new Error("provider failed after block");
      },
    );

    await expect(
      dispatchReplyFromConfig({
        ctx,
        cfg: emptyConfig,
        dispatcher: firstDispatcher,
        replyResolver,
      }),
    ).rejects.toThrow("provider failed after block");

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(firstDispatcher.sendBlockReply).toHaveBeenCalledWith({ text: "partial answer" });
    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("poisons inbound dedupe when dispatch fails after a suppressed tool result", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550126",
      To: "whatsapp:+15555550126",
      AccountId: "default",
      MessageSid: "msg-dup-tool-error",
      SessionKey: "agent:main:whatsapp:direct:+15555550126",
      CommandBody: "hello",
      RawBody: "hello",
      Body: "hello",
    });
    const firstDispatcher = createDispatcher();
    const replyResolver = vi.fn(
      async (_ctx: MsgContext, opts?: GetReplyOptions): Promise<ReplyPayload | undefined> => {
        await opts?.onToolResult?.({ text: "tool touched external state" });
        throw new Error("provider failed after tool");
      },
    );

    await expect(
      dispatchReplyFromConfig({
        ctx,
        cfg: emptyConfig,
        dispatcher: firstDispatcher,
        replyResolver,
      }),
    ).rejects.toThrow("provider failed after tool");

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(firstDispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("passes the loaded config plus configOverride patch to replyResolver when provided", async () => {
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

    expect(receivedCfg).not.toBe(cfg);
    expect(receivedCfg).not.toBe(overrideCfg);
    expect(receivedCfg).toEqual(overrideCfg);
  });

  it("passes the already loaded config to replyResolver when configOverride is not provided", async () => {
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

    expect(receivedCfg).toBe(cfg);
  });

  it("suppresses isReasoning payloads from final replies (WhatsApp channel)", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const replyResolver = async () =>
      [
        { text: "thinking...", isReasoning: true },
        { text: "The answer is 42" },
      ] satisfies ReplyPayload[];
    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });
    const finalCalls = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(finalCalls).toHaveLength(1);
    expect((finalCalls[0]?.[0] as ReplyPayload | undefined)?.text).toBe("The answer is 42");
  });

  it("delivers isReasoning final replies when the channel opts in", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const replyResolver = async () =>
      [
        { text: "thinking...", isReasoning: true },
        { text: "The answer is 42" },
      ] satisfies ReplyPayload[];

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { reasoningPayloadsEnabled: true },
      replyResolver,
    });

    const finalCalls = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(finalCalls.map((call) => (call[0] as ReplyPayload).text)).toEqual([
      "thinking...",
      "The answer is 42",
    ]);
  });

  it("suppresses isCommentary payloads from final replies by default", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const replyResolver = async () =>
      [
        { text: "commentary...", isCommentary: true },
        { text: "The answer is 42" },
      ] satisfies ReplyPayload[];
    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });
    const finalCalls = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(finalCalls).toHaveLength(1);
    expect((finalCalls[0]?.[0] as ReplyPayload | undefined)?.text).toBe("The answer is 42");
  });

  it("delivers isCommentary final replies when the channel opts in", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "discord", Surface: "discord" });
    const replyResolver = async () =>
      [
        { text: "commentary...", isCommentary: true },
        { text: "The answer is 42" },
      ] satisfies ReplyPayload[];

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { commentaryPayloadsEnabled: true },
      replyResolver,
    });

    const finalCalls = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(finalCalls.map((call) => (call[0] as ReplyPayload).text)).toEqual([
      "commentary...",
      "The answer is 42",
    ]);
  });

  it("does not synthesize opted-in final reasoning payloads into TTS media", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const reasoningPayload = {
      text: "thinking...",
      isReasoning: true,
    } satisfies ReplyPayload;

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { reasoningPayloadsEnabled: true },
      replyResolver: async () => reasoningPayload,
    });

    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(reasoningPayload);
  });

  it("does not synthesize opted-in final commentary payloads into TTS media", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "discord", Surface: "discord" });
    const commentaryPayload = {
      text: "commentary...",
      isCommentary: true,
    } satisfies ReplyPayload;

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { commentaryPayloadsEnabled: true },
      replyResolver: async () => commentaryPayload,
    });

    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(commentaryPayload);
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
      await opts?.onBlockReply?.({ text: "thinking...", isReasoning: true });
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
    expect(blockReplySentTexts).not.toContain("thinking...");
    expect(blockReplySentTexts).toContain("The answer is 42");
  });

  it("delivers opted-in block reasoning payloads without applying TTS", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const blockReplySentTexts: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "thinking...", isReasoning: true });
      await opts?.onBlockReply?.({ text: "The answer is 42" });
      return undefined;
    };
    (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: ReplyPayload) => {
        if (payload.text) {
          blockReplySentTexts.push(payload.text);
        }
        return true;
      },
    );

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { reasoningPayloadsEnabled: true },
      replyResolver,
    });

    expect(blockReplySentTexts).toEqual(["thinking...", "The answer is 42"]);
    const blockTtsCalls = ttsMocks.maybeApplyTtsToPayload.mock.calls
      .map(([call]) => call as { kind?: unknown; payload?: ReplyPayload })
      .filter((call) => call.kind === "block");
    expect(blockTtsCalls.map((call) => call.payload?.text)).toEqual(["The answer is 42"]);
  });

  it("suppresses isCommentary payloads from block replies by default", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const blockReplySentTexts: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "commentary...", isCommentary: true });
      await opts?.onBlockReply?.({ text: "The answer is 42" });
      return { text: "The answer is 42" };
    };
    (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: ReplyPayload) => {
        if (payload.text) {
          blockReplySentTexts.push(payload.text);
        }
        return true;
      },
    );
    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });
    expect(blockReplySentTexts).not.toContain("commentary...");
    expect(blockReplySentTexts).toContain("The answer is 42");
  });

  it("delivers opted-in block commentary payloads without applying TTS", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "discord", Surface: "discord" });
    const blockReplySentTexts: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "commentary...", isCommentary: true });
      await opts?.onBlockReply?.({ text: "The answer is 42" });
      return undefined;
    };
    (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: ReplyPayload) => {
        if (payload.text) {
          blockReplySentTexts.push(payload.text);
        }
        return true;
      },
    );

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { commentaryPayloadsEnabled: true },
      replyResolver,
    });

    expect(blockReplySentTexts).toEqual(["commentary...", "The answer is 42"]);
    const blockTtsCalls = ttsMocks.maybeApplyTtsToPayload.mock.calls
      .map(([call]) => call as { kind?: unknown; payload?: ReplyPayload })
      .filter((call) => call.kind === "block");
    expect(blockTtsCalls.map((call) => call.payload?.text)).toEqual(["The answer is 42"]);
  });

  it("strips split TTS directives from streamed block text before delivery", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const blockReplySentTexts: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "Intro [[tts:te" });
      await opts?.onBlockReply?.({ text: "xt]]hidden[[/tts:text]] visible" });
      return undefined;
    };
    (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: ReplyPayload) => {
        if (payload.text) {
          blockReplySentTexts.push(payload.text);
        }
        return true;
      },
    );

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(blockReplySentTexts).toEqual(["Intro ", " visible"]);
    expect(blockReplySentTexts.join("")).not.toContain("[[tts");
    expect(blockReplySentTexts.join("")).not.toContain("hidden");
    const ttsCall = ttsMocks.maybeApplyTtsToPayload.mock.calls
      .map(([call]) => call as { kind?: unknown; payload?: ReplyPayload })
      .find((call) => call.kind === "final");
    expect(ttsCall?.kind).toBe("final");
    expect(ttsCall?.payload).toEqual({ text: "Intro [[tts:text]]hidden[[/tts:text]] visible" });
    const finalPayload = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalPayload?.mediaUrl).toBe("https://example.com/tts-synth.opus");
  });

  it("forwards generated-media block replies in WhatsApp group sessions", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:120363111111111@g.us",
      To: "whatsapp:120363111111111@g.us",
      SessionKey: "agent:main:whatsapp:group:120363111111111@g.us",
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({
        text: "generated",
        mediaUrls: ["https://example.com/generated.png"],
      });
      return { text: "NO_REPLY" };
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver,
    });

    expect(dispatcher.sendBlockReply).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({
      text: "generated",
      mediaUrls: ["https://example.com/generated.png"],
    });
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

  it("does not wait for same-channel block dispatcher delivery before resolving block replies", async () => {
    setNoAbort();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const delivered: ReplyPayload[] = [];
    let releaseDelivery: (() => void) | undefined;
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        markDeliveryStarted?.();
        await deliveryGate;
      },
    });
    let blockReplySettled = false;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      const blockReplyPromise = Promise.resolve(opts?.onBlockReply?.({ text: "before tool" })).then(
        () => {
          blockReplySettled = true;
        },
      );

      await deliveryStarted;

      expect(delivered).toEqual([{ text: "before tool" }]);
      await blockReplyPromise;
      expect(blockReplySettled).toBe(true);

      releaseDelivery?.();
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(blockReplySettled).toBe(true);
    await dispatcher.waitForIdle();
  });

  it("waits for pending same-channel block delivery before completing block-only dispatch", async () => {
    setNoAbort();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const delivered: ReplyPayload[] = [];
    let releaseDelivery: (() => void) | undefined;
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        markDeliveryStarted?.();
        await deliveryGate;
      },
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "only block" });
      return undefined;
    };

    let dispatchSettled = false;
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    }).then((result) => {
      dispatchSettled = true;
      return result;
    });

    await deliveryStarted;

    expect(delivered).toEqual([{ text: "only block" }]);
    expect(dispatchSettled).toBe(false);

    releaseDelivery?.();
    await dispatchPromise;

    expect(dispatchSettled).toBe(true);
  });

  it("waits for pending same-channel block delivery before forwarding tool progress", async () => {
    setNoAbort();
    const cfg = {
      agents: { defaults: { verboseDefault: "on" } },
    } as const satisfies OpenClawConfig;
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const delivered: ReplyPayload[] = [];
    let releaseDelivery: (() => void) | undefined;
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const progressOrder: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        if (payload.text === "final") {
          progressOrder.push("final");
        }
        markDeliveryStarted?.();
        await deliveryGate;
      },
    });
    const onToolStart = vi.fn();
    onToolStart.mockImplementation(() => {
      progressOrder.push("tool");
    });
    const onPartialReply = vi.fn(() => {
      progressOrder.push("partial");
    });
    let toolProgressSettled = false;
    let toolProgressPromise: Promise<void> | undefined;
    let partialProgressPromise: Promise<void> | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "before tool" });
      toolProgressPromise = Promise.resolve(opts?.onToolStart?.({ name: "lookup" })).then(() => {
        toolProgressSettled = true;
      });
      partialProgressPromise = Promise.resolve(opts?.onPartialReply?.({ text: "after tool" }));
      return { text: "final" };
    };

    let dispatchSettled = false;
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        preserveProgressCallbackStartOrder: true,
        onPartialReply,
        onToolStart,
      },
    }).then((result) => {
      dispatchSettled = true;
      return result;
    });

    await deliveryStarted;
    expect(delivered).toEqual([{ text: "before tool" }]);
    expect(onToolStart).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(toolProgressSettled).toBe(false);
    expect(dispatchSettled).toBe(false);

    releaseDelivery?.();
    await Promise.all([dispatchPromise, toolProgressPromise, partialProgressPromise]);

    expect(dispatchSettled).toBe(true);
    expect(toolProgressSettled).toBe(true);
    expect(onToolStart).toHaveBeenCalledWith({ name: "lookup" });
    expect(onPartialReply).toHaveBeenCalledWith({ text: "after tool" });
    expect(progressOrder).toEqual(["tool", "partial", "final"]);
    expect(delivered).toEqual([{ text: "before tool" }, { text: "final" }]);
  });

  it("does not synthesize tool-start capability while ordering item progress", async () => {
    setNoAbort();
    const cfg = {
      agents: { defaults: { verboseDefault: "on" } },
    } as const satisfies OpenClawConfig;
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const delivered: ReplyPayload[] = [];
    let releaseDelivery: (() => void) | undefined;
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        markDeliveryStarted?.();
        await deliveryGate;
      },
    });
    const onItemEvent = vi.fn();
    let itemProgressSettled = false;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "before item" });
      expect(opts?.onToolStart).toBeUndefined();
      const itemProgressPromise = Promise.resolve(
        opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running" }),
      ).then(() => {
        itemProgressSettled = true;
      });

      await deliveryStarted;

      expect(delivered).toEqual([{ text: "before item" }]);
      expect(onItemEvent).not.toHaveBeenCalled();
      expect(itemProgressSettled).toBe(false);

      releaseDelivery?.();
      await itemProgressPromise;
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { onItemEvent },
    });

    expect(itemProgressSettled).toBe(true);
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "1",
      kind: "tool",
      progressText: "running",
    });
  });

  it("forwards payload metadata into onBlockReplyQueued context", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const onBlockReplyQueued = vi.fn();
    const { setReplyPayloadMetadata: setReplyPayloadMetadataLocal } = await import("../types.js");
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      const payload = setReplyPayloadMetadataLocal({ text: "Alpha" }, { assistantMessageIndex: 7 });
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
      { assistantMessageIndex: 7 },
    );
    const queuedPayload = onBlockReplyQueued.mock.calls[0]?.[0];
    expect(queuedPayload ? getReplyPayloadMetadata(queuedPayload) : undefined).toMatchObject({
      assistantMessageIndex: 7,
    });
    const deliveredPayload = vi.mocked(dispatcher.sendBlockReply).mock.calls[0]?.[0];
    expect(deliveredPayload ? getReplyPayloadMetadata(deliveredPayload) : undefined).toMatchObject({
      assistantMessageIndex: 7,
    });
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
    installThreadingTestPlugin({ id: "telegram" });
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

    const beforeDispatchCall = firstMockCall(
      hookMocks.runner.runBeforeDispatch,
      "before dispatch hook",
    ) as
      | [
          {
            body?: unknown;
            channel?: unknown;
            content?: unknown;
            isGroup?: unknown;
            senderId?: unknown;
            timestamp?: unknown;
          },
          { channelId?: unknown; senderId?: unknown },
        ]
      | undefined;
    expect(beforeDispatchCall?.[0]?.content).toBe("command body");
    expect(beforeDispatchCall?.[0]?.body).toBe("agent body");
    expect(beforeDispatchCall?.[0]?.channel).toBe("telegram");
    expect(beforeDispatchCall?.[0]?.senderId).toBe("signal:user:alice");
    expect(beforeDispatchCall?.[0]?.isGroup).toBe(true);
    expect(beforeDispatchCall?.[0]?.timestamp).toBe(123);
    expect(beforeDispatchCall?.[1]?.channelId).toBe("telegram");
    expect(beforeDispatchCall?.[1]?.senderId).toBe("signal:user:alice");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall() as
      | { channel?: unknown; payload?: ReplyPayload; to?: unknown }
      | undefined;
    expect(routeCall?.channel).toBe("telegram");
    expect(routeCall?.to).toBe("telegram:999");
    expect(routeCall?.payload?.text).toBe("Blocked");
    expect(routeCall?.payload?.mediaUrl).toBe("https://example.com/tts-synth.opus");
    expect(routeCall?.payload?.audioAsVoice).toBe(true);
    expect(result.queuedFinal).toBe(true);
  });

  it("passes inbound reply metadata to before_dispatch event and context", async () => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true });
    const dispatcher = createDispatcher();
    const ctx = createHookCtx({
      ReplyToId: "discord-reply-123",
      ReplyToIdFull: "discord:channel-1:discord-reply-123",
      ReplyToBody: "the quoted parent message",
      ReplyToSender: "Ada",
      ReplyToIsQuote: true,
    });

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher });

    const beforeDispatchCall = firstMockCall(
      hookMocks.runner.runBeforeDispatch,
      "before dispatch hook",
    ) as
      | [
          {
            replyToId?: unknown;
            replyToIdFull?: unknown;
            replyToBody?: unknown;
            replyToSender?: unknown;
            replyToIsQuote?: unknown;
          },
          {
            replyToId?: unknown;
            replyToIdFull?: unknown;
            replyToBody?: unknown;
            replyToSender?: unknown;
            replyToIsQuote?: unknown;
          },
        ]
      | undefined;
    expect(beforeDispatchCall?.[0]).toMatchObject({
      replyToId: "discord-reply-123",
      replyToIdFull: "discord:channel-1:discord-reply-123",
      replyToBody: "the quoted parent message",
      replyToSender: "Ada",
      replyToIsQuote: true,
    });
    expect(beforeDispatchCall?.[1]).toMatchObject({
      replyToId: "discord-reply-123",
      replyToIdFull: "discord:channel-1:discord-reply-123",
      replyToBody: "the quoted parent message",
      replyToSender: "Ada",
      replyToIsQuote: true,
    });
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
  });

  it("still calls the replyResolver when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.suppressTyping).toBe(true);
      return { text: "agent reply" } satisfies ReplyPayload;
    });
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
    diagnosticMocks.logMessageDispatchStarted.mockClear();
    diagnosticMocks.logMessageDispatchCompleted.mockClear();
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
      cfg: { diagnostics: { enabled: true } } as OpenClawConfig,
      dispatcher,
      replyResolver: async () => ({ text: "agent reply" }),
    });

    const tailDispatchCall = hookMocks.runner.runReplyDispatch.mock.calls.find(
      ([event]) => (event as { isTailDispatch?: boolean }).isTailDispatch === true,
    );
    const tailDispatchEvent = tailDispatchCall?.[0] as
      | {
          isTailDispatch?: unknown;
          sendPolicy?: unknown;
          suppressReplyLifecycle?: unknown;
          suppressUserDelivery?: unknown;
        }
      | undefined;
    expect(tailDispatchEvent?.isTailDispatch).toBe(true);
    expect(tailDispatchEvent?.sendPolicy).toBe("deny");
    expect(tailDispatchEvent?.suppressUserDelivery).toBe(true);
    expect(tailDispatchEvent?.suppressReplyLifecycle).toBe(true);
    if (tailDispatchCall?.[1] === undefined) {
      throw new Error("Expected tail dispatch metadata");
    }
    expect(diagnosticMocks.logMessageDispatchStarted).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logMessageDispatchCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        sessionKey: "test:session",
        source: "replyResolver",
      }),
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
    expect(result.sendPolicyDenied).toBe(true);
  });

  it("keeps the suppressed reply log preview UTF-16 safe", async () => {
    setNoAbort();
    globalMocks.logVerbose.mockClear();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const text = `${"y".repeat(159)}🚀`;

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ SessionKey: "test:session" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text }),
    });

    const suppressedLog = globalMocks.logVerbose.mock.calls.find(([message]) =>
      message.includes("final reply suppressed"),
    )?.[0];
    expect(suppressedLog).toContain("textChars=161");
    expect(suppressedLog).toContain(`textPreview=${JSON.stringify("y".repeat(159))}`);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("does not mark allowed group silence eligible for no-visible fallback", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "feishu",
      Provider: "feishu",
      SessionKey: "agent:main:feishu:group:oc_group",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
  });

  it("marks disallowed group silence eligible for no-visible fallback", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "feishu",
      Provider: "feishu",
      SessionKey: "agent:main:feishu:group:oc_group",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              group: "disallow",
            },
          },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      noVisibleReplyFallbackEligible: true,
    });
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
    await requireToolResultHandler(capturedOnToolResult)({ text: "tool output" });
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
    await requireBlockReplyHandler(capturedOnBlockReply)({ text: "streaming chunk" });
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

  it("delivers provider conversation-state runner payloads as outbound channel replies", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const exactProviderError = "Custom tool call output is missing for call id: call_live_123.";
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (receivedCtx: MsgContext) => {
      expect(receivedCtx.Body).toBe(exactProviderError);
      return {
        text: PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
      } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:provider-error",
      To: "discord:channel:provider-error",
      AccountId: "default",
      SessionKey: "agent:main:discord:channel:provider-error",
      Body: exactProviderError,
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
    });
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

  it("rejects archived plugin-bound work before the plugin handler runs", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "inbound_claim") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true, reply: { text: "must not send" } },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-archived",
      targetSessionKey: "plugin-binding:codex:archived",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:archived-test",
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
      updatedAt: Date.now(),
      archivedAt: Date.now(),
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      To: "discord:channel:archived-test",
      AccountId: "default",
      SessionKey: "agent:main:discord:channel:archived-test",
      Body: "start work",
    });

    await expect(
      dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver }),
    ).rejects.toThrow(/is archived/i);

    expect(sessionBindingMocks.touch).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
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

  it.each([
    {
      name: "handled without a plugin reply",
      bindingId: "binding-message-tool-only",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:11",
        parentConversationId: "-1001234567890",
      },
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-1001234567890",
        To: "telegram:-1001234567890",
        AccountId: "default",
        MessageThreadId: 11,
        ChatType: "group",
        GroupSubject: "Dev",
        Body: "observed message",
      },
      cfg: emptyConfig,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only" as const,
      },
      expectedClaim: { channel: "telegram", threadId: 11 },
    },
    {
      name: "handled with a plugin reply",
      bindingId: "binding-message-tool-reply",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:reply-test",
      },
      ctx: {
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:reply-test",
        To: "discord:channel:reply-test",
        AccountId: "default",
        ChatType: "channel",
        Body: "observed message",
        SessionKey: "agent:main:discord:channel:reply-test",
      },
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
      } as OpenClawConfig,
      expectedClaim: { channel: "discord" },
      pluginReply: { text: "Codex native reply" },
      expectPluginReplyDelivered: true,
    },
    {
      name: "suppresses ambient room_event plugin reply",
      bindingId: "binding-message-tool-room-event",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:room-event-test",
      },
      ctx: {
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:room-event-test",
        To: "discord:channel:room-event-test",
        AccountId: "default",
        ChatType: "group",
        InboundEventKind: "room_event",
        Body: "observed message",
        SessionKey: "agent:main:discord:channel:room-event-test",
      },
      cfg: emptyConfig,
      expectedClaim: { channel: "discord" },
      pluginReply: { text: "Codex ambient room event reply" },
      expectPluginReplyDelivered: false,
    },
  ] satisfies Array<{
    name: string;
    bindingId: string;
    conversation: SessionBindingRecord["conversation"];
    ctx: Partial<MsgContext>;
    cfg: OpenClawConfig;
    replyOptions?: { sourceReplyDeliveryMode: "message_tool_only" };
    expectedClaim: Record<string, unknown>;
    pluginReply?: ReplyPayload;
    expectPluginReplyDelivered?: boolean;
  }>)(
    "routes plugin-owned bindings under message-tool-only source delivery: $name",
    async (params) => {
      setNoAbort();
      hookMocks.runner.hasHooks.mockImplementation(
        ((hookName?: string) =>
          hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
      );
      hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
      hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
        status: "handled",
        result: params.pluginReply
          ? { handled: true, reply: params.pluginReply }
          : { handled: true },
      });
      sessionBindingMocks.resolveByConversation.mockReturnValue({
        bindingId: params.bindingId,
        targetSessionKey: "plugin-binding:codex:abc123",
        targetKind: "session",
        conversation: params.conversation,
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
        sendPolicy: "allow",
      };
      const dispatcher = createDispatcher();
      const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);

      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx(params.ctx),
        cfg: params.cfg,
        dispatcher,
        replyResolver,
        replyOptions: params.replyOptions,
      });

      expect(result).toEqual({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
        sourceReplyDeliveryMode: "message_tool_only",
      });
      expect(sessionBindingMocks.touch).toHaveBeenCalledWith(params.bindingId);
      expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledWith(
        "openclaw-codex-app-server",
        expect.objectContaining({
          content: "observed message",
          ...params.expectedClaim,
        }),
        expect.objectContaining({
          pluginBinding: expect.objectContaining({ bindingId: params.bindingId }),
        }),
      );
      expect(replyResolver).not.toHaveBeenCalled();
      if (params.expectPluginReplyDelivered) {
        expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(params.pluginReply);
      } else {
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps unmentioned plugin-bound fallback from ordinary group agent dispatch", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-message-tool-fallback",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:11",
        parentConversationId: "-1001234567890",
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
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-1001234567890",
      To: "telegram:-1001234567890",
      AccountId: "default",
      MessageThreadId: 11,
      ChatType: "group",
      GroupSubject: "Dev",
      Body: "observed message",
      WasMentioned: false,
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });
    const claimCall = firstMockCall(
      hookMocks.runner.runInboundClaimForPluginOutcome,
      "plugin inbound claim",
    );
    expect(claimCall[0]).toBe("openclaw-codex-app-server");
    expect(claimCall[1]).toMatchObject({
      channel: "telegram",
      content: "observed message",
      threadId: 11,
    });
    const claimContext = claimCall[2] as { pluginBinding?: { bindingId?: string } };
    expect(claimContext.pluginBinding).toMatchObject({
      bindingId: "binding-message-tool-fallback",
    });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "dispatches unmentioned plugin-bound fallback in always-on groups",
      groupRequireMention: false,
      expectedDispatches: 1,
    },
    {
      name: "suppresses unmentioned fallback when channel policy requires a mention",
      groupRequireMention: true,
      expectedDispatches: 0,
    },
  ])("$name", async ({ groupRequireMention, expectedDispatches }) => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    installThreadingTestPlugin({ id: "imessage" });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-imessage-always-on-fallback",
      targetSessionKey: "plugin-binding:codex:imessage",
      targetKind: "session",
      conversation: {
        channel: "imessage",
        accountId: "default",
        conversationId: "chat:primary",
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
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "imessage",
      Surface: "imessage",
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:chat:primary",
      To: "imessage:chat:primary",
      AccountId: "default",
      SessionKey: "agent:main:imessage:group:chat:primary",
      ChatType: "group",
      GroupSubject: "Friends",
      GroupRequireMention: groupRequireMention,
      Body: "observed message",
      From: "imessage:group:chat:primary",
      WasMentioned: false,
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    const claimCall = firstMockCall(
      hookMocks.runner.runInboundClaimForPluginOutcome,
      "plugin inbound claim",
    );
    expect(claimCall[0]).toBe("openclaw-codex-app-server");
    expect(claimCall[1]).toMatchObject({
      channel: "imessage",
      content: "observed message",
    });
    const claimContext = claimCall[2] as { pluginBinding?: { bindingId?: string } };
    expect(claimContext.pluginBinding).toMatchObject({
      bindingId: "binding-imessage-always-on-fallback",
    });
    expect(replyResolver).toHaveBeenCalledTimes(expectedDispatches);
    expect(result.queuedFinal).toBe(false);
    expect(result.counts.block).toBe(0);
    expect(result.counts.final).toBe(0);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("lets authorized control commands without CommandSource escape plugin-bound fallback", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-message-tool-command",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:11",
        parentConversationId: "-1001234567890",
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
      sendPolicy: "allow",
    };
    const cfg = { messages: { visibleReplies: "message_tool" } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "reset ack" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-1001234567890",
      To: "telegram:-1001234567890",
      AccountId: "default",
      MessageThreadId: 11,
      ChatType: "group",
      GroupSubject: "Dev",
      Body: "/reset@openclaw",
      RawBody: "/reset@openclaw",
      CommandBody: "/reset@openclaw",
      BotUsername: "openclaw",
      CommandSource: undefined,
      CommandAuthorized: true,
      WasMentioned: false,
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
    });

    expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "reset ack" });
  });

  it("keeps unauthorized native commands on the plugin-bound claim path", async () => {
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
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-native-unauthorized",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:11",
        parentConversationId: "-1001234567890",
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
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "core reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-1001234567890",
      To: "telegram:-1001234567890",
      AccountId: "default",
      MessageThreadId: 11,
      ChatType: "group",
      GroupSubject: "Dev",
      Body: "/status",
      RawBody: "/status",
      CommandBody: "/status",
      CommandSource: "native",
      CommandAuthorized: false,
      WasMentioned: false,
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    const claimCall = firstMockCall(
      hookMocks.runner.runInboundClaimForPluginOutcome,
      "plugin inbound claim",
    );
    expect(claimCall[0]).toBe("openclaw-codex-app-server");
    expect(claimCall[1]).toMatchObject({
      channel: "telegram",
      content: "/status",
    });
    const claimContext = claimCall[2] as { pluginBinding?: { bindingId?: string } };
    expect(claimContext.pluginBinding).toMatchObject({ bindingId: "binding-native-unauthorized" });
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("keeps structured normal command turns on the plugin-bound claim path", async () => {
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
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-structured-normal-turn",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:11",
        parentConversationId: "-1001234567890",
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
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "core reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-1001234567890",
      To: "telegram:-1001234567890",
      AccountId: "default",
      MessageThreadId: 11,
      ChatType: "group",
      GroupSubject: "Dev",
      Body: "through this",
      RawBody: "through this",
      CommandBody: "/think high through this",
      CommandAuthorized: true,
      CommandTurn: {
        kind: "normal",
        source: "message",
        authorized: false,
        body: "/think high through this",
      },
      WasMentioned: false,
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    const claimCall = firstMockCall(
      hookMocks.runner.runInboundClaimForPluginOutcome,
      "plugin inbound claim",
    );
    expect(claimCall[0]).toBe("openclaw-codex-app-server");
    expect(claimCall[1]).toMatchObject({
      channel: "telegram",
      content: "/think high through this",
    });
    const claimContext = claimCall[2] as { pluginBinding?: { bindingId?: string } };
    expect(claimContext.pluginBinding).toMatchObject({
      bindingId: "binding-structured-normal-turn",
    });
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("keeps message-tool-only source delivery private while still processing the turn", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const callbacks = {
      partial: vi.fn(),
      reasoning: vi.fn(),
      assistantStart: vi.fn(),
      blockQueued: vi.fn(),
      toolStart: vi.fn(),
      itemEvent: vi.fn(),
      planUpdate: vi.fn(),
      toolResult: vi.fn(),
      typingStart: vi.fn(async () => {}),
    };
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.suppressTyping).toBe(false);
      await opts?.onReplyStart?.();
      await opts?.onPartialReply?.({ text: "draft leak" });
      await opts?.onReasoningStream?.({ text: "reasoning leak" });
      await opts?.onAssistantMessageStart?.();
      await opts?.onToolStart?.({ name: "lookup" });
      await opts?.onItemEvent?.({ progressText: "working" });
      await opts?.onPlanUpdate?.({ phase: "update", explanation: "planning" });
      await opts?.onToolResult?.({ text: "tool output" });
      await opts?.onBlockReply?.({ text: "streaming block" });
      return { text: "final reply" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        onPartialReply: callbacks.partial,
        onReasoningStream: callbacks.reasoning,
        onAssistantMessageStart: callbacks.assistantStart,
        onReplyStart: callbacks.typingStart,
        onBlockReplyQueued: callbacks.blockQueued,
        onToolStart: callbacks.toolStart,
        onItemEvent: callbacks.itemEvent,
        onPlanUpdate: callbacks.planUpdate,
        onToolResult: callbacks.toolResult,
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(callbacks.typingStart).toHaveBeenCalledTimes(1);
    for (const [name, callback] of Object.entries(callbacks)) {
      if (name === "typingStart") {
        continue;
      }
      expect(callback).not.toHaveBeenCalled();
    }
    const replyDispatchCall = hookMocks.runner.runReplyDispatch.mock.calls.find(
      ([event]) =>
        (event as { sourceReplyDeliveryMode?: unknown }).sourceReplyDeliveryMode ===
        "message_tool_only",
    );
    const replyDispatchEvent = replyDispatchCall?.[0] as
      | {
          sendPolicy?: unknown;
          sourceReplyDeliveryMode?: unknown;
          suppressReplyLifecycle?: unknown;
          suppressUserDelivery?: unknown;
        }
      | undefined;
    expect(replyDispatchEvent?.suppressUserDelivery).toBe(true);
    expect(replyDispatchEvent?.suppressReplyLifecycle).toBe(false);
    expect(replyDispatchEvent?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(replyDispatchEvent?.sendPolicy).toBe("allow");
    if (replyDispatchCall?.[1] === undefined) {
      throw new Error("Expected reply dispatch metadata");
    }
  });

  it("treats message-tool-only observed delivery as visible for fallback eligibility", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const observedReplyDelivery = vi.fn();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      await opts?.onObservedReplyDelivery?.();
      return { text: "private final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        SessionKey: "test:session",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        onObservedReplyDelivery: observedReplyDelivery,
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(observedReplyDelivery).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.observedReplyDelivery).toBe(true);
    expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("preserves hook-blocked metadata when source delivery is message-tool-only", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const blockedReply = setReplyPayloadMetadata(
      { text: "Your message could not be sent: blocked by policy-plugin", isError: true },
      { beforeAgentRunBlocked: true },
    );
    const replyResolver = vi.fn(async () => blockedReply satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        SessionKey: "test:session",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.beforeAgentRunBlocked).toBe(true);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("delivers fast auto progress in message-tool-only mode without verbose progress", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({
        text: "💨Fast: auto-off(75s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session", ChatType: "channel" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "💨Fast: auto-off(75s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      }),
    );
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("suppresses fast auto progress for room-event message-tool-only turns", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({
        text: "💨Fast: auto-off(75s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({
      SessionKey: "test:session",
      ChatType: "channel",
      InboundEventKind: "room_event",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("suppresses fast auto progress when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({
        text: "💨Fast: auto-off(75s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ SessionKey: "test:session", ChatType: "channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("forwards fast auto progress callbacks without separate message delivery", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const onToolResult = vi.fn();
    const payload = {
      text: "💨Fast: auto-on",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    } satisfies ReplyPayload;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.(payload);
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session", ChatType: "channel" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolResult,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(onToolResult).toHaveBeenCalledWith(payload);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("forwards suppressed tool progress callbacks in message-tool-only mode", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const onToolResult = vi.fn();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({ text: "🛠️ Exec: ruby sleep proof" });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session", ChatType: "channel" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolResult,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(onToolResult).toHaveBeenCalledWith({ text: "🛠️ Exec: ruby sleep proof" });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers forced tool progress in message-tool-only mode without verbose progress", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({ text: "🛠️ Exec: ruby sleep proof" });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session", ChatType: "channel" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        forceToolResultProgress: true,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ text: "🛠️ Exec: ruby sleep proof" }),
    );
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers verbose tool progress in message-tool-only mode", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({ text: "🛠️ Exec: echo post-restart" });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session", ChatType: "channel" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ text: "🛠️ Exec: echo post-restart" }),
    );
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers marked runtime failure notices in message-tool-only mode", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const failureNotice = setReplyPayloadMetadata(
      { text: "⚠️ You've reached your Codex subscription usage limit." },
      { deliverDespiteSourceReplySuppression: true },
    );
    const replyResolver = vi.fn(async () => failureNotice satisfies ReplyPayload);
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(failureNotice);
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it("suppresses marked runtime failure notices for room events", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const failureNotice = setReplyPayloadMetadata(
      { text: "⚠️ You've reached your Codex subscription usage limit." },
      { deliverDespiteSourceReplySuppression: true },
    );
    const replyResolver = vi.fn(async () => failureNotice satisfies ReplyPayload);
    const ctx = buildTestCtx({
      ChatType: "group",
      InboundEventKind: "room_event",
      SessionKey: "test:session",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it("delivers marked explicit command terminal replies in room events (#87107)", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const commandReply = setReplyPayloadMetadata(
      { text: "⚙️ Compacted (76k → 934 tokens)" },
      { deliverDespiteSourceReplySuppression: true },
    );
    const replyResolver = vi.fn(async () => commandReply satisfies ReplyPayload);
    const ctx = buildTestCtx({
      ChatType: "group",
      InboundEventKind: "room_event",
      SessionKey: "test:session",
      CommandSource: "text",
      CommandAuthorized: true,
      CommandBody: "/compact",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(commandReply);
  });

  it("delivers marked /compact reply in room event when CommandSource is undefined (#87107)", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const commandReply = setReplyPayloadMetadata(
      { text: "⚙️ Compacted (76k → 934 tokens)" },
      { deliverDespiteSourceReplySuppression: true },
    );
    const replyResolver = vi.fn(async () => commandReply satisfies ReplyPayload);
    const ctx = buildTestCtx({
      ChatType: "group",
      InboundEventKind: "room_event",
      SessionKey: "test:session",
      CommandAuthorized: true,
      CommandBody: "/compact",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(commandReply);
  });

  it("mirrors internal source reply payloads into the active transcript", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const sourceReply = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );
    const replyResolver = vi.fn(async () => sourceReply satisfies ReplyPayload);
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "webchat", Surface: "webchat", SessionKey: "agent:main" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(sourceReply);
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      sessionKey: "agent:main",
      agentId: "main",
      text: "message tool reply",
      mediaUrls: undefined,
      idempotencyKey: "run-1:internal-source-reply:0",
      expectedSessionId: "s1",
      storePath: "/tmp/mock-sessions.json",
      updateMode: "inline",
      config: emptyConfig,
      beforeMessageWrite: expect.any(Function),
    });
  });

  it("mirrors post-hook internal source reply payloads into the active transcript", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    dispatcher.appendBeforeDeliver?.((payload, info) => {
      if (info.kind !== "final") {
        return payload;
      }
      return setReplyPayloadMetadata(
        {
          ...payload,
          text: "redacted hook reply",
          mediaUrl: undefined,
          mediaUrls: ["https://example.com/redacted.png"],
        },
        getReplyPayloadMetadata(payload) ?? {},
      );
    });
    const sourceReply = setReplyPayloadMetadata(
      { text: "secret message tool reply", mediaUrl: "https://example.com/secret.png" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          agentId: "main",
          text: "secret message tool reply",
          mediaUrls: ["https://example.com/secret.png"],
          idempotencyKey: "run-1:internal-source-reply:rewritten",
        },
      },
    );
    const replyResolver = vi.fn(async () => sourceReply satisfies ReplyPayload);
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "webchat", Surface: "webchat", SessionKey: "agent:main" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(sourceReply);
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      sessionKey: "agent:main",
      agentId: "main",
      text: "redacted hook reply",
      mediaUrls: ["https://example.com/redacted.png"],
      idempotencyKey: "run-1:internal-source-reply:rewritten",
      expectedSessionId: "s1",
      storePath: "/tmp/mock-sessions.json",
      updateMode: "inline",
      config: emptyConfig,
      beforeMessageWrite: expect.any(Function),
    });
  });

  it("lets a queued same-session turn finish before mirroring delivered source replies", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      sessionKey: "agent:main",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const order: string[] = [];
    let followupDispatch: Promise<unknown> | undefined;
    const firstDispatcher = createReplyDispatcher({
      deliver: async () => {
        if (!followupDispatch) {
          throw new Error("expected queued follow-up dispatch");
        }
        await followupDispatch;
        order.push("first-delivery");
      },
    });
    const firstReply = setReplyPayloadMetadata(
      { text: "first reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          agentId: "main",
          text: "first reply",
          idempotencyKey: "run-1:internal-source-reply:queued",
        },
      },
    );
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockImplementationOnce(async () => {
      order.push("mirror");
      return { ok: true, sessionFile: "/tmp/session.jsonl", messageId: "message-1" };
    });

    const firstResult = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        MessageSid: "first-message",
        Provider: "webchat",
        Surface: "webchat",
        SessionKey: "agent:main",
      }),
      cfg: emptyConfig,
      dispatcher: firstDispatcher,
      replyOptions: { sourceReplyDeliveryMode: "message_tool_only" },
      replyResolver: async () => {
        followupDispatch = dispatchReplyFromConfig({
          ctx: buildTestCtx({
            Body: "follow up",
            MessageSid: "followup-message",
            Provider: "webchat",
            Surface: "webchat",
            SessionKey: "agent:main",
          }),
          cfg: emptyConfig,
          dispatcher: createDispatcher(),
          replyResolver: async () => {
            order.push("followup");
            return { text: "second reply" };
          },
        });
        await Promise.resolve();
        return firstReply;
      },
    });

    expect(firstResult.queuedFinal).toBe(true);
    await settleReplyDispatcher({ dispatcher: firstDispatcher });
    await followupDispatch;

    expect(order).toEqual(["followup", "first-delivery", "mirror"]);
    const queuedMirrorCalls = transcriptMocks.appendAssistantMessageToSessionTranscript.mock.calls
      .map(([params]) => params as { idempotencyKey?: string })
      .filter((params) => params.idempotencyKey === "run-1:internal-source-reply:queued");
    expect(queuedMirrorCalls).toHaveLength(1);
  });

  it("does not mirror internal source replies cancelled by dispatcher hooks", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    dispatcher.getCancelledCounts = vi
      .fn()
      .mockReturnValueOnce({ tool: 0, block: 0, final: 0 })
      .mockReturnValue({ tool: 0, block: 0, final: 1 });
    dispatcher.waitForIdle = vi.fn(async () => {});
    const sourceReply = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );
    const replyResolver = vi.fn(async () => sourceReply satisfies ReplyPayload);
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "webchat", Surface: "webchat", SessionKey: "agent:main" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(sourceReply);
    expect(dispatcher.waitForIdle).toHaveBeenCalled();
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("keeps internal source reply metadata on TTS-cloned final payloads", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const sourceReply = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-tts:internal-source-reply:0",
        },
      },
    );
    const replyResolver = vi.fn(async () => sourceReply satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "webchat", Surface: "webchat", SessionKey: "agent:main" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(result.queuedFinal).toBe(true);
    const queuedPayload = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(queuedPayload).toMatchObject({
      text: "message tool reply",
      mediaUrl: "https://example.com/tts-synth.opus",
      audioAsVoice: true,
    });
    expect(getReplyPayloadMetadata(queuedPayload)?.sourceReplyTranscriptMirror).toMatchObject({
      sessionKey: "agent:main",
      idempotencyKey: "run-tts:internal-source-reply:0",
    });
  });

  it("does not deliver marked runtime failure notices when sendPolicy denies delivery", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(
      async () =>
        setReplyPayloadMetadata(
          { text: "⚠️ You've reached your Codex subscription usage limit." },
          { deliverDespiteSourceReplySuppression: true },
        ) satisfies ReplyPayload,
    );
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("keeps opted-in group/channel final replies private when message-tool-only events miss the message tool", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(opts?.suppressTyping).toBe(false);
      return { text: "final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        CommandSource: undefined,
        SessionKey: "test:discord:channel:C1",
      }),
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
      },
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("keeps same-provider group/channel final replies private in message-tool-only mode", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        CommandSource: undefined,
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:C1",
        SessionKey: "test:discord:channel:C1",
      }),
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
      },
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).not.toHaveBeenCalled();
  });

  it("keeps ambient room-event group/channel finals private without a message tool send", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "ambient final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        InboundEventKind: "room_event",
        SessionKey: "test:discord:channel:C1",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers internal WebChat room-event final replies automatically", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible webchat reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        InboundEventKind: "room_event",
        Provider: "webchat",
        Surface: "webchat",
        SessionKey: "agent:forge:webchat:forge-main",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(result.sourceReplyDeliveryMode).toBeUndefined();
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible webchat reply");
  });

  it("preserves configured message-tool delivery for internal WebChat direct replies", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "private webchat final" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        Provider: "webchat",
        Surface: "webchat",
        SessionKey: "agent:forge:webchat:forge-main",
      }),
      cfg: { messages: { visibleReplies: "message_tool" } } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("keeps default direct source delivery automatic", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible direct reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible direct reply");
  });

  it("keeps Codex direct source delivery message-tool-only when config is unset", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { sourceVisibleReplies: "message_tool" },
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "codex",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "private final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("keeps locked supervised Codex delivery defaults across outer model overrides", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { sourceVisibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "catalog-adopted-session",
      updatedAt: 0,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginExtensions: {
        codex: {
          supervision: {
            sourceThreadId: "019f-codex-thread",
            modelLocked: true,
          },
        },
      },
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4.6",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "private supervised reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("uses Codex direct source delivery defaults before a session entry exists", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { sourceVisibleReplies: "message_tool" },
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = undefined;
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "private first reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("uses channel model overrides before Codex first-turn direct source delivery defaults", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { sourceVisibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = undefined;
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible channel-model reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              "*": "anthropic/claude-sonnet-4.6",
            },
          },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible channel-model reply");
  });

  it("uses channel model overrides before cached Codex runtime defaults", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { sourceVisibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "codex",
      modelProvider: "codex",
      model: "gpt-5.5",
      channel: "telegram",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible existing-channel-model reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              "*": "anthropic/claude-sonnet-4.6",
            },
          },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible existing-channel-model reply");
  });

  it("uses configured defaults before cached Codex runtime metadata", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { sourceVisibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "codex",
      modelProvider: "codex",
      model: "gpt-5.5",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible configured-default reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4.6" },
          },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible configured-default reply");
  });

  it("lets config restore automatic Codex direct source delivery", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { sourceVisibleReplies: "message_tool" },
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "codex",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        SessionKey: "agent:main:main",
      }),
      cfg: { messages: { visibleReplies: "automatic" } } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible final reply");
  });

  it("honors model overrides before cached Codex direct source delivery defaults", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { sourceVisibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4.6",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible switched-model reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible switched-model reply");
  });

  it("honors parent model overrides before Codex direct source delivery defaults", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { sourceVisibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    const parentSessionKey = "agent:main:telegram:direct:U1";
    const childSessionKey = `${parentSessionKey}:thread:topic-1`;
    sessionStoreMocks.currentEntry = {
      sessionId: "child",
      updatedAt: 0,
      agentHarnessId: "codex",
      parentSessionKey,
      sendPolicy: "allow",
    };
    const parentEntry = {
      sessionId: "parent",
      updatedAt: 0,
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4.6",
    };
    // Scope the parent-key override to this test; the describe's beforeEach does
    // not reset loadSessionStoreEntry, so leaving it in place would resolve a
    // stale "parent" sessionId for a sibling reusing this session key.
    const defaultLoadSessionStoreEntry = () => sessionStoreMocks.currentEntry;
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(((params: unknown) =>
      (params as { sessionKey?: string }).sessionKey === parentSessionKey
        ? parentEntry
        : sessionStoreMocks.currentEntry) as () => Record<string, unknown> | undefined);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible parent-model reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        ModelParentSessionKey: parentSessionKey,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: childSessionKey,
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(sessionStoreMocks.loadSessionStore).not.toHaveBeenCalled();
    expect(sessionStoreMocks.loadSessionStoreEntry).toHaveBeenCalledWith({
      agentId: "main",
      storePath: "/tmp/mock-sessions.json",
      sessionKey: parentSessionKey,
      readConsistency: "latest",
      clone: false,
    });
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible parent-model reply");
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(defaultLoadSessionStoreEntry);
  });

  it("honors heartbeat model overrides before Codex direct source delivery defaults", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { sourceVisibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "codex",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible heartbeat-model reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: {
        isHeartbeat: true,
        heartbeatModelOverride: "anthropic/claude-sonnet-4.6",
      },
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible heartbeat-model reply");
  });

  it("preserves non-Codex harness direct source delivery defaults", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "custom",
      label: "Custom",
      deliveryDefaults: { sourceVisibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "custom"
          ? { supported: true, priority: 200 }
          : { supported: false, reason: "custom provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "custom",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "private final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        Provider: "custom",
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("falls back to automatic group/channel delivery when the message tool is unavailable", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible fallback" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        SessionKey: "test:discord:channel:C1",
      }),
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        tools: { allow: ["read"] },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible fallback");
  });

  it("falls back to automatic group/channel delivery when group tools remove the message tool", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "group policy fallback" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        From: "discord:channel:C1",
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:main:discord:channel:C1",
      }),
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        channels: {
          discord: {
            groups: {
              C1: { tools: { allow: ["read"] } },
            },
          },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("group policy fallback");
  });

  it("falls back when a channel precomputed message-tool-only delivery but the message tool is unavailable", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "requested fallback" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        SessionKey: "test:discord:channel:C1",
      }),
      cfg: { tools: { allow: ["read"] } } as OpenClawConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("requested fallback");
  });

  it("keeps native command replies visible in group/channel events", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      expect(opts?.suppressTyping).toBe(false);
      return { text: "status reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "group",
        CommandSource: "native",
        CommandAuthorized: true,
        WasMentioned: true,
        SessionKey: "test:telegram:group:G1",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("status reply");
  });

  it("keeps default group/channel source delivery automatic", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "group",
        WasMentioned: true,
        SessionKey: "test:telegram:group:G1",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("final reply");
  });
});
