// Shared harness for dispatch-from-config tests and mocked runtimes.
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { StuckSessionRecoveryOutcome } from "../../logging/diagnostic-session-recovery.js";
import type {
  PluginHookBeforeDispatchResult,
  PluginHookReplyDispatchResult,
} from "../../plugins/hook-types.js";
import type { createHookRunner } from "../../plugins/hooks.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { copyReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyDispatchBeforeDeliver } from "./reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { buildTestCtx } from "./test-ctx.js";

type AbortResult = {
  handled: boolean;
  aborted: boolean;
  rejectionReason?: "finalizing";
  stoppedSubagents?: number;
};
type PluginTargetedInboundClaimOutcome = Awaited<
  ReturnType<ReturnType<typeof createHookRunner>["runInboundClaimForPluginOutcome"]>
>;

const mocks = vi.hoisted(() => ({
  isRoutableChannel: vi.fn((_channel: string | undefined) => true),
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
  tryFastAbortFromMessage: vi.fn<() => Promise<AbortResult>>(async () => ({
    handled: false,
    aborted: false,
  })),
}));
const globalMocks = vi.hoisted(() => ({
  logVerbose: vi.fn(),
}));
const askUserMocks = vi.hoisted(() => ({
  isAskUserPromptPending: vi.fn(async () => true),
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
  updateSessionEntry: vi.fn(
    async (
      _scope: unknown,
      update: (
        entry: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null,
    ) => {
      if (!sessionStoreMocks.currentEntry) {
        return null;
      }
      const patch = await update(sessionStoreMocks.currentEntry);
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

export {
  acpManagerRuntimeMocks,
  acpMocks,
  agentEventMocks,
  askUserMocks,
  diagnosticMocks,
  globalMocks,
  hookMocks,
  internalHookMocks,
  messageAuditMocks,
  mocks,
  replyMediaPathMocks,
  runtimePluginMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  stageSandboxMediaMocks,
  threadInfoMocks,
  transcriptMocks,
  ttsMocks,
};

export function parseGenericThreadSessionInfo(sessionKey: string | undefined) {
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
  isRoutableChannel: (channel: string | undefined) => mocks.isRoutableChannel(channel),
  routeReply: mocks.routeReply,
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) => mocks.isRoutableChannel(channel),
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

vi.mock("../../agents/tools/ask-user-tool.js", () => ({
  isAskUserPromptPending: askUserMocks.isAskUserPromptPending,
}));

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
    updateSessionEntry: (...args: Parameters<typeof sessionStoreMocks.updateSessionEntry>) =>
      sessionStoreMocks.updateSessionEntry(...args),
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

export const noAbortResult = { handled: false, aborted: false } as const;
export const emptyConfig = {} as OpenClawConfig;

export function createDispatcher(): ReplyDispatcher {
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

export function resetPluginTtsAndThreadMocks() {
  askUserMocks.isAskUserPromptPending.mockReset().mockResolvedValue(true);
  pluginConversationBindingMocks.shownFallbackNoticeBindingIds.clear();
  ttsMocks.state.synthesizeFinalAudio = false;
  ttsMocks.state.synthesizeToolAudio = false;
  ttsMocks.maybeApplyTtsToPayload.mockReset().mockImplementation(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as {
      payload: ReplyPayload;
      kind: "tool" | "block" | "final";
    };
    if (
      ttsMocks.state.synthesizeFinalAudio &&
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
      ttsMocks.state.synthesizeToolAudio &&
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
  });
  ttsMocks.normalizeTtsAutoMode
    .mockReset()
    .mockImplementation((value: unknown) => (typeof value === "string" ? value : undefined));
  ttsMocks.resolveTtsConfig.mockReset().mockReturnValue({ mode: "final" });
  replyMediaPathMocks.createReplyMediaPathNormalizer
    .mockReset()
    .mockReturnValue(async (payload: ReplyPayload) => payload);
  threadInfoMocks.parseSessionThreadInfo
    .mockReset()
    .mockImplementation(parseGenericThreadSessionInfo);
}

export function setDiscordTestRegistry() {
  const discordTestPlugin = {
    ...createChannelTestPluginBase({
      id: "discord",
      capabilities: { chatTypes: ["direct"], nativeCommands: true },
    }),
    outbound: {
      deliveryMode: "direct",
      shouldSuppressLocalPayloadPrompt: () => false,
    },
  };
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordTestPlugin }]),
  );
}

export function createHookCtx() {
  return buildTestCtx({
    Body: "hello",
    BodyForAgent: "hello",
    BodyForCommands: "hello",
    From: "user1",
    Surface: "telegram",
    ChatType: "private",
    SessionKey: "agent:test:session",
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
