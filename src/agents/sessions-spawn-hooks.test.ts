import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

type GatewayRequest = { method?: string; params?: Record<string, unknown> };

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
}));

const hookRunnerMocks = vi.hoisted(() => ({
  hasSubagentEndedHook: true,
  runSubagentSpawning: vi.fn(async (event: unknown) => {
    const input = event as {
      threadRequested?: boolean;
      requester?: { channel?: string };
    };
    if (!input.threadRequested) {
      return undefined;
    }
    const channel = input.requester?.channel?.trim().toLowerCase();
    if (channel !== "discord") {
      const channelLabel = input.requester?.channel?.trim() || "unknown";
      return {
        status: "error" as const,
        error: `thread=true is not supported for channel "${channelLabel}". Only Discord thread-bound subagent sessions are supported right now.`,
      };
    }
    return {
      status: "ok" as const,
      threadBindingReady: true,
    };
  }),
  runSubagentSpawned: vi.fn(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
}));

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

function getGatewayRequests(): GatewayRequest[] {
  return hoisted.callGatewayMock.mock.calls.map((call) => call[0] as GatewayRequest);
}

function getGatewayMethods() {
  return getGatewayRequests().map((request) => request.method);
}

function findGatewayRequest(method: string): GatewayRequest | undefined {
  return getGatewayRequests().find((request) => request.method === method);
}

function setConfig(next: Record<string, unknown>) {
  hoisted.configOverride = createSubagentSpawnTestConfig(undefined, next);
}

async function spawn(params?: {
  toolCallId?: string;
  task?: string;
  label?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: "run" | "session";
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
}) {
  return await spawnSubagentDirect(
    {
      task: params?.task ?? "do thing",
      ...(params?.label ? { label: params.label } : {}),
      ...(typeof params?.runTimeoutSeconds === "number"
        ? { runTimeoutSeconds: params.runTimeoutSeconds }
        : {}),
      ...(params?.thread ? { thread: true } : {}),
      ...(params?.mode ? { mode: params.mode } : {}),
    },
    {
      agentSessionKey: params?.agentSessionKey ?? "main",
      agentChannel: params?.agentChannel ?? "discord",
      agentAccountId: params?.agentAccountId,
      agentTo: params?.agentTo,
      agentThreadId: params?.agentThreadId,
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

function getSpawnedEventCall(): Record<string, unknown> {
  const [event] = (hookRunnerMocks.runSubagentSpawned.mock.calls[0] ?? []) as unknown as [
    Record<string, unknown>,
  ];
  return event;
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
  expect(result.error).toMatch(pattern);
  expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
  expectSessionsDeleteWithoutAgentStart();
  const deleteCall = findGatewayRequest("sessions.delete");
  expect(deleteCall?.params).toMatchObject({
    key: result.childSessionKey,
    emitLifecycleHooks: false,
  });
}

beforeAll(async () => {
  ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
    callGatewayMock: hoisted.callGatewayMock,
    loadConfig: () => hoisted.configOverride,
    hookRunner: {
      hasHooks: (hookName: string) =>
        hookName === "subagent_spawning" ||
        hookName === "subagent_spawned" ||
        (hookName === "subagent_ended" && hookRunnerMocks.hasSubagentEndedHook),
      runSubagentSpawning: hookRunnerMocks.runSubagentSpawning,
      runSubagentSpawned: hookRunnerMocks.runSubagentSpawned,
      runSubagentEnded: hookRunnerMocks.runSubagentEnded,
    },
    resetModules: false,
    sessionStorePath: "/tmp/subagent-spawn-hooks-session-store.json",
  }));
});

describe("sessions_spawn subagent lifecycle hooks", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hookRunnerMocks.hasSubagentEndedHook = true;
    hookRunnerMocks.runSubagentSpawning.mockClear();
    hookRunnerMocks.runSubagentSpawned.mockClear();
    hookRunnerMocks.runSubagentEnded.mockClear();
    setConfig({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    });
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

  it("runs subagent_spawning and emits subagent_spawned with requester metadata", async () => {
    const result = await spawn({
      label: "research",
      runTimeoutSeconds: 1,
      thread: true,
      agentAccountId: "work",
      agentTo: "channel:123",
      agentThreadId: 456,
    });

    expect(result).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledWith(
      {
        childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
        agentId: "main",
        label: "research",
        mode: "session",
        requester: {
          channel: "discord",
          accountId: "work",
          to: "channel:123",
          threadId: 456,
        },
        threadRequested: true,
      },
      {
        childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
        requesterSessionKey: "main",
      },
    );

    expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
    const [event, ctx] = (hookRunnerMocks.runSubagentSpawned.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      runId: "run-1",
      agentId: "main",
      label: "research",
      mode: "session",
      requester: {
        channel: "discord",
        accountId: "work",
        to: "channel:123",
        threadId: 456,
      },
      threadRequested: true,
    });
    expect(event.childSessionKey).toEqual(expect.stringMatching(/^agent:main:subagent:/));
    expect(ctx).toMatchObject({
      runId: "run-1",
      requesterSessionKey: "main",
      childSessionKey: event.childSessionKey,
    });
  });

  it("emits subagent_spawned with threadRequested=false when not requested", async () => {
    const result = await spawn({
      runTimeoutSeconds: 1,
      agentTo: "channel:123",
    });

    expect(result).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(hookRunnerMocks.runSubagentSpawning).not.toHaveBeenCalled();
    expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
    const [event] = (hookRunnerMocks.runSubagentSpawned.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      mode: "run",
      threadRequested: false,
      requester: {
        channel: "discord",
        to: "channel:123",
      },
    });
  });

  it("respects explicit mode=run when thread binding is requested", async () => {
    const result = await spawn({
      runTimeoutSeconds: 1,
      thread: true,
      mode: "run",
      agentTo: "channel:123",
    });

    expect(result).toMatchObject({ status: "accepted", runId: "run-1", mode: "run" });
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledTimes(1);
    const event = getSpawnedEventCall();
    expect(event).toMatchObject({
      mode: "run",
      threadRequested: true,
    });
  });

  it("returns error when thread binding cannot be created", async () => {
    hookRunnerMocks.runSubagentSpawning.mockResolvedValueOnce({
      status: "error",
      error: "Unable to create or bind a Discord thread for this subagent session.",
    });
    const result = await spawn({
      toolCallId: "call4",
      runTimeoutSeconds: 1,
      thread: true,
      mode: "session",
      agentAccountId: "work",
      agentTo: "channel:123",
    });

    expectThreadBindFailureCleanup(result, /thread/i);
  });

  it("returns error when thread binding is not marked ready", async () => {
    hookRunnerMocks.runSubagentSpawning.mockResolvedValueOnce({
      status: "ok",
      threadBindingReady: false,
    });
    const result = await spawn({
      toolCallId: "call4b",
      runTimeoutSeconds: 1,
      thread: true,
      mode: "session",
      agentAccountId: "work",
      agentTo: "channel:123",
    });

    expectThreadBindFailureCleanup(result, /unable to create or bind a thread/i);
  });

  it("rejects mode=session when thread=true is not requested", async () => {
    const result = await spawn({
      mode: "session",
      agentTo: "channel:123",
    });

    expectErrorResultMessage(result, /requires thread=true/i);
    expect(hookRunnerMocks.runSubagentSpawning).not.toHaveBeenCalled();
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects thread=true on channels without thread support", async () => {
    const result = await spawn({
      thread: true,
      mode: "session",
      agentChannel: "signal",
      agentTo: "+123",
    });

    expectErrorResultMessage(result, /only discord/i);
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledTimes(1);
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
    });

    expect(result).toMatchObject({ status: "error" });
    expect(hookRunnerMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    const [event] = (hookRunnerMocks.runSubagentEnded.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      targetSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      accountId: "work",
      targetKind: "subagent",
      reason: "spawn-failed",
      sendFarewell: true,
      outcome: "error",
      error: "Session failed to start",
    });
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      key: event.targetSessionKey,
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
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
    });

    expect(result).toMatchObject({ status: "error" });
    expect(hookRunnerMocks.runSubagentEnded).not.toHaveBeenCalled();
    const methods = getGatewayMethods();
    expect(methods).toContain("sessions.delete");
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      deleteTranscript: true,
      emitLifecycleHooks: true,
    });
  });

  it("cleans up the provisional session when lineage patching fails after thread binding", async () => {
    hoisted.callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.patch" && typeof request.params?.spawnedBy === "string") {
        throw new Error("lineage patch failed");
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1_001 };
      }
      return {};
    });

    const result = await spawn({
      thread: true,
      mode: "session",
      agentAccountId: "work",
      agentTo: "channel:123",
      agentThreadId: "456",
    });

    expect(result).toMatchObject({
      status: "error",
      error: "lineage patch failed",
    });
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    expect(hookRunnerMocks.runSubagentEnded).not.toHaveBeenCalled();
    const methods = getGatewayMethods();
    expect(methods).toContain("sessions.delete");
    expect(methods).not.toContain("agent");
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      key: result.childSessionKey,
      deleteTranscript: true,
      emitLifecycleHooks: true,
    });
  });
});
