// Verifies sessions_spawn lifecycle hooks, binding cleanup, and gateway calls.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

type GatewayRequest = { method?: string; params?: Record<string, unknown> };
type TestBindingRequest = {
  targetSessionKey: string;
  targetKind?: string;
  conversation: {
    channel: string;
    accountId?: string;
    conversationId: string;
    parentConversationId?: string;
  };
  placement: "current" | "child";
  metadata?: Record<string, unknown>;
};

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  updateSessionStoreMock: vi.fn(),
}));

const hookRunnerMocks = vi.hoisted(() => ({
  hasSubagentEndedHook: true,
  runSubagentSpawned: vi.fn(async () => {}),
  runSubagentProgress: vi.fn(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
}));

const bindingMocks = vi.hoisted(() => ({
  getCapabilities: vi.fn(() => ({
    adapterAvailable: true,
    bindSupported: true,
    placements: ["child"] as Array<"current" | "child">,
  })),
  bind: vi.fn(async (request: TestBindingRequest) => {
    const conversation = request.conversation;
    return {
      targetSessionKey: request.targetSessionKey,
      targetKind: request.targetKind,
      status: "active",
      conversation: {
        channel: conversation.channel,
        accountId: conversation.accountId ?? "default",
        conversationId: "456",
        parentConversationId: conversation.conversationId,
      },
    };
  }),
  listBySession: vi.fn(() => []),
}));

let resetSubagentRegistryForTests: typeof import("./subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

function getGatewayRequests(): GatewayRequest[] {
  // Gateway call list is the observable side effect for spawn orchestration.
  return hoisted.callGatewayMock.mock.calls.map((call) => call[0] as GatewayRequest);
}

function getGatewayMethods() {
  return getGatewayRequests().map((request) => request.method);
}

function findGatewayRequest(method: string): GatewayRequest | undefined {
  return getGatewayRequests().find((request) => request.method === method);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectFields(value: unknown, expected: Record<string, unknown>, label = "object"): void {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
}

function expectSubagentSessionKey(value: unknown, label: string): string {
  expect(value, label).toBeTypeOf("string");
  const sessionKey = value as string;
  expect(sessionKey.startsWith("agent:main:subagent:")).toBe(true);
  return sessionKey;
}

function setConfig(next: Record<string, unknown>) {
  hoisted.configOverride = createSubagentSpawnTestConfig(undefined, next);
}

async function spawn(params?: {
  toolCallId?: string;
  task?: string;
  label?: string;
  model?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: "run" | "session";
  context?: "isolated" | "fork";
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
}) {
  return await spawnSubagentDirect(
    {
      task: params?.task ?? "do thing",
      ...(params?.label ? { label: params.label } : {}),
      ...(params?.model ? { model: params.model } : {}),
      ...(typeof params?.runTimeoutSeconds === "number"
        ? { runTimeoutSeconds: params.runTimeoutSeconds }
        : {}),
      ...(params?.thread ? { thread: true } : {}),
      ...(params?.mode ? { mode: params.mode } : {}),
      context: params?.context ?? "isolated",
    },
    {
      agentSessionKey: params?.agentSessionKey ?? "main",
      agentChannel: params?.agentChannel ?? "discord",
      agentAccountId: params?.agentAccountId,
      agentTo: params?.agentTo,
      agentThreadId: params?.agentThreadId,
      currentMessagingTarget: params?.currentMessagingTarget,
      currentChannelId: params?.currentChannelId,
      currentMessageId: params?.currentMessageId,
    },
  );
}

function expectSessionsDeleteWithoutAgentStart() {
  const methods = getGatewayMethods();
  expect(methods).toContain("sessions.delete");
  expect(methods).not.toContain("agent");
}

function mockAgentStartFailure() {
  hoisted.callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "agent") {
      throw new Error("spawn failed");
    }
    return {};
  });
}

function requireSpawnedHookCall(): [Record<string, unknown>, Record<string, unknown>] {
  const call = hookRunnerMocks.runSubagentSpawned.mock.calls[0] as readonly unknown[] | undefined;
  if (!call) {
    throw new Error("expected spawned hook call");
  }
  return [requireRecord(call[0], "spawned event"), requireRecord(call[1], "spawned context")];
}

function getSpawnedEventCall(): Record<string, unknown> {
  const [event] = requireSpawnedHookCall();
  return event;
}

function requireEndedHookEvent(): Record<string, unknown> {
  const call = hookRunnerMocks.runSubagentEnded.mock.calls[0] as readonly unknown[] | undefined;
  if (!call) {
    throw new Error("expected ended hook call");
  }
  return requireRecord(call[0], "ended event");
}

function expectErrorResultMessage(
  result: { error?: string; status: string },
  pattern: RegExp,
): void {
  expect(result.status).toBe("error");
  expect(result.error).toMatch(pattern);
}

function expectThreadBindFailureCleanup(
  result: { childSessionKey?: string; error?: string },
  pattern: RegExp,
): void {
  // Failed child-thread binding must delete the child before agent startup.
  expect(result.error).toMatch(pattern);
  expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
  expectSessionsDeleteWithoutAgentStart();
  const deleteCall = findGatewayRequest("sessions.delete");
  expectFields(
    deleteCall?.params,
    {
      key: result.childSessionKey,
      emitLifecycleHooks: false,
    },
    "delete params",
  );
}

beforeAll(async () => {
  ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
    callGatewayMock: hoisted.callGatewayMock,
    getRuntimeConfig: () => hoisted.configOverride,
    updateSessionStoreMock: hoisted.updateSessionStoreMock,
    hookRunner: {
      hasHooks: (hookName: string) =>
        hookName === "subagent_spawned" ||
        hookName === "subagent_progress" ||
        (hookName === "subagent_ended" && hookRunnerMocks.hasSubagentEndedHook),
      runSubagentSpawned: hookRunnerMocks.runSubagentSpawned,
      runSubagentProgress: hookRunnerMocks.runSubagentProgress,
      runSubagentEnded: hookRunnerMocks.runSubagentEnded,
    },
    getSessionBindingService: () => bindingMocks,
    resetModules: false,
    sessionStorePath: "/tmp/subagent-spawn-hooks-session-store.json",
  }));
});

describe("sessions_spawn subagent lifecycle hooks", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hookRunnerMocks.hasSubagentEndedHook = true;
    hookRunnerMocks.runSubagentSpawned.mockClear();
    hookRunnerMocks.runSubagentProgress.mockClear();
    hookRunnerMocks.runSubagentEnded.mockClear();
    bindingMocks.getCapabilities.mockClear();
    bindingMocks.getCapabilities.mockReturnValue({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["child"],
    });
    bindingMocks.bind.mockClear();
    bindingMocks.bind.mockImplementation(async (request: TestBindingRequest) => {
      const conversation = request.conversation;
      return {
        targetSessionKey: request.targetSessionKey,
        targetKind: request.targetKind,
        status: "active",
        conversation: {
          channel: conversation.channel,
          accountId: conversation.accountId ?? "default",
          conversationId: "456",
          parentConversationId: conversation.conversationId,
        },
      };
    });
    bindingMocks.listBySession.mockClear();
    setConfig({
      session: {
        mainKey: "main",
        scope: "per-sender",
        threadBindings: {
          defaultSpawnContext: "isolated",
        },
      },
    });
    const store: Record<string, Record<string, unknown>> = {};
    hoisted.updateSessionStoreMock.mockImplementation(
      async (_storePath: unknown, mutator: unknown) => {
        if (typeof mutator !== "function") {
          throw new Error("missing session store mutator");
        }
        await mutator(store);
        return store;
      },
    );
    hoisted.callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1_001 };
      }
      return {};
    });
  });

  afterEach(() => {
    resetSubagentRegistryForTests();
  });

  it("binds the subagent thread in core and emits subagent_spawned with requester metadata", async () => {
    const result = await spawn({
      label: "research",
      model: "openai/gpt-5.4",
      runTimeoutSeconds: 1,
      thread: true,
      agentAccountId: "work",
      agentTo: "channel:123",
      agentThreadId: 456,
      currentMessagingTarget: "channel:source",
      currentChannelId: "source-native",
      currentMessageId: "message-789",
      context: "isolated",
    });

    expectFields(
      result,
      {
        status: "accepted",
        runId: "run-1",
        resolvedModel: "openai/gpt-5.4",
        resolvedProvider: "openai",
      },
      "spawn result",
    );
    expect(bindingMocks.getCapabilities).toHaveBeenCalledWith({
      channel: "discord",
      accountId: "work",
    });
    expect(bindingMocks.bind).toHaveBeenCalledTimes(1);
    const bindingRequest = requireRecord(bindingMocks.bind.mock.calls[0]?.[0], "binding request");
    const bindingChildSessionKey = expectSubagentSessionKey(
      bindingRequest.targetSessionKey,
      "binding target session key",
    );
    expectFields(
      bindingRequest,
      {
        targetSessionKey: bindingChildSessionKey,
        targetKind: "subagent",
        placement: "child",
      },
      "binding request",
    );
    expectFields(
      bindingRequest.conversation,
      {
        channel: "discord",
        accountId: "work",
        conversationId: "456",
        parentConversationId: "123",
      },
      "binding conversation",
    );

    expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
    const [event, ctx] = requireSpawnedHookCall();
    expectFields(
      event,
      {
        runId: "run-1",
        agentId: "main",
        label: "research",
        mode: "session",
        threadRequested: true,
        resolvedModel: "openai/gpt-5.4",
        resolvedProvider: "openai",
      },
      "spawned event",
    );
    expectFields(
      event.requester,
      {
        channel: "discord",
        accountId: "work",
        to: "channel:123",
        threadId: 456,
      },
      "spawned requester",
    );
    expectSubagentSessionKey(event.childSessionKey, "spawned event child session key");
    expectFields(
      ctx,
      {
        runId: "run-1",
        requesterSessionKey: "main",
        childSessionKey: event.childSessionKey,
      },
      "spawned context",
    );
    expect(hookRunnerMocks.runSubagentProgress).toHaveBeenCalledWith(
      {
        phase: "started",
        runId: "run-1",
        childSessionKey: event.childSessionKey,
        requester: {
          channel: "discord",
          accountId: "work",
          to: "channel:source",
          threadId: 456,
          channelId: "source-native",
          messageId: "message-789",
        },
      },
      ctx,
    );
    expect(
      hookRunnerMocks.runSubagentProgress.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(
      hookRunnerMocks.runSubagentSpawned.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("emits subagent_spawned with threadRequested=false when not requested", async () => {
    const result = await spawn({
      runTimeoutSeconds: 1,
      agentTo: "channel:123",
    });

    expectFields(result, { status: "accepted", runId: "run-1" }, "spawn result");
    expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
    const event = getSpawnedEventCall();
    expectFields(
      event,
      {
        mode: "run",
        threadRequested: false,
      },
      "spawned event",
    );
    expectFields(
      event.requester,
      {
        channel: "discord",
        to: "channel:123",
      },
      "spawned requester",
    );
  });

  it("respects explicit mode=run when thread binding is requested", async () => {
    const result = await spawn({
      runTimeoutSeconds: 1,
      thread: true,
      mode: "run",
      agentTo: "channel:123",
      context: "isolated",
    });

    expectFields(result, { status: "accepted", runId: "run-1", mode: "run" }, "spawn result");
    expect(bindingMocks.bind).toHaveBeenCalledTimes(1);
    const event = getSpawnedEventCall();
    expectFields(
      event,
      {
        mode: "run",
        threadRequested: true,
      },
      "spawned event",
    );
  });

  it("returns error when thread binding cannot be created", async () => {
    bindingMocks.bind.mockRejectedValueOnce(
      new Error("Unable to create or bind a Discord thread for this subagent session."),
    );
    const result = await spawn({
      toolCallId: "call4",
      runTimeoutSeconds: 1,
      thread: true,
      mode: "session",
      agentAccountId: "work",
      agentTo: "channel:123",
      context: "isolated",
    });

    expectThreadBindFailureCleanup(result, /thread/i);
  });

  it("returns error when thread binding does not produce a conversation", async () => {
    bindingMocks.bind.mockResolvedValueOnce({
      targetSessionKey: "agent:main:subagent:test",
      targetKind: "subagent",
      status: "active",
      conversation: {
        channel: "discord",
        accountId: "work",
        conversationId: "",
        parentConversationId: "123",
      },
    });
    const result = await spawn({
      toolCallId: "call4b",
      runTimeoutSeconds: 1,
      thread: true,
      mode: "session",
      agentAccountId: "work",
      agentTo: "channel:123",
      context: "isolated",
    });

    expectThreadBindFailureCleanup(result, /unable to create or bind a thread/i);
  });

  it("rejects mode=session when thread=true is not requested", async () => {
    const result = await spawn({
      mode: "session",
      agentTo: "channel:123",
    });

    expectErrorResultMessage(result, /requires thread=true/i);
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects thread=true on channels without thread support", async () => {
    bindingMocks.getCapabilities.mockReturnValueOnce({
      adapterAvailable: false,
      bindSupported: false,
      placements: [],
    });
    const result = await spawn({
      thread: true,
      mode: "session",
      agentChannel: "signal",
      agentTo: "+123",
      context: "isolated",
    });

    expectErrorResultMessage(result, /only available on channels that expose thread bindings/i);
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    expectSessionsDeleteWithoutAgentStart();
  });

  it("runs subagent_ended cleanup hook when agent start fails after successful bind", async () => {
    mockAgentStartFailure();
    const result = await spawn({
      thread: true,
      mode: "session",
      agentAccountId: "work",
      agentTo: "channel:123",
      agentThreadId: "456",
      context: "isolated",
    });

    expect(result.status).toBe("error");
    expect(hookRunnerMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    const event = requireEndedHookEvent();
    expectSubagentSessionKey(event.targetSessionKey, "ended event target session key");
    expectFields(
      event,
      {
        accountId: "work",
        targetKind: "subagent",
        reason: "spawn-failed",
        sendFarewell: true,
        outcome: "error",
        error: "Session failed to start",
      },
      "ended event",
    );
    const deleteCall = findGatewayRequest("sessions.delete");
    expectFields(
      deleteCall?.params,
      {
        key: event.targetSessionKey,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      "delete params",
    );
  });

  it("falls back to sessions.delete cleanup when subagent_ended hook is unavailable", async () => {
    hookRunnerMocks.hasSubagentEndedHook = false;
    mockAgentStartFailure();
    const result = await spawn({
      thread: true,
      mode: "session",
      agentAccountId: "work",
      agentTo: "channel:123",
      agentThreadId: "456",
      context: "isolated",
    });

    expect(result.status).toBe("error");
    expect(hookRunnerMocks.runSubagentEnded).not.toHaveBeenCalled();
    const methods = getGatewayMethods();
    expect(methods).toContain("sessions.delete");
    const deleteCall = findGatewayRequest("sessions.delete");
    expectFields(
      deleteCall?.params,
      {
        deleteTranscript: true,
        emitLifecycleHooks: true,
      },
      "delete params",
    );
  });
});
