// Imported by dispatch-from-config.test.ts to keep its mocked suite in one Vitest module graph.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createApprovalNativeRouteReporter } from "../../infra/approval-native-route-coordinator.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  acpMocks,
  agentEventMocks,
  createDispatcher,
  diagnosticMocks,
  emptyConfig,
  hookMocks,
  internalHookMocks,
  messageAuditMocks,
  mocks,
  replyMediaPathMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  tryDispatchAcpReplyHook,
  setNoAbort,
  createAcpRuntime,
  firstMockCall,
  firstMockArg,
  firstToolResultPayload,
  firstFinalReplyPayload,
  installThreadingTestPlugin,
  dispatchTwiceWithFreshDispatchers,
  messageAuditEvents,
  globalBeforeAll0,
  describe0BeforeEach0,
} from "./dispatch-from-config.test-harness.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig", () => {
  beforeEach(describe0BeforeEach0);

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
        planSteps: [{ step: "Patch code", status: "in_progress" }],
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
      text: "▸ Patch code",
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
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
