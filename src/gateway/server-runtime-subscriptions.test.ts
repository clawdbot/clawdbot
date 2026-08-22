// Tests for gateway runtime subscription wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../test/helpers/channel-admission-evidence.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  configureExecutionIdentityAdmissionSink,
  enqueueExecutionIdentityContextAtAdmission,
  hasExecutionIdentityAdmissionSink,
} from "../audit/execution-identity-admission.js";
import { consumeChannelAdmissionEvidence } from "../channels/message-access/admission-evidence.js";
import type { CronServiceState } from "../cron/service/state.js";
import { tryFinishCronTaskRunWithoutHistory } from "../cron/service/task-runs.js";
import {
  emitAgentAuditEvent,
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  emitSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import {
  createTaskRecord,
  markTaskLostById,
  markTaskTerminalById,
  recordTaskProgressByRunId,
} from "../tasks/task-registry.js";
import { getTaskRegistryObservers } from "../tasks/task-registry.store.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { installInMemoryTaskRegistryRuntime } from "../test-utils/task-registry-runtime.js";
import {
  abortChatRunById,
  registerChatAbortController,
  type ChatAbortControllerEntry,
} from "./chat-abort.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { AgentEventHandlerOptions } from "./server-chat.js";
import type { TaskEventPayload } from "./server-methods/task-summary.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  makeFakePty,
  taskAgentOwner,
} from "./terminal/session-manager.test-helpers.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

const warn = vi.fn();
const mockLog: SubsystemLogger = {
  subsystem: "gateway-test",
  isEnabled: () => true,
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn,
  error: vi.fn(),
  fatal: vi.fn(),
  raw: vi.fn(),
  child: () => mockLog,
};

const auditTestState = vi.hoisted(() => ({
  enabled: true,
  messageMode: "off" as "off" | "direct" | "all",
  created: 0,
  recorded: 0,
  identityRecorded: 0,
  decisionRecorded: 0,
  executionIdentityEnabled: false,
  stopped: 0,
}));
const agentEventHandlerMocks = vi.hoisted(() => ({
  create: vi.fn(),
}));
const transcriptBroadcastMocks = vi.hoisted(() => ({
  useActualHandler: false,
  readMessageCount: vi.fn(),
}));
const runtimeConfigState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => runtimeConfigState.value,
}));

vi.mock("../audit/audit-config.js", () => ({
  isAuditLedgerEnabled: () => auditTestState.enabled,
  isExecutionIdentityCollectionEnabled: () => auditTestState.executionIdentityEnabled,
  resolveAuditMessageMode: () => auditTestState.messageMode,
}));

vi.mock("../audit/audit-recorder.js", () => ({
  createAuditEventRecorder: () => {
    auditTestState.created += 1;
    return {
      record: vi.fn(() => {
        auditTestState.recorded += 1;
      }),
      recordTool: vi.fn(),
      recordMessage: vi.fn(),
      recordExecutionIdentity: vi.fn(() => {
        auditTestState.identityRecorded += 1;
        return true;
      }),
      recordExecutionDecision: vi.fn(() => {
        auditTestState.decisionRecorded += 1;
        return true;
      }),
      stop: vi.fn(async () => {
        auditTestState.stopped += 1;
      }),
    };
  },
}));

vi.mock("./server-chat.js", () => ({
  createAgentEventHandler: (...args: unknown[]) => agentEventHandlerMocks.create(...args),
}));

vi.mock("./server-session-key.js", () => ({
  resolveSessionKeyForRun: () => "agent:main:main",
}));

vi.mock("./session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-transcript-readers.js")>();
  return {
    ...actual,
    readSessionMessageCountAsync: transcriptBroadcastMocks.readMessageCount,
  };
});

vi.mock("./server-session-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-session-events.js")>();
  return {
    ...actual,
    createTranscriptUpdateBroadcastHandler: (
      ...args: Parameters<typeof actual.createTranscriptUpdateBroadcastHandler>
    ) => {
      if (transcriptBroadcastMocks.useActualHandler) {
        return actual.createTranscriptUpdateBroadcastHandler(...args);
      }
      return () => {
        throw new Error("transcript handler failure");
      };
    },
    createLifecycleEventBroadcastHandler: () => () => {
      throw new Error("lifecycle handler failure");
    },
  };
});

const { startGatewayEventSubscriptions } = await import("./server-runtime-subscriptions.js");
type SubscriptionParams = Parameters<typeof startGatewayEventSubscriptions>[0];

type LifecycleOwnerCallbacks = Required<
  Pick<
    AgentEventHandlerOptions,
    | "clearTrackedActiveRun"
    | "markTrackedRunTerminalPersisted"
    | "trackTrackedRunTerminalPersistence"
  >
>;
type LifecycleTransition = { state: string; lifecycle?: ReturnType<typeof readLifecycleState> };

function readLifecycleState(entry: ChatAbortControllerEntry) {
  return {
    projectSessionActive: entry.projectSessionActive,
    projectSessionTerminalPending: entry.projectSessionTerminalPending,
    projectSessionTerminalObservedAt: entry.projectSessionTerminalObservedAt,
    projectSessionTerminalPersistence: entry.projectSessionTerminalPersistence,
    projectSessionTerminalPersisted: entry.projectSessionTerminalPersisted,
    registrationCleanupRequested: entry.registrationCleanupRequested,
  };
}

function lifecycleState(
  projectSessionActive: boolean | undefined,
  projectSessionTerminalPending?: boolean,
  projectSessionTerminalObservedAt?: number,
  projectSessionTerminalPersistence?: Promise<void>,
  projectSessionTerminalPersisted?: boolean,
  registrationCleanupRequested?: boolean,
): ReturnType<typeof readLifecycleState> {
  return {
    projectSessionActive,
    projectSessionTerminalPending,
    projectSessionTerminalObservedAt,
    projectSessionTerminalPersistence,
    projectSessionTerminalPersisted,
    registrationCleanupRequested,
  };
}

function requireLifecycleOwnerCallbacks(): LifecycleOwnerCallbacks {
  const options = agentEventHandlerMocks.create.mock.calls[0]?.[0] as
    | AgentEventHandlerOptions
    | undefined;
  if (
    !options?.clearTrackedActiveRun ||
    !options.markTrackedRunTerminalPersisted ||
    !options.trackTrackedRunTerminalPersistence
  ) {
    throw new Error("expected lifecycle owner callbacks");
  }
  return {
    clearTrackedActiveRun: options.clearTrackedActiveRun,
    markTrackedRunTerminalPersisted: options.markTrackedRunTerminalPersisted,
    trackTrackedRunTerminalPersistence: options.trackTrackedRunTerminalPersistence,
  };
}

function createParams(): SubscriptionParams {
  return {
    log: mockLog,
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map(),
    ...(() => {
      const chatRunState = createChatRunState();
      return { chatRunState, toolEventRecipients: chatRunState.toolEventRecipients };
    })(),
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    chatAbortControllers: new Map(),
    restartRecoveryCandidates: new Map(),
    terminalSessions: { closeTaskSessions: vi.fn() },
  };
}

describe("startGatewayEventSubscriptions", () => {
  let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    auditTestState.enabled = true;
    auditTestState.messageMode = "off";
    auditTestState.created = 0;
    auditTestState.recorded = 0;
    auditTestState.identityRecorded = 0;
    auditTestState.decisionRecorded = 0;
    auditTestState.executionIdentityEnabled = false;
    auditTestState.stopped = 0;
    transcriptBroadcastMocks.useActualHandler = false;
    transcriptBroadcastMocks.readMessageCount.mockReset();
    runtimeConfigState.value = {};
    agentEventHandlerMocks.create.mockReset().mockImplementation(() => {
      throw new Error("server-chat lazy load failure");
    });
    installInMemoryTaskRegistryRuntime();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await unsubs?.agentUnsub();
    unsubs?.heartbeatUnsub();
    unsubs?.transcriptUnsub();
    unsubs?.lifecycleUnsub();
    void unsubs?.taskUnsub();
    resetAgentEventsForTest();
    resetTaskRegistryForTests({ persist: false });
    configureExecutionIdentityAdmissionSink(() => false)();
  });

  it("records audit events by default and stops the recorder on unsubscribe", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    expect(auditTestState.created).toBe(1);
    emitAgentAuditEvent({
      runId: "enabled-audit",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    expect(auditTestState.recorded).toBe(1);
    expect(hasExecutionIdentityAdmissionSink()).toBe(true);
    expect(
      enqueueExecutionIdentityContextAtAdmission(
        {
          runId: "gateway-admission",
          agentId: "main",
          ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
          runtime: { kind: "embedded" },
        },
        { enabled: true, runtimeInstanceId: "runtime-1" },
      )?.accepted,
    ).toBe(true);
    expect(auditTestState.identityRecorded).toBe(1);
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(1);
    expect(hasExecutionIdentityAdmissionSink()).toBe(false);
  });

  it("owns channel evidence collection for the configured gateway lifecycle", async () => {
    auditTestState.executionIdentityEnabled = true;
    unsubs = startGatewayEventSubscriptions(createParams());

    const evidence = createChannelParticipantAdmissionEvidence({
      channelId: "test",
      participantId: "person-1",
    });
    expect(evidence).toBeDefined();

    await unsubs.agentUnsub();
    expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({ ingressState: "unknown" });
    expect(
      createChannelParticipantAdmissionEvidence({
        channelId: "test",
        participantId: "person-2",
      }),
    ).toBeUndefined();
  });

  it("keeps retention maintenance but creates no producers when audit.enabled is false", async () => {
    auditTestState.enabled = false;
    unsubs = startGatewayEventSubscriptions(createParams());

    expect(auditTestState.created).toBe(1);
    emitAgentAuditEvent({
      runId: "disabled-private",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    emitAgentEvent({
      runId: "disabled-public",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    expect(auditTestState.recorded).toBe(0);
    await waitForFast(() => expect(warn).toHaveBeenCalledOnce());
    warn.mockClear();
    // Disabled wiring must still unsubscribe cleanly.
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(1);
  });

  it("logs lazy agent event handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });

    await waitForFast(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Agent event dispatch failed",
      expect.objectContaining({ runId: "run-1", stream: "lifecycle" }),
    );
  });

  it("disposes a loaded agent event handler on unsubscribe", async () => {
    const dispose = vi.fn();
    const handler = Object.assign(vi.fn(), { dispose });
    agentEventHandlerMocks.create.mockReturnValue(handler);
    unsubs = startGatewayEventSubscriptions(createParams());

    emitAgentEvent({ runId: "run-dispose", stream: "lifecycle", data: { phase: "error" } });
    await waitForFast(() => expect(handler).toHaveBeenCalledOnce());

    await unsubs.agentUnsub();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("uses the persisted bare-key owner for ownerless active-run projections", async () => {
    runtimeConfigState.value = {
      session: { scope: "global", store: "/tmp/openclaw-owned-sessions.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };
    const handler = Object.assign(vi.fn(), { dispose: vi.fn() });
    agentEventHandlerMocks.create.mockReturnValue(handler);
    const params = createParams();
    params.chatAbortControllers.set("run-ops", {
      sessionKey: "global",
      sessionId: "session-ops",
    } as never);
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentEvent({ runId: "load-handler", stream: "lifecycle", data: { phase: "error" } });
    await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());
    const options = agentEventHandlerMocks.create.mock.calls[0]?.[0] as {
      resolveSessionActiveRunState?: (session: {
        requestedKey: string;
        canonicalKey: string;
        sessionId?: string;
        agentId?: string;
      }) => { active: boolean; runIds: string[] };
    };

    expect(
      options.resolveSessionActiveRunState?.({
        requestedKey: "global",
        canonicalKey: "global",
        sessionId: "session-ops",
        agentId: "ops",
      }),
    ).toEqual({ active: true, runIds: ["run-ops"] });
  });

  it("drives a registered chat run through the terminal persistence transition table", async () => {
    const runId = "run-lifecycle-table";
    const sessionKey = "agent:main:main";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const params = createParams();
    const registration = registerChatAbortController({
      chatAbortControllers: params.chatAbortControllers,
      runId,
      sessionId: "session-lifecycle-table",
      sessionKey,
      timeoutMs: 60_000,
      lifecycleGeneration,
    });
    if (!registration.entry) {
      throw new Error("expected registered chat abort controller");
    }
    const entry = registration.entry;
    const transitions: LifecycleTransition[] = [
      { state: "Registered", lifecycle: readLifecycleState(entry) },
    ];
    agentEventHandlerMocks.create.mockReturnValue(Object.assign(vi.fn(), { dispose: vi.fn() }));
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentEvent({
      runId,
      lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    transitions.push({ state: "Start-normalized", lifecycle: readLifecycleState(entry) });
    await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());
    const callbacks = requireLifecycleOwnerCallbacks();

    emitAgentEvent({
      runId,
      lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 3_000 },
    });
    transitions.push({ state: "Terminal-observed", lifecycle: readLifecycleState(entry) });

    callbacks.clearTrackedActiveRun({ runId, clientRunId: runId, sessionKey });
    transitions.push({ state: "Projection-cleared", lifecycle: readLifecycleState(entry) });

    const terminalPersistence = createDeferred();
    callbacks.trackTrackedRunTerminalPersistence({
      runId,
      clientRunId: runId,
      sessionKey,
      sessionId: entry.sessionId,
      observedAt: 3_001,
      persistence: terminalPersistence.promise,
    });
    transitions.push({ state: "Persisting", lifecycle: readLifecycleState(entry) });

    terminalPersistence.resolve();
    await terminalPersistence.promise;
    callbacks.markTrackedRunTerminalPersisted({ runId, clientRunId: runId, sessionKey });
    transitions.push({ state: "Persisted", lifecycle: readLifecycleState(entry) });

    registration.cleanup();
    transitions.push({ state: "Removed" });
    expect(params.chatAbortControllers.has(runId)).toBe(false);
    expect(transitions).toEqual([
      { state: "Registered", lifecycle: lifecycleState(true) },
      { state: "Start-normalized", lifecycle: lifecycleState(true, false) },
      { state: "Terminal-observed", lifecycle: lifecycleState(true, true, 3_000) },
      {
        state: "Projection-cleared",
        lifecycle: lifecycleState(false, false, 3_000, undefined, false),
      },
      {
        state: "Persisting",
        lifecycle: lifecycleState(false, false, 3_000, terminalPersistence.promise, false),
      },
      { state: "Persisted", lifecycle: lifecycleState(false, false, 3_000, undefined, true) },
      { state: "Removed" },
    ]);
  });

  it.each(["start", "end"] as const)(
    "generation-fences a current lifecycle %s event from a retired registration",
    async (phase) => {
      const runId = `run-retired-${phase}`;
      const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
      const params = createParams();
      const registration = registerChatAbortController({
        chatAbortControllers: params.chatAbortControllers,
        runId,
        sessionId: `session-retired-${phase}`,
        sessionKey: "agent:main:main",
        timeoutMs: 60_000,
        lifecycleGeneration: `${currentLifecycleGeneration}-retired`,
      });
      if (!registration.entry) {
        throw new Error("expected registered chat abort controller");
      }
      const registered = readLifecycleState(registration.entry);
      agentEventHandlerMocks.create.mockReturnValue(Object.assign(vi.fn(), { dispose: vi.fn() }));
      unsubs = startGatewayEventSubscriptions(params);

      emitAgentEvent({
        runId,
        lifecycleGeneration: currentLifecycleGeneration,
        stream: "lifecycle",
        data: phase === "start" ? { phase, startedAt: 1_000 } : { phase, endedAt: 1_000 },
      });

      expect(readLifecycleState(registration.entry)).toEqual(registered);
      await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());
    },
  );

  it("bridges abort cleanup until terminal persistence is attached and settled", async () => {
    const runId = "run-abort-persistence-bridge";
    const sessionKey = "agent:main:main";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const params = createParams();
    const registration = registerChatAbortController({
      chatAbortControllers: params.chatAbortControllers,
      runId,
      sessionId: "session-abort-persistence-bridge",
      sessionKey,
      timeoutMs: 60_000,
      lifecycleGeneration,
    });
    if (!registration.entry) {
      throw new Error("expected registered chat abort controller");
    }
    const entry = registration.entry;
    agentEventHandlerMocks.create.mockReturnValue(Object.assign(vi.fn(), { dispose: vi.fn() }));
    unsubs = startGatewayEventSubscriptions(params);
    emitAgentEvent({
      runId,
      lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());
    const callbacks = requireLifecycleOwnerCallbacks();

    expect(
      abortChatRunById(
        {
          chatAbortControllers: params.chatAbortControllers,
          chatRunState: params.chatRunState,
          removeChatRun: vi.fn(() => undefined),
          agentRunSeq: params.agentRunSeq,
          broadcast: vi.fn(),
          nodeSendToSession: vi.fn(),
        },
        { runId, sessionKey, stopReason: "user" },
      ),
    ).toEqual({ aborted: true });
    expect(params.chatAbortControllers.get(runId)).toBe(entry);
    expect(readLifecycleState(entry)).toMatchObject({
      projectSessionActive: false,
      projectSessionTerminalPending: true,
      projectSessionTerminalObservedAt: expect.any(Number),
      registrationCleanupRequested: true,
    });

    callbacks.clearTrackedActiveRun({ runId, clientRunId: runId, sessionKey });
    const terminalPersistence = createDeferred();
    callbacks.trackTrackedRunTerminalPersistence({
      runId,
      clientRunId: runId,
      sessionKey,
      sessionId: entry.sessionId,
      observedAt: entry.projectSessionTerminalObservedAt ?? 0,
      persistence: terminalPersistence.promise,
    });
    void terminalPersistence.promise.then(() => {
      callbacks.markTrackedRunTerminalPersisted({ runId, clientRunId: runId, sessionKey });
    });

    await Promise.resolve();
    expect(params.chatAbortControllers.get(runId)).toBe(entry);
    expect(readLifecycleState(entry)).toMatchObject({
      projectSessionActive: false,
      projectSessionTerminalPending: false,
      projectSessionTerminalPersistence: terminalPersistence.promise,
      projectSessionTerminalPersisted: false,
      registrationCleanupRequested: true,
    });

    terminalPersistence.resolve();
    await waitForFast(() => expect(params.chatAbortControllers.has(runId)).toBe(false));
  });

  it("logs transcript handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/sess.jsonl",
      sessionKey: "agent:main:main",
    } as InternalSessionTranscriptUpdate);

    await waitForFast(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Transcript update dispatch failed",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  it("logs real asynchronous transcript failures and recovers the broadcast queue", async () => {
    transcriptBroadcastMocks.useActualHandler = true;
    const persistenceFailure = new Error("session transcript read failed");
    transcriptBroadcastMocks.readMessageCount
      .mockRejectedValueOnce(persistenceFailure)
      .mockResolvedValueOnce(2);

    const params = createParams();
    params.sessionEventSubscribers.subscribe("conn-transcript");
    unsubs = startGatewayEventSubscriptions(params);

    const emitMessage = (messageId: string) =>
      emitSessionTranscriptUpdate({
        sessionFile: "/tmp/openclaw-transcript-dispatch.sqlite",
        sessionKey: "agent:main:main",
        message: { role: "assistant", content: [{ type: "text", text: "visible answer" }] },
        messageId,
        target: {
          agentId: "main",
          sessionId: "sess-transcript",
          sessionKey: "agent:main:main",
          storePath: "/tmp/openclaw-transcript-dispatch-sessions.json",
        },
      });

    emitMessage("failed-message");
    await waitForFast(() =>
      expect(transcriptBroadcastMocks.readMessageCount).toHaveBeenCalledOnce(),
    );
    await waitForFast(() =>
      expect(warn).toHaveBeenCalledWith("Transcript update dispatch failed", {
        sessionKey: "agent:main:main",
        error: persistenceFailure,
      }),
    );
    expect(params.broadcastToConnIds).not.toHaveBeenCalled();

    emitMessage("recovered-message");
    await waitForFast(() => expect(params.broadcastToConnIds).toHaveBeenCalledOnce());
    expect(params.broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        messageId: "recovered-message",
        messageSeq: 2,
      }),
      new Set(["conn-transcript"]),
    );
    expect(transcriptBroadcastMocks.readMessageCount).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("logs lifecycle handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitSessionLifecycleEvent({ sessionKey: "agent:main:main", reason: "created" });

    await waitForFast(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Lifecycle event dispatch failed",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  it("broadcasts bounded public task summaries with ledger statuses", async () => {
    const broadcast = vi.fn<SubscriptionParams["broadcast"]>();
    unsubs = startGatewayEventSubscriptions({ ...createParams(), broadcast });
    await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());

    const completed = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Completed task",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      terminalSummary: "x".repeat(10_000),
    });
    const lost = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Lost task",
      status: "lost",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });

    if (!completed || !lost) {
      throw new Error("expected task records to be created");
    }
    const taskUpsertsById = new Map(
      broadcast.mock.calls
        .filter(([event]) => event === "task")
        .map(([, payload]) => payload as TaskEventPayload)
        .filter(
          (payload): payload is Extract<TaskEventPayload, { action: "upserted" }> =>
            payload.action === "upserted",
        )
        .map((payload) => [payload.task.id, payload.task]),
    );
    expect(broadcast).toHaveBeenCalledWith("task", expect.anything(), {
      dropIfSlow: true,
      sessionKeys: ["agent:main:main"],
      agentId: "main",
    });
    // Runtime registry statuses translate to the public ledger vocabulary.
    expect(taskUpsertsById.get(completed.taskId)?.status).toBe("completed");
    expect(taskUpsertsById.get(lost.taskId)?.status).toBe("failed");
    // Unbounded status text from providers/shells must be truncated on the wire.
    const wireTerminalSummary = taskUpsertsById.get(completed.taskId)?.terminalSummary;
    expect(wireTerminalSummary).toBeTruthy();
    expect(wireTerminalSummary?.length ?? 0).toBeLessThan(10_000);

    void unsubs?.taskUnsub();
    await waitForFast(() => expect(getTaskRegistryObservers()).toBeNull());
    broadcast.mockClear();
    createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "After dispose",
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("throttles live subagent progress per task and flushes before terminal status", async () => {
    const broadcast = vi.fn<SubscriptionParams["broadcast"]>();
    unsubs = startGatewayEventSubscriptions({ ...createParams(), broadcast });
    await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const primary = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:primary",
      runId: "run-throttle-primary",
      task: "Implement live progress",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    const secondary = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:secondary",
      runId: "run-throttle-secondary",
      task: "Review live progress",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    if (!primary || !secondary) {
      throw new Error("expected task records");
    }
    broadcast.mockClear();

    for (const text of ["first", "second", "third"]) {
      emitAgentEvent({
        runId: primary.runId!,
        stream: "assistant",
        data: { text },
      });
    }
    emitAgentEvent({
      runId: secondary.runId!,
      stream: "thinking",
      data: { text: "parallel" },
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(broadcast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const firstFlush = broadcast.mock.calls
      .filter(([event]) => event === "task")
      .map(([, payload]) => payload as TaskEventPayload)
      .filter(
        (payload): payload is Extract<TaskEventPayload, { action: "upserted" }> =>
          payload.action === "upserted",
      );
    expect(firstFlush).toHaveLength(2);
    expect(firstFlush.find((event) => event.task.id === primary.taskId)?.task.lastActivity).toBe(
      "third",
    );
    expect(firstFlush.find((event) => event.task.id === secondary.taskId)?.task.lastActivity).toBe(
      "parallel",
    );

    broadcast.mockClear();
    emitAgentEvent({
      runId: secondary.runId!,
      stream: "assistant",
      data: { text: "OpenClaw runtime context (internal): Keep internal details private." },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const sanitizedActivity = broadcast.mock.calls.find(
      ([event, payload]) =>
        event === "task" &&
        (payload as TaskEventPayload).action === "upserted" &&
        (payload as Extract<TaskEventPayload, { action: "upserted" }>).task.id === secondary.taskId,
    )?.[1] as Extract<TaskEventPayload, { action: "upserted" }> | undefined;
    expect(sanitizedActivity?.task).not.toHaveProperty("lastActivity");
    expect(JSON.stringify(sanitizedActivity)).not.toContain("OpenClaw runtime context");

    broadcast.mockClear();
    emitAgentEvent({
      runId: primary.runId!,
      stream: "assistant",
      data: { text: "third" },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(broadcast).not.toHaveBeenCalled();

    emitAgentEvent({
      runId: primary.runId!,
      stream: "assistant",
      data: { text: "final activity" },
    });
    markTaskTerminalById({ taskId: primary.taskId, status: "succeeded", endedAt: Date.now() });
    const terminalFlush = broadcast.mock.calls
      .filter(([event]) => event === "task")
      .map(([, payload]) => payload as TaskEventPayload)
      .filter(
        (payload): payload is Extract<TaskEventPayload, { action: "upserted" }> =>
          payload.action === "upserted" && payload.task.id === primary.taskId,
      );
    expect(terminalFlush.map((event) => event.task.status)).toEqual(["running", "completed"]);
    expect(terminalFlush[0]?.task.lastActivity).toBe("final activity");
    expect(terminalFlush[1]?.task).not.toHaveProperty("lastActivity");

    broadcast.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("suppresses identical task summaries without delaying status transitions", async () => {
    const broadcast = vi.fn<SubscriptionParams["broadcast"]>();
    unsubs = startGatewayEventSubscriptions({ ...createParams(), broadcast });
    await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
    const runId = "run-identical-task-summary";
    const task = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:summary",
      runId,
      task: "Avoid duplicate broadcasts",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 100,
      lastEventAt: 100,
    });
    if (!task) {
      throw new Error("expected task record");
    }
    broadcast.mockClear();

    for (let index = 0; index < 2; index += 1) {
      recordTaskProgressByRunId({
        runId,
        runtime: "subagent",
        lastEventAt: 200,
        progressSummary: "Working",
      });
    }
    markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 300 });

    const taskEvents = broadcast.mock.calls
      .filter(([event]) => event === "task")
      .map(([, payload]) => payload as TaskEventPayload)
      .filter(
        (payload): payload is Extract<TaskEventPayload, { action: "upserted" }> =>
          payload.action === "upserted",
      );
    expect(taskEvents.map((event) => event.task.status)).toEqual(["running", "completed"]);
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out", "lost"] as const)(
    "closes task-run terminals exactly once for a %s transition",
    async (status) => {
      const closeTaskSessions = vi.fn(() => 1);
      unsubs = startGatewayEventSubscriptions({
        ...createParams(),
        terminalSessions: { closeTaskSessions },
      });
      await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());

      const task = createTaskRecord({
        runtime: "cron",
        requesterSessionKey: "",
        ownerKey: "",
        scopeKind: "system",
        task: `${status} cron task`,
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
      });
      if (!task) {
        throw new Error("expected task record");
      }
      const terminalize = () => {
        if (status === "lost") {
          markTaskLostById({ taskId: task.taskId, endedAt: 2_000 });
          return;
        }
        markTaskTerminalById({
          taskId: task.taskId,
          status,
          endedAt: 2_000,
        });
      };

      terminalize();
      terminalize();

      expect(closeTaskSessions).toHaveBeenCalledOnce();
      expect(closeTaskSessions).toHaveBeenCalledWith(task.taskId);
    },
  );

  it("closes a completed cron task terminal while preserving a conversation terminal", async () => {
    const taskPty = makeFakePty();
    const persistentPty = makeFakePty();
    const ptys = [taskPty, persistentPty];
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => ptys.shift() ?? makeFakePty(),
    });
    unsubs = startGatewayEventSubscriptions({
      ...createParams(),
      terminalSessions: manager,
    });
    await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());

    const runId = "cron:job-1:run-1";
    const runSessionKey = "agent:main:cron:job-1:run:run-1";
    const task = createTaskRecord({
      runtime: "cron",
      requesterSessionKey: "",
      ownerKey: "",
      scopeKind: "system",
      childSessionKey: runSessionKey,
      runId,
      task: "Cron task",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    if (!task) {
      throw new Error("expected task record");
    }
    const taskOpen = await manager.open(
      baseOpenRequest({
        owner: taskAgentOwner(runSessionKey, task.taskId),
      }),
    );
    const persistentOwner = agentTerminalOwner("agent:main:main");
    const persistentOpen = await manager.open(baseOpenRequest({ owner: persistentOwner }));
    if (!taskOpen.ok || !persistentOpen.ok) {
      throw new Error("expected terminal sessions");
    }

    tryFinishCronTaskRunWithoutHistory({ deps: { log: mockLog } } as unknown as CronServiceState, {
      taskRunId: runId,
      status: "ok",
      endedAt: 2_000,
      childSessionKey: runSessionKey,
    });

    expect(taskPty.killed).toBe(true);
    expect(persistentPty.killed).toBe(false);
    expect(manager.size).toBe(1);
    expect(manager.listAgent(persistentOwner)).toHaveLength(1);
  });

  it("closes task-run terminals only after the authoritative task becomes terminal", async () => {
    const events: string[] = [];
    const closeTaskSessions = vi.fn((taskId: string) => {
      events.push(`terminal:${taskId}`);
      return 1;
    });
    const broadcast = vi.fn<SubscriptionParams["broadcast"]>((event, payload) => {
      if (event === "task" && (payload as TaskEventPayload).action === "upserted") {
        const taskPayload = payload as Extract<TaskEventPayload, { action: "upserted" }>;
        events.push(`task:${taskPayload.task.status}`);
      }
    });
    unsubs = startGatewayEventSubscriptions({
      ...createParams(),
      broadcast,
      terminalSessions: { closeTaskSessions },
    });
    await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());

    const runSessionKey = "agent:main:cron:job-1:run:run-1";
    const task = createTaskRecord({
      runtime: "cron",
      requesterSessionKey: "",
      ownerKey: "",
      scopeKind: "system",
      childSessionKey: runSessionKey,
      task: "Cron task",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    if (!task) {
      throw new Error("expected task record");
    }
    expect(closeTaskSessions).not.toHaveBeenCalled();
    expect(events).toEqual(["task:running"]);

    markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 2_000 });
    expect(closeTaskSessions).toHaveBeenCalledOnce();
    expect(closeTaskSessions).toHaveBeenCalledWith(task.taskId);
    expect(events).toEqual(["task:running", "task:completed", `terminal:${task.taskId}`]);

    // Later terminal-row updates cannot close terminals opened by a newer owner.
    markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 2_001 });
    expect(closeTaskSessions).toHaveBeenCalledOnce();
  });

  it("keeps a replacement gateway's task observer when a stale unsub runs late", async () => {
    const staleBroadcast = vi.fn<SubscriptionParams["broadcast"]>();
    const staleSubs = startGatewayEventSubscriptions({
      ...createParams(),
      broadcast: staleBroadcast,
    });
    await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
    const staleObservers = getTaskRegistryObservers();

    const replacementBroadcast = vi.fn<SubscriptionParams["broadcast"]>();
    unsubs = startGatewayEventSubscriptions({
      ...createParams(),
      broadcast: replacementBroadcast,
    });
    await waitForFast(() => {
      const current = getTaskRegistryObservers();
      expect(current).not.toBeNull();
      expect(current).not.toBe(staleObservers);
    });

    // The stale dispose must not clear the replacement's observer slot.
    await staleSubs.taskUnsub();
    await staleSubs.agentUnsub();
    staleSubs.heartbeatUnsub();
    staleSubs.transcriptUnsub();
    staleSubs.lifecycleUnsub();
    expect(getTaskRegistryObservers()).not.toBeNull();

    createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "After stale dispose",
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    expect(replacementBroadcast.mock.calls.some(([event]) => event === "task")).toBe(true);
    expect(staleBroadcast.mock.calls.some(([event]) => event === "task")).toBe(false);
  });
});
