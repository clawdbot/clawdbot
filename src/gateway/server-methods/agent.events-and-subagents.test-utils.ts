// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { registerExecApprovalFollowupRuntimeHandoff } from "../../agents/bash-tools.exec-approval-followup-state.js";
import {
  onDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import {
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import { findTaskByRunId } from "../../tasks/task-registry.js";
import { setDetachedTaskLifecycleRuntime } from "../../tasks/task-runtime.test-helpers.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  getAgentTestMocks,
  makeContext,
  type AgentHandlerArgs,
  type AgentParams,
  waitForAssertion,
  requireValue,
  expectRecordFields,
  expectStringFieldContains,
  mockCallArg,
  expectRespondError,
  flushScheduledDispatchStep,
  mockMainSessionEntry,
  buildExistingMainStoreEntry,
  setupNewYorkTimeConfig,
  resetTimeConfig,
  primeMainAgentRun,
  backendGatewayClient,
  cronContinuationGatewayClient,
  cronMediaCompletionEvent,
  setupCronContinuationReleaseFixture,
  invokeGatewaySuspendPrepare,
  operatorWriteCliClient,
  waitForAgentCommandCall,
  invokeAgent,
  describe0AfterEach0,
} from "./agent.test-harness.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = getAgentTestMocks();

describe("gateway agent handler", () => {
  afterEach(describe0AfterEach0);

  it("stops continuation release recovery after gateway generation rotation", async () => {
    vi.useFakeTimers();
    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();
    try {
      const { sessionKey, store } = setupCronContinuationReleaseFixture();
      const context = makeContext();
      let releaseAttempts = 0;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        if (
          expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation
            ?.phase === "continuing"
        ) {
          releaseAttempts += 1;
          throw new Error("disk unavailable");
        }
        return await updater(store);
      });
      mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "continued" }], meta: {} });

      await invokeAgent(
        {
          message: "media completion",
          sessionKey,
          internalEvents: [cronMediaCompletionEvent()],
          idempotencyKey: "cron-media-release-rotates",
        },
        {
          reqId: "cron-media-release-rotates",
          client: cronContinuationGatewayClient(),
          context,
          flushDispatch: false,
        },
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(releaseAttempts).toBe(3);
      const busyPrepare = await invokeGatewaySuspendPrepare(context, "cron-media-release-rotating");
      expect(busyPrepare).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          status: "busy",
          blockers: expect.arrayContaining([expect.objectContaining({ kind: "root-request" })]),
        }),
      );

      mocks.lifecycleGeneration = "post-restart-generation";
      await vi.advanceTimersByTimeAsync(250);

      expect(releaseAttempts).toBe(3);
      expect(
        expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
      ).toMatchObject({
        phase: "continuing",
        ownerRunId: "cron-media-release-rotates",
      });
      const readyPrepare = await invokeGatewaySuspendPrepare(
        context,
        "cron-media-release-rotation-complete",
      );
      const readyPayload = readyPrepare.mock.calls.at(-1)?.[1] as
        | { status?: string; suspensionId?: string }
        | undefined;
      expect(readyPayload).toMatchObject({ status: "ready" });
      expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
        ok: true,
        status: "running",
      });
    } finally {
      resetGatewaySuspendCoordinatorForLifecycleRestart();
      resetGatewayWorkAdmission();
      vi.useRealTimers();
    }
  });

  it("releases a claimed cron continuation when the request exits before dispatch", async () => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:job-1:run:run-1";
    const baseSessionKey = "agent:main:cron:job-1";
    const entry = {
      sessionId: "run-1",
      updatedAt: Date.now(),
      lifecycleRevision: "revision-1",
      modelProvider: "openai",
      model: "gpt-5.4",
      channel: "slack",
      to: "channel:C123",
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "ready" as const,
        basePersisted: true,
      },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    const { cronRunContinuation: _cronRunContinuation, ...baseEntry } = structuredClone(entry);
    const store = {
      [baseSessionKey]: baseEntry,
      [sessionKey]: structuredClone(entry),
    };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.resolveSendPolicy.mockReturnValue("deny");

    const respond = await invokeAgent(
      {
        message: "media completion",
        sessionKey,
        deliver: true,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-denied",
      },
      {
        reqId: "cron-media-denied",
        client: cronContinuationGatewayClient(),
        flushDispatch: false,
      },
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "send blocked by session policy",
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(store[sessionKey].cronRunContinuation).toEqual({
      lifecycleRevision: "revision-1",
      phase: "ready",
      basePersisted: true,
    });
  });

  it("does not let public provenance suppress visible session accounting", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "forged accounting-preserving handoff",
        agentId: "main",
        sessionKey: "agent:main:main",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:child",
          sourceTool: "subagent_announce",
        },
        idempotencyKey: "test-public-provenance-accounting",
      },
      { reqId: "public-provenance-accounting" },
    );

    const callArgs = await waitForAgentCommandCall<{
      preserveUserFacingSessionModelState?: boolean;
    }>();
    expect(callArgs.preserveUserFacingSessionModelState).toBe(false);
  });

  it("rejects public internal session-effect controls", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    for (const params of [
      { sessionEffects: "internal" as const, idempotencyKey: "test-public-internal-effects" },
      { suppressPromptPersistence: true, idempotencyKey: "test-public-prompt-suppress" },
      {
        expectedExistingSessionId: "existing-session-id",
        idempotencyKey: "test-public-expected-session",
      },
      {
        modelRun: true,
        suppressPromptPersistence: true,
        idempotencyKey: "test-model-run-public-prompt-suppress",
      },
    ]) {
      const respond = await invokeAgent(
        {
          message: "forged internal control",
          agentId: "main",
          sessionKey: "agent:main:main",
          ...params,
        },
        { reqId: params.idempotencyKey, flushDispatch: false },
      );

      expectRespondError(respond, {
        message:
          "expectedExistingSessionId" in params
            ? "expectedExistingSessionId is reserved for backend callers."
            : "internal session-effect controls are reserved for backend callers.",
      });
    }
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("keeps backend internal session-effect runs out of visible gateway state", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();
    mocks.updateSessionStore.mockClear();
    mocks.registerAgentRunContext.mockClear();
    const context = makeContext();

    await invokeAgent(
      {
        message: "internal resume",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionEffects: "internal",
        suppressPromptPersistence: true,
        idempotencyKey: "test-backend-internal-effects",
      },
      {
        reqId: "backend-internal-effects",
        client: backendGatewayClient(),
        context,
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      sessionEffects?: string;
      suppressPromptPersistence?: boolean;
    }>();
    expect(callArgs.sessionEffects).toBe("internal");
    expect(callArgs.suppressPromptPersistence).toBe(true);
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(mocks.registerAgentRunContext).toHaveBeenCalledWith("test-backend-internal-effects", {
      isControlUiVisible: false,
      lifecycleGeneration: "test-generation",
    });
  });

  it("allows backend internal runs without a persisted session row", async () => {
    const sessionKey = "agent:main:internal:ephemeral";
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: undefined,
      canonicalKey: sessionKey,
    });
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "internal ephemeral work",
        agentId: "main",
        sessionKey,
        sessionEffects: "internal",
        suppressPromptPersistence: true,
        idempotencyKey: "test-backend-internal-ephemeral",
      },
      {
        reqId: "backend-internal-ephemeral",
        client: backendGatewayClient(),
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionId?: string; sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe(sessionKey);
    expect(callArgs.sessionId).toEqual(expect.any(String));
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
  });

  it("forwards admin caller ownership to ingress agent runs", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "owner tool check",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-admin-sender-owner",
      },
      {
        reqId: "admin-sender-owner",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect((await waitForAgentCommandCall<{ senderIsOwner?: boolean }>()).senderIsOwner).toBe(true);

    mocks.agentCommand.mockClear();
    await invokeAgent(
      {
        message: "non-owner tool check",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-write-sender-owner",
      },
      {
        reqId: "write-sender-owner",
        client: backendGatewayClient(),
      },
    );

    expect((await waitForAgentCommandCall<{ senderIsOwner?: boolean }>()).senderIsOwner).toBe(
      false,
    );
  });

  it("enables Gateway-bound plugin runtimes for ingress agent runs", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "plugin runtime check",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-gateway-plugin-runtime-binding",
      },
      {
        reqId: "gateway-plugin-runtime-binding",
        client: backendGatewayClient(),
      },
    );

    expect(
      (await waitForAgentCommandCall<{ allowGatewaySubagentBinding?: boolean }>())
        .allowGatewaySubagentBinding,
    ).toBe(true);
  });

  it("rejects public transcriptMessage overrides", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "runtime-only announce bookkeeping",
        transcriptMessage: "",
        agentId: "main",
        sessionKey: "agent:main:main",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
        idempotencyKey: "test-transcript-message",
      } as AgentParams,
      { reqId: "transcript-message", flushDispatch: false },
    );

    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "invalid agent params");
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("logs attachment parse failures with stack details", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-agent-attachment-parse-stack",
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "broken.png",
            content: "not-base64",
          },
        ],
      },
      { respond, context, reqId: "agent-attachment-parse-stack", flushDispatch: false },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "attachment broken.png: invalid base64 content");
    const logError = context.logGateway.error as unknown as ReturnType<typeof vi.fn>;
    expect(mockCallArg(logError)).toBe("agent attachment parse failed");
    const logMeta = mockCallArg(logError, 0, 1) as Record<string, unknown>;
    expectStringFieldContains(
      logMeta,
      "consoleMessage",
      "agent attachment parse failed: Error: attachment broken.png",
    );
    expectStringFieldContains(
      logMeta,
      "error",
      "Error: attachment broken.png: invalid base64 content",
    );
    expectStringFieldContains(logMeta, "error", "\n    at ");
  });

  it("keeps model-run gateway prompts undecorated and forwards raw-run flags", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });

    await invokeAgent(
      {
        message: "Reply exactly: pong",
        agentId: "main",
        provider: "ollama",
        model: "llama3.2:latest",
        modelRun: true,
        promptMode: "none",
        sessionKey: "agent:main:main",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
        idempotencyKey: "test-model-run-raw",
      },
      {
        reqId: "model-run-raw",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      message?: string;
      modelRun?: boolean;
      promptMode?: string;
    }>();
    expectRecordFields(callArgs, {
      message: "Reply exactly: pong",
      modelRun: true,
      promptMode: "none",
    });
    expect(callArgs.message).not.toContain("[Inter-session message]");

    resetTimeConfig();
  });

  it("rejects promptMode none without the stateless model-run contract", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "unsafe raw run",
        agentId: "main",
        sessionKey: "agent:main:main",
        promptMode: "none",
        idempotencyKey: "test-raw-run-with-visible-session-effects",
      },
      { reqId: "raw-run-with-visible-session-effects", flushDispatch: false },
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message:
        'promptMode="none" requires modelRun=true so the run cannot mutate a durable session.',
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("keeps CLI model runs out of durable and visible gateway state", async () => {
    const sessionId = "model-run-123e4567-e89b-12d3-a456-426614174000";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: undefined,
      canonicalKey: sessionKey,
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "pong" }],
      meta: { durationMs: 100 },
    });
    mocks.updateSessionStore.mockClear();
    mocks.registerAgentRunContext.mockClear();
    mocks.getLatestSubagentRunByChildSessionKey.mockClear();
    mocks.replaceSubagentRunAfterSteer.mockClear();

    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    const createRunningTaskRunSpy = vi.fn(
      (...args: Parameters<typeof defaultRuntime.createRunningTaskRun>) =>
        defaultRuntime.createRunningTaskRun(...args),
    );
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      createRunningTaskRun: createRunningTaskRunSpy,
    });

    const context = makeContext();
    context.getSessionEventSubscriberConnIds = () => new Set(["conn-1"]);
    await invokeAgent(
      {
        message: "Reply exactly: pong",
        agentId: "main",
        sessionId,
        sessionKey,
        modelRun: true,
        promptMode: "none",
        idempotencyKey: "test-stateless-model-run",
      },
      {
        reqId: "stateless-model-run",
        client: operatorWriteCliClient(),
        context,
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      modelRun?: boolean;
      promptMode?: string;
      sessionEffects?: string;
    }>();
    expectRecordFields(callArgs, {
      modelRun: true,
      promptMode: "none",
      sessionEffects: "internal",
    });
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(createRunningTaskRunSpy).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    expect(mocks.getLatestSubagentRunByChildSessionKey).not.toHaveBeenCalled();
    expect(mocks.replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
    expect(mocks.registerAgentRunContext).toHaveBeenCalledWith("test-stateless-model-run", {
      isControlUiVisible: false,
      lifecycleGeneration: "test-generation",
    });
  });

  it("respects explicit bestEffortDeliver=false for main session runs", async () => {
    mocks.agentCommand.mockClear();
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "strict delivery",
        agentId: "main",
        sessionKey: "agent:main:main",
        deliver: true,
        replyChannel: "telegram",
        to: "123",
        bestEffortDeliver: false,
        idempotencyKey: "test-strict-delivery",
      },
      { reqId: "strict-1" },
    );

    const callArgs = await waitForAgentCommandCall();
    expect(callArgs.bestEffortDeliver).toBe(false);
  });

  it("rejects strict delivery with a missing target before dispatching the agent", async () => {
    mocks.agentCommand.mockClear();
    primeMainAgentRun();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "strict missing delivery target",
        agentId: "main",
        sessionKey: "agent:main:main",
        deliver: true,
        replyChannel: "telegram",
        bestEffortDeliver: false,
        idempotencyKey: "test-strict-delivery-missing-target",
      },
      {
        reqId: "strict-delivery-missing-target",
        respond,
        flushDispatch: false,
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "requires target");
  });

  it("downgrades to session-only when bestEffortDeliver=true and no external channel is configured", async () => {
    mocks.agentCommand.mockClear();
    primeMainAgentRun();
    const respond = vi.fn();
    const logInfo = vi.fn();

    await invokeAgent(
      {
        message: "best effort delivery fallback",
        agentId: "main",
        sessionKey: "agent:main:main",
        deliver: true,
        bestEffortDeliver: true,
        idempotencyKey: "test-best-effort-delivery-fallback",
      },
      {
        reqId: "best-effort-delivery-fallback",
        respond,
        context: {
          dedupe: new Map(),
          addChatRun: vi.fn(),
          chatAbortControllers: new Map(),
          logGateway: { info: logInfo, error: vi.fn() },
          broadcastToConnIds: vi.fn(),
          getSessionEventSubscriberConnIds: () => new Set(),
          getRuntimeConfig: () => mocks.loadConfigReturn,
        } as unknown as GatewayRequestContext,
      },
    );

    await waitForAgentCommandCall();
    const accepted = respond.mock.calls.find(
      (call: unknown[]) =>
        call[0] === true && (call[1] as Record<string, unknown>)?.status === "accepted",
    );
    expectRecordFields(requireValue(accepted, "accepted response missing")[1], {
      status: "accepted",
    });
    const rejected = respond.mock.calls.find((call: unknown[]) => call[0] === false);
    expect(rejected).toBeUndefined();
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(mockCallArg(logInfo)).toContain(
      "agent delivery downgraded to session-only (bestEffortDeliver)",
    );
  });

  it("rejects public spawned-run metadata fields", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "spawned run",
        sessionKey: "agent:main:main",
        spawnedBy: "agent:main:subagent:parent",
        workspaceDir: "/tmp/injected",
        idempotencyKey: "workspace-rejected",
      } as AgentParams,
      { reqId: "workspace-rejected-1", respond },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "invalid agent params");
  });

  it("forwards one-shot bundle MCP cleanup from agent RPC into the runner", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();

    await invokeAgent({
      message: "cleanup probe",
      sessionKey: "agent:main:subagent:cleanup-probe",
      idempotencyKey: "test-idem-agent-cleanup-bundle-mcp",
      cleanupBundleMcpOnRunEnd: true,
    });

    const call = await waitForAgentCommandCall();
    expect(call.cleanupBundleMcpOnRunEnd).toBe(true);
  });

  it.each(
    (["channel", "replyChannel"] as const).flatMap((field) =>
      (["heartbeat", "cron", "webhook", "voice"] as const).map(
        (channel) => [field, channel] as const,
      ),
    ),
  )("accepts internal non-delivery %s hint %s", async (field, channel) => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "spawn from internal source",
        agentId: "main",
        sessionKey: "agent:main:main",
        [field]: channel,
        idempotencyKey: `internal-channel-${field}-${channel}`,
      } as AgentParams,
      { reqId: `internal-channel-${field}-${channel}-1`, respond },
    );

    const rejection = respond.mock.calls.find(
      (call: unknown[]) =>
        call[0] === false &&
        typeof (call[2] as { message?: string } | undefined)?.message === "string" &&
        (call[2] as { message: string }).message.includes("unknown channel"),
    );
    expect(rejection).toBeUndefined();
  });

  it.each(["channel", "replyChannel"] as const)("rejects unknown %s hints", async (field) => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "bogus channel",
        agentId: "main",
        sessionKey: "agent:main:main",
        [field]: "not-a-real-channel",
        idempotencyKey: `unknown-${field}`,
      } as AgentParams,
      { reqId: `unknown-${field}-1`, respond },
    );

    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "unknown channel: not-a-real-channel");
  });

  it("keeps voice-originated followups on the voice message channel without delivery", async () => {
    mockMainSessionEntry({ sessionId: "voice-session-id" });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "exec approval followup",
        sessionKey: "agent:main:main",
        channel: "voice",
        deliver: false,
        idempotencyKey: "exec-approval-followup:req-voice",
      } as AgentParams,
      { reqId: "exec-approval-followup-voice-1", client: backendGatewayClient() },
    );

    const callArgs = await waitForAgentCommandCall<{
      channel?: string;
      deliver?: boolean;
      messageChannel?: string;
      runContext?: { messageChannel?: string };
    }>();
    expect(callArgs.channel).toBe("voice");
    expect(callArgs.deliver).toBe(false);
    expect(callArgs.messageChannel).toBe("voice");
    expect(callArgs.runContext?.messageChannel).toBe("voice");
  });

  it("accepts music generation internal events", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "music generation finished",
        sessionKey: "agent:main:main",
        internalEvents: [
          {
            type: "task_completion",
            source: "music_generation",
            childSessionKey: "music:task-123",
            childSessionId: "task-123",
            announceType: "music generation task",
            taskLabel: "compose a loop",
            status: "ok",
            statusLabel: "completed successfully",
            result: "MEDIA: https://example.test/song.mp3",
            replyInstruction: "Reply in your normal assistant voice now.",
          },
        ],
        idempotencyKey: "music-generation-event",
      },
      { reqId: "music-generation-event-1", respond },
    );

    await waitForAgentCommandCall();
    const rejection = respond.mock.calls.find((call: unknown[]) => call[0] === false);
    expect(rejection).toBeUndefined();
  });

  it("does not create task rows for inter-session completion wakes", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: [
          "[Mon 2026-04-06 02:42 GMT+1] <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "OpenClaw runtime context (internal):",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
        ].join("\n"),
        sessionKey: "agent:main:main",
        internalEvents: [
          {
            type: "task_completion",
            source: "music_generation",
            childSessionKey: "music:task-123",
            childSessionId: "task-123",
            announceType: "music generation task",
            taskLabel: "compose a loop",
            status: "ok",
            statusLabel: "completed successfully",
            result: "MEDIA:/tmp/song.mp3",
            replyInstruction: "Reply in your normal assistant voice now.",
          },
        ],
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "music_generate:task-123",
          sourceChannel: "internal",
          sourceTool: "music_generate",
        },
        idempotencyKey: "music-generation-event-inter-session",
      },
      { reqId: "music-generation-event-inter-session" },
    );

    await waitForAgentCommandCall();
    expect(findTaskByRunId("music-generation-event-inter-session")).toBeUndefined();
  });

  it("only forwards workspaceDir for spawned sessions with stored workspace inheritance", async () => {
    primeMainAgentRun();
    mockMainSessionEntry({
      spawnedBy: "agent:main:subagent:parent",
      spawnedWorkspaceDir: "/tmp/inherited",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          spawnedBy: "agent:main:subagent:parent",
          spawnedWorkspaceDir: "/tmp/inherited",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "spawned run",
        sessionKey: "agent:main:main",
        idempotencyKey: "workspace-forwarded",
      },
      { reqId: "workspace-forwarded-1" },
    );
    const spawnedCall = await waitForAgentCommandCall<{ workspaceDir?: string }>();
    expect(spawnedCall.workspaceDir).toBe("/tmp/inherited");
  });

  it("forwards spawnedCwd as runtime cwd for spawned sessions", async () => {
    primeMainAgentRun();
    mockMainSessionEntry({
      spawnedBy: "agent:main:subagent:parent",
      spawnedWorkspaceDir: "/tmp/inherited",
      spawnedCwd: "/tmp/task-repo",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          spawnedBy: "agent:main:subagent:parent",
          spawnedWorkspaceDir: "/tmp/inherited",
          spawnedCwd: "/tmp/task-repo",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "spawned run",
        sessionKey: "agent:main:main",
        idempotencyKey: "cwd-forwarded",
      },
      { reqId: "cwd-forwarded-1" },
    );
    const spawnedCall = await waitForAgentCommandCall<{ cwd?: string; workspaceDir?: string }>();
    expect(spawnedCall.workspaceDir).toBe("/tmp/inherited");
    expect(spawnedCall.cwd).toBe("/tmp/task-repo");
  });

  it("uses a managed dashboard worktree as both workspace and runtime cwd", async () => {
    primeMainAgentRun();
    mockMainSessionEntry({ spawnedCwd: "/tmp/session-worktree" });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          spawnedCwd: "/tmp/session-worktree",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "worktree run",
        sessionKey: "agent:main:main",
        idempotencyKey: "worktree-workspace-forwarded",
      },
      { reqId: "worktree-workspace-forwarded-1" },
    );
    const worktreeCall = await waitForAgentCommandCall<{
      cwd?: string;
      workspaceDir?: string;
    }>();
    expect(worktreeCall.workspaceDir).toBe("/tmp/session-worktree");
    expect(worktreeCall.cwd).toBe("/tmp/session-worktree");
  });

  it("keeps origin messageChannel as webchat while delivery channel uses last session channel", async () => {
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "12345" },
      }),
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: "12345" },
          }),
        }),
      };
      return await updater(store);
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "webchat turn",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-webchat-origin-channel",
      },
      {
        reqId: "webchat-origin-1",
        client: {
          connect: {
            client: { id: "webchat-ui", mode: "webchat" },
          },
        } as AgentHandlerArgs["client"],
        isWebchatConnect: () => true,
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      channel?: string;
      messageChannel?: string;
      runContext?: { messageChannel?: string };
    }>();
    expect(callArgs.channel).toBe("telegram");
    expect(callArgs.messageChannel).toBe("webchat");
    expect(callArgs.runContext?.messageChannel).toBe("webchat");
  });

  it("forwards elevated defaults only for valid exec approval runtime handoffs", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const registration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-75832",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!registration) {
      throw new Error("expected runtime handoff id");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: registration.idempotencyKey,
        internalRuntimeHandoffId: registration.handoffId,
      },
      { reqId: "exec-followup-elevated", client: backendGatewayClient() },
    );

    const callArgs = await waitForAgentCommandCall<{ bashElevated?: unknown }>();
    expect(callArgs.bashElevated).toEqual(bashElevated);
  });

  it("dedupes elevated exec approval followups across nonce idempotency keys", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const firstRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-duplicate",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    const secondRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-duplicate",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!firstRegistration || !secondRegistration) {
      throw new Error("expected runtime handoff ids");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    mocks.agentCommand.mockImplementation(() => new Promise(() => {}));
    const context = makeContext();
    const agentCommandCallsBefore = mocks.agentCommand.mock.calls.length;

    await invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: firstRegistration.idempotencyKey,
        internalRuntimeHandoffId: firstRegistration.handoffId,
      },
      { reqId: "exec-followup-duplicate-1", client: backendGatewayClient(), context },
    );
    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore + 1);

    const secondRespond = await invokeAgent(
      {
        message: "exec followup duplicate",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: secondRegistration.idempotencyKey,
        internalRuntimeHandoffId: secondRegistration.handoffId,
      },
      {
        reqId: "exec-followup-duplicate-2",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );
    await flushScheduledDispatchStep();
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore + 1);
    expect(mockCallArg(secondRespond, 0, 3)).toEqual({
      cached: true,
      runId: firstRegistration.idempotencyKey,
    });
  });

  it("reserves exec approval followup dedupe before awaited session work", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const firstRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-overlap",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    const secondRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-overlap",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!firstRegistration || !secondRegistration) {
      throw new Error("expected runtime handoff ids");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    let releaseFirstSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry({
          lastChannel: "telegram",
          lastTo: "123",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockImplementation(() => new Promise(() => {}));
    const context = makeContext();
    const agentCommandCallsBefore = mocks.agentCommand.mock.calls.length;

    const first = invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: firstRegistration.idempotencyKey,
        internalRuntimeHandoffId: firstRegistration.handoffId,
      },
      {
        reqId: "exec-followup-overlap-1",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));

    const secondRespond = await invokeAgent(
      {
        message: "exec followup duplicate",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: secondRegistration.idempotencyKey,
        internalRuntimeHandoffId: secondRegistration.handoffId,
      },
      {
        reqId: "exec-followup-overlap-2",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );

    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore);
    expect(sessionWriteCalls).toBe(1);
    expect(mockCallArg(secondRespond, 0, 1)).toMatchObject({
      runId: firstRegistration.idempotencyKey,
      status: "in_flight",
    });
    expect(mockCallArg(secondRespond, 0, 3)).toEqual({
      cached: true,
      runId: firstRegistration.idempotencyKey,
    });

    releaseFirstSessionWrite?.();
    await first;
    await flushScheduledDispatchStep();
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore + 1);
  });

  it("clears reserved exec approval dedupe when pre-run session work fails", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const firstRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-pre-run-fail",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    const secondRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-pre-run-fail",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!firstRegistration || !secondRegistration) {
      throw new Error("expected runtime handoff ids");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    const context = makeContext();
    const agentCommandCallsBefore = mocks.agentCommand.mock.calls.length;
    mocks.updateSessionStore.mockRejectedValueOnce(new Error("session write failed"));

    await expect(
      invokeAgent(
        {
          message: "exec followup",
          sessionKey: "agent:main:telegram:direct:123",
          channel: "telegram",
          idempotencyKey: firstRegistration.idempotencyKey,
          internalRuntimeHandoffId: firstRegistration.handoffId,
        },
        {
          reqId: "exec-followup-pre-run-fail-1",
          client: backendGatewayClient(),
          context,
          flushDispatch: false,
        },
      ),
    ).rejects.toThrow("session write failed");

    expect(context.dedupe.get(`agent:${firstRegistration.idempotencyKey}`)).toBeUndefined();
    expect(
      context.dedupe.get("agent:exec-approval-followup:req-elevated-pre-run-fail"),
    ).toBeUndefined();
    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore);

    const secondRespond = await invokeAgent(
      {
        message: "exec followup retry",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: secondRegistration.idempotencyKey,
        internalRuntimeHandoffId: secondRegistration.handoffId,
      },
      {
        reqId: "exec-followup-pre-run-fail-2",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );

    expect(mockCallArg(secondRespond, 0, 1)).toMatchObject({
      runId: secondRegistration.idempotencyKey,
      status: "accepted",
    });
    await flushScheduledDispatchStep();
    await flushScheduledDispatchStep();
    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore + 1);
  });

  it("does not consume exec approval runtime handoffs from non-backend callers", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const registration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-75832",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!registration) {
      throw new Error("expected runtime handoff id");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    const agentCommandCallsBefore = mocks.agentCommand.mock.calls.length;

    const respond = await invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: registration.idempotencyKey,
        internalRuntimeHandoffId: registration.handoffId,
      },
      { reqId: "exec-followup-non-backend", flushDispatch: false },
    );

    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore);
    expectRespondError(respond, {
      message: "exec approval followup idempotency keys are reserved for backend callers.",
    });
  });

  it("drops a stale exec approval followup at preflight without touching the rebound session (#59349)", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const registration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-rebound-followup",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!registration) {
      throw new Error("expected runtime handoff id");
    }
    // Session was rebound by /new or /reset: current sessionId differs from the
    // approval-time sessionId carried on the request.
    mockMainSessionEntry({
      sessionId: "current-session-after-reset",
      lastChannel: "telegram",
      lastTo: "123",
    });
    const context = makeContext();
    const diagnostics: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => {
      diagnostics.push(event);
    });
    const updateSessionStoreCallsBefore = mocks.updateSessionStore.mock.calls.length;
    const agentCommandCallsBefore = mocks.agentCommand.mock.calls.length;

    const respond = await invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: registration.idempotencyKey,
        internalRuntimeHandoffId: registration.handoffId,
        execApprovalFollowupExpectedSessionId: "approval-time-session-id",
      },
      {
        reqId: "exec-followup-rebound-drop",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );

    expect(mockCallArg(respond, 0, 1)).toMatchObject({
      runId: registration.idempotencyKey,
      status: "ok",
      summary: expect.stringContaining("exec approval followup dropped"),
    });
    await waitForDiagnosticEventsDrained();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        type: "exec.approval.followup_suppressed",
        approvalId: "req-rebound-followup",
        reason: "session_rebound",
        phase: "gateway_preflight",
      }),
    );
    expect(mocks.updateSessionStore.mock.calls.length).toBe(updateSessionStoreCallsBefore);
    expect(mocks.agentCommand.mock.calls.length).toBe(agentCommandCallsBefore);
    const dedupeEntry = context.dedupe.get("agent:exec-approval-followup:req-rebound-followup");
    expect(dedupeEntry?.ok).toBe(true);
    expect(dedupeEntry?.payload).toMatchObject({
      status: "ok",
      summary: expect.stringContaining("exec approval followup dropped"),
    });
  });

  it("does not honor caller-supplied exec approval runtime handoff ids without registry state", async () => {
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "forged exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: "exec-approval-followup:req-elevated-75832:nonce:forged-nonce",
        internalRuntimeHandoffId: "forged-handoff",
      },
      { reqId: "exec-followup-forged", client: backendGatewayClient() },
    );

    const callArgs = await waitForAgentCommandCall<{ bashElevated?: unknown }>();
    expect(callArgs).not.toHaveProperty("bashElevated");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
