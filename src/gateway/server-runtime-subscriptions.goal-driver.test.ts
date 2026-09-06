import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { installInMemoryTaskRegistryRuntime } from "../test-utils/task-registry-runtime.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
  createToolEventRecipientRegistry,
} from "./server-chat-state.js";

const state = vi.hoisted(() => ({
  onRunTerminal: vi.fn<(sessionKey: string) => void>(),
  rearmPersistedActiveGoals: vi.fn<() => void>(),
  stop: vi.fn<() => void>(),
  start: vi.fn(),
  agentHandlerOptions: undefined as
    | {
        markTrackedRunTerminalPersisted?: (params: {
          runId: string;
          clientRunId: string;
          sessionKey: string;
        }) => void;
      }
    | undefined,
}));

vi.mock("../agents/goal-driver/service.js", () => ({
  startGoalDriverService: (...args: unknown[]) => {
    state.start(...args);
    return {
      onRunTerminal: state.onRunTerminal,
      rearmPersistedActiveGoals: state.rearmPersistedActiveGoals,
      pendingCount: () => 0,
      stop: state.stop,
    };
  },
}));

vi.mock("../audit/audit-config.js", () => ({
  isAuditLedgerEnabled: () => false,
  resolveAuditMessageMode: () => "off",
}));

vi.mock("../audit/audit-recorder.js", () => ({
  createAuditEventRecorder: () => ({
    record: vi.fn(),
    recordTool: vi.fn(),
    recordMessage: vi.fn(),
    stop: vi.fn(async () => undefined),
  }),
}));

vi.mock("./server-chat.js", () => ({
  createAgentEventHandler: (options: typeof state.agentHandlerOptions) => {
    state.agentHandlerOptions = options;
    return () => undefined;
  },
}));

vi.mock("./server-session-key.js", () => ({
  resolveSessionKeyForRun: () => "agent:main:main",
}));

vi.mock("./server-session-events.js", () => ({
  createTranscriptUpdateBroadcastHandler: () => () => undefined,
  createLifecycleEventBroadcastHandler: () => () => undefined,
}));

const { startGatewayEventSubscriptions } = await import("./server-runtime-subscriptions.js");
type SubscriptionParams = Parameters<typeof startGatewayEventSubscriptions>[0];

const mockLog: SubsystemLogger = {
  subsystem: "gateway-goal-driver-test",
  isEnabled: () => true,
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  raw: vi.fn(),
  child: () => mockLog,
};

function createParams(): SubscriptionParams {
  return {
    log: mockLog,
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map(),
    chatRunState: createChatRunState(),
    toolEventRecipients: createToolEventRecipientRegistry(),
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    restartRecoveryCandidates: new Map(),
  };
}

describe("gateway goal-driver terminal wiring", () => {
  let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    state.agentHandlerOptions = undefined;
    installInMemoryTaskRegistryRuntime();
  });

  afterEach(async () => {
    await unsubs?.agentUnsub();
    unsubs?.heartbeatUnsub();
    unsubs?.transcriptUnsub();
    unsubs?.lifecycleUnsub();
    void unsubs?.taskUnsub();
    resetAgentEventsForTest();
    resetTaskRegistryForTests({ persist: false });
  });

  it("rearms at startup, arms only after terminal persistence, and stops with subscriptions", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    expect(state.start).toHaveBeenCalledOnce();
    expect(state.rearmPersistedActiveGoals).toHaveBeenCalledOnce();

    emitAgentEvent({
      runId: "goal-run",
      sessionKey: "agent:main:main",
      agentId: "main",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await vi.waitFor(() => expect(state.agentHandlerOptions).toBeDefined());

    // The raw terminal event is intentionally too early: the durable lifecycle
    // write has not resolved yet, so a continuation cannot be armed from it.
    expect(state.onRunTerminal).not.toHaveBeenCalled();

    state.agentHandlerOptions?.markTrackedRunTerminalPersisted?.({
      runId: "goal-run",
      clientRunId: "goal-run",
      sessionKey: "agent:main:main",
    });

    expect(state.onRunTerminal).toHaveBeenCalledOnce();
    expect(state.onRunTerminal).toHaveBeenCalledWith("agent:main:main");

    await unsubs.agentUnsub();
    expect(state.stop).toHaveBeenCalledOnce();
  });
});
