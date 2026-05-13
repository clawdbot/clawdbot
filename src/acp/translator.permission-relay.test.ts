import type { CancelNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { promptAgent } from "./translator.prompt-harness.test-support.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

const SESSION_ID = "session-1";
const SECOND_SESSION_ID = "session-2";
const SESSION_KEY = "agent:main:main";

type Harness = {
  agent: AcpGatewayAgent;
  connection: ReturnType<typeof createAcpConnection>;
  promptPromise: ReturnType<AcpGatewayAgent["prompt"]>;
  request: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
  runId: string;
  sessionStore: ReturnType<typeof createInMemorySessionStore>;
};

function createApprovalEvent(params: {
  approvalId?: string;
  runId: string;
  sessionKey?: string;
  toolCallId?: string;
}): EventFrame {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId: params.runId,
      sessionKey: params.sessionKey ?? SESSION_KEY,
      stream: "approval",
      data: {
        phase: "requested",
        kind: "exec",
        status: "pending",
        title: "Command approval requested",
        approvalId: params.approvalId ?? "approval-1",
        toolCallId: params.toolCallId,
        command: "echo event",
        host: "gateway",
      },
    },
  } as EventFrame;
}

function createApprovalRequestEvent(params: {
  approvalId?: string;
  sessionKey?: string;
  command?: string;
}): EventFrame {
  return {
    type: "event",
    event: "exec.approval.requested",
    payload: {
      id: params.approvalId ?? "approval-1",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        command: params.command ?? "echo raw",
        host: "gateway",
        sessionKey: params.sessionKey ?? SESSION_KEY,
      },
    },
  } as EventFrame;
}

async function createHarness(
  params: {
    allowedDecisions?: string[];
    requestPermission?: ReturnType<typeof vi.fn>;
    resolveApproval?: (requestParams?: Record<string, unknown>) => unknown;
  } = {},
): Promise<Harness> {
  let runId: string | undefined;
  const request = vi.fn(async (method: string, requestParams?: Record<string, unknown>) => {
    if (method === "chat.send") {
      runId = requestParams?.idempotencyKey as string | undefined;
      return { status: "started", runId };
    }
    if (method === "exec.approval.get") {
      return {
        id: requestParams?.id,
        commandText: "echo hydrated",
        allowedDecisions: params.allowedDecisions ?? ["allow-once", "allow-always", "deny"],
        host: "gateway",
      };
    }
    if (method === "exec.approval.resolve" && params.resolveApproval) {
      return params.resolveApproval(requestParams);
    }
    return {};
  }) as ReturnType<typeof vi.fn> & GatewayClient["request"];
  const requestPermission =
    params.requestPermission ??
    vi.fn(async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } }));
  const sessionStore = createInMemorySessionStore();
  sessionStore.createSession({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    cwd: "/tmp",
  });
  const connection = createAcpConnection({ requestPermission });
  const agent = new AcpGatewayAgent(connection, createAcpGateway(request), { sessionStore });
  const promptPromise = promptAgent(agent, SESSION_ID);

  await vi.waitFor(() => {
    if (!runId) {
      throw new Error("expected ACP permission relay run id");
    }
  });

  return {
    agent,
    connection,
    promptPromise,
    request,
    requestPermission,
    runId: runId!,
    sessionStore,
  };
}

async function cleanupHarness(harness: Harness): Promise<void> {
  await harness.agent.cancel({ sessionId: SESSION_ID } as CancelNotification);
  await harness.promptPromise;
  harness.sessionStore.clearAllSessionsForTest();
}

function approvalResolveCalls(request: ReturnType<typeof vi.fn>) {
  return request.mock.calls.filter(([method]) => method === "exec.approval.resolve");
}

function hasApprovalRelay(agent: AcpGatewayAgent, approvalId: string): boolean {
  const relayMap = (
    agent as unknown as {
      approvalRelays: Map<string, unknown>;
    }
  ).approvalRelays;
  return relayMap.has(approvalId);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value) {
    throw new Error("expected record");
  }
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function firstCallArg(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected mock call");
  }
  return requireRecord(call[0]);
}

function requestPermissionPayload(mock: ReturnType<typeof vi.fn>): {
  payload: Record<string, unknown>;
  toolCall: Record<string, unknown>;
  rawInput: Record<string, unknown>;
} {
  const payload = firstCallArg(mock);
  const toolCall = requireRecord(payload.toolCall);
  const rawInput = requireRecord(toolCall.rawInput);
  return { payload, toolCall, rawInput };
}

describe("ACP translator permission relay", () => {
  it.each([
    ["allow-once", "allow-once"],
    ["allow-always", "allow-always"],
    ["deny", "deny"],
  ])("relays selected %s decisions to Gateway approval resolution", async (optionId, decision) => {
    const harness = await createHarness({
      requestPermission: vi.fn(async () => ({
        outcome: { outcome: "selected", optionId },
      })),
    });

    await harness.agent.handleGatewayEvent(createApprovalEvent({ runId: harness.runId }));

    await vi.waitFor(() => {
      expect(harness.requestPermission).toHaveBeenCalledTimes(1);
      expect(approvalResolveCalls(harness.request)).toHaveLength(1);
    });

    const { payload, toolCall, rawInput } = requestPermissionPayload(harness.requestPermission);
    expect(payload.sessionId).toBe(SESSION_ID);
    expect(toolCall.toolCallId).toBe("exec:approval-1");
    expect(toolCall.kind).toBe("execute");
    expect(rawInput.name).toBe("exec");
    expect(rawInput.command).toBe("echo hydrated");
    expect(rawInput.approvalId).toBe("approval-1");
    expect(harness.request).toHaveBeenCalledWith("exec.approval.get", { id: "approval-1" });
    expect(harness.request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-1",
      decision,
    });

    await cleanupHarness(harness);
  });

  it("dedupes repeated approval events for the same approval id", async () => {
    const harness = await createHarness();
    const event = createApprovalEvent({ runId: harness.runId, approvalId: "approval-dup" });

    await harness.agent.handleGatewayEvent(event);
    await harness.agent.handleGatewayEvent(event);

    await vi.waitFor(() => {
      expect(harness.requestPermission).toHaveBeenCalledTimes(1);
      expect(approvalResolveCalls(harness.request)).toHaveLength(1);
    });

    await cleanupHarness(harness);
  });

  it("relays exec approval request events before the later agent approval event", async () => {
    const harness = await createHarness();
    const approvalId = "approval-raw";

    await harness.agent.handleGatewayEvent(
      createApprovalRequestEvent({ approvalId, command: "echo raw" }),
    );
    await harness.agent.handleGatewayEvent(
      createApprovalEvent({ runId: harness.runId, approvalId, toolCallId: "tool-late" }),
    );

    await vi.waitFor(() => {
      expect(harness.requestPermission).toHaveBeenCalledTimes(1);
      expect(approvalResolveCalls(harness.request)).toHaveLength(1);
    });

    const { toolCall, rawInput } = requestPermissionPayload(harness.requestPermission);
    expect(toolCall.toolCallId).toBe("exec:approval-raw");
    expect(rawInput.approvalId).toBe(approvalId);
    expect(rawInput.command).toBe("echo hydrated");
    expect(harness.request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: approvalId,
      decision: "allow-once",
    });

    await cleanupHarness(harness);
  });

  it("does not bind session-only approval events when multiple prompts share the session key", async () => {
    const runIds: string[] = [];
    const request = vi.fn(async (method: string, requestParams?: Record<string, unknown>) => {
      if (method === "chat.send") {
        const runId = requestParams?.idempotencyKey as string;
        runIds.push(runId);
        return { status: "started", runId };
      }
      if (method === "exec.approval.get") {
        return {
          id: requestParams?.id,
          commandText: "echo hydrated",
          allowedDecisions: ["allow-once", "deny"],
          host: "gateway",
        };
      }
      return {};
    }) as ReturnType<typeof vi.fn> & GatewayClient["request"];
    const requestPermission = vi.fn(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      cwd: "/tmp",
    });
    sessionStore.createSession({
      sessionId: SECOND_SESSION_ID,
      sessionKey: SESSION_KEY,
      cwd: "/tmp",
    });
    const connection = createAcpConnection({ requestPermission });
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), { sessionStore });
    const firstPrompt = promptAgent(agent, SESSION_ID, "first prompt");
    const secondPrompt = promptAgent(agent, SECOND_SESSION_ID, "second prompt");

    await vi.waitFor(() => {
      expect(runIds).toHaveLength(2);
    });

    const approvalId = "approval-shared";
    await agent.handleGatewayEvent(createApprovalRequestEvent({ approvalId }));

    expect(requestPermission).not.toHaveBeenCalled();
    expect(approvalResolveCalls(request)).toHaveLength(0);

    await agent.handleGatewayEvent(createApprovalEvent({ runId: runIds[1], approvalId }));

    await vi.waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(approvalResolveCalls(request)).toHaveLength(1);
    });

    expect(firstCallArg(requestPermission).sessionId).toBe(SECOND_SESSION_ID);
    expect(request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: approvalId,
      decision: "allow-once",
    });

    await agent.cancel({ sessionId: SESSION_ID } as CancelNotification);
    await agent.cancel({ sessionId: SECOND_SESSION_ID } as CancelNotification);
    await Promise.all([firstPrompt, secondPrompt]);
    sessionStore.clearAllSessionsForTest();
  });

  it("allows approval relay retry when Gateway resolution fails", async () => {
    const resolveApproval = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway not connected"))
      .mockResolvedValueOnce({});
    const harness = await createHarness({ resolveApproval });
    const event = createApprovalEvent({ runId: harness.runId, approvalId: "approval-retry" });

    await harness.agent.handleGatewayEvent(event);

    await vi.waitFor(() => {
      expect(harness.requestPermission).toHaveBeenCalledTimes(1);
      expect(resolveApproval).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(hasApprovalRelay(harness.agent, "approval-retry")).toBe(false);
    });

    await harness.agent.handleGatewayEvent(event);

    await vi.waitFor(() => {
      expect(harness.requestPermission).toHaveBeenCalledTimes(2);
      expect(resolveApproval).toHaveBeenCalledTimes(2);
    });
    expect(harness.request).toHaveBeenLastCalledWith("exec.approval.resolve", {
      id: "approval-retry",
      decision: "allow-once",
    });

    await cleanupHarness(harness);
  });

  it("ignores approval events outside the active ACP run", async () => {
    const harness = await createHarness();

    await harness.agent.handleGatewayEvent(
      createApprovalEvent({
        runId: "other-run",
        sessionKey: "agent:main:other",
      }),
    );

    expect(harness.requestPermission).not.toHaveBeenCalled();
    expect(approvalResolveCalls(harness.request)).toHaveLength(0);

    await cleanupHarness(harness);
  });

  it.each([
    { outcome: { outcome: "cancelled" } },
    { outcome: { outcome: "selected", optionId: "not-a-real-option" } },
  ])("denies cancelled and invalid ACP permission outcomes", async (outcome) => {
    const harness = await createHarness({
      requestPermission: vi.fn(async () => outcome),
    });

    await harness.agent.handleGatewayEvent(createApprovalEvent({ runId: harness.runId }));

    await vi.waitFor(() => {
      expect(harness.requestPermission).toHaveBeenCalledTimes(1);
      expect(harness.request).toHaveBeenCalledWith("exec.approval.resolve", {
        id: "approval-1",
        decision: "deny",
      });
    });

    await cleanupHarness(harness);
  });

  it("denies when the ACP client permission request throws", async () => {
    const harness = await createHarness({
      requestPermission: vi.fn(async () => {
        throw new Error("client closed");
      }),
    });

    await harness.agent.handleGatewayEvent(createApprovalEvent({ runId: harness.runId }));

    await vi.waitFor(() => {
      expect(harness.requestPermission).toHaveBeenCalledTimes(1);
      expect(harness.request).toHaveBeenCalledWith("exec.approval.resolve", {
        id: "approval-1",
        decision: "deny",
      });
    });

    await cleanupHarness(harness);
  });

  it("does not allow execution when the prompt is cancelled during client permission UI", async () => {
    let resolvePermission!: (value: unknown) => void;
    const harness = await createHarness({
      requestPermission: vi.fn(
        () =>
          new Promise((resolve) => {
            resolvePermission = resolve;
          }),
      ),
    });

    await harness.agent.handleGatewayEvent(createApprovalEvent({ runId: harness.runId }));
    await vi.waitFor(() => {
      expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    });

    await cleanupHarness(harness);
    resolvePermission({ outcome: { outcome: "selected", optionId: "allow-once" } });

    await vi.waitFor(() => {
      const decisions = approvalResolveCalls(harness.request).map(
        ([, params]) => (params as { decision?: string }).decision,
      );
      expect(decisions).toContain("deny");
      expect(decisions).not.toContain("allow-once");
    });
  });

  it("keeps existing tool streaming behavior unchanged", async () => {
    const harness = await createHarness();

    await harness.agent.handleGatewayEvent({
      type: "event",
      event: "agent",
      payload: {
        runId: harness.runId,
        sessionKey: SESSION_KEY,
        stream: "tool",
        data: {
          phase: "start",
          name: "exec",
          toolCallId: "tool-1",
          args: { command: "echo ok" },
        },
      },
    } as EventFrame);

    expect(harness.requestPermission).not.toHaveBeenCalled();
    const sessionUpdate = firstCallArg(harness.connection.__sessionUpdateMock);
    const update = requireRecord(sessionUpdate.update);
    expect(sessionUpdate.sessionId).toBe(SESSION_ID);
    expect(update.sessionUpdate).toBe("tool_call");
    expect(update.toolCallId).toBe("tool-1");
    expect(update.status).toBe("in_progress");

    await cleanupHarness(harness);
  });
});
