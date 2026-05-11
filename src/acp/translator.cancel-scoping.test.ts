import type { CancelNotification, PromptRequest, PromptResponse } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

type Harness = {
  agent: AcpGatewayAgent;
  requestSpy: ReturnType<typeof vi.fn>;
  sessionUpdateSpy: ReturnType<typeof vi.fn>;
  sessionStore: ReturnType<typeof createInMemorySessionStore>;
  sentRunIds: string[];
};

type SessionUpdatePayload = {
  sessionId?: string;
  update?: {
    sessionUpdate?: string;
    content?: unknown;
    toolCallId?: string;
    status?: string;
  };
};

function createPromptRequest(sessionId: string): PromptRequest {
  return {
    sessionId,
    prompt: [{ type: "text", text: "hello" }],
    _meta: {},
  } as unknown as PromptRequest;
}

function createChatEvent(payload: Record<string, unknown>): EventFrame {
  return {
    type: "event",
    event: "chat",
    payload,
  } as EventFrame;
}

function createToolEvent(payload: Record<string, unknown>): EventFrame {
  return {
    type: "event",
    event: "agent",
    payload,
  } as EventFrame;
}

function createHarness(sessions: Array<{ sessionId: string; sessionKey: string }>): Harness {
  const sentRunIds: string[] = [];
  const requestSpy = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "chat.send") {
      const runId = params?.idempotencyKey;
      if (typeof runId === "string") {
        sentRunIds.push(runId);
      }
      return new Promise<never>(() => {});
    }
    return {};
  });
  const connection = createAcpConnection();
  const sessionStore = createInMemorySessionStore();
  for (const session of sessions) {
    sessionStore.createSession({
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      cwd: "/tmp",
    });
  }

  const agent = new AcpGatewayAgent(
    connection,
    createAcpGateway(requestSpy as unknown as GatewayClient["request"]),
    { sessionStore },
  );

  return {
    agent,
    requestSpy,
    sessionUpdateSpy: connection.sessionUpdate as unknown as ReturnType<typeof vi.fn>,
    sessionStore,
    sentRunIds,
  };
}

async function startPendingPrompt(
  harness: Harness,
  sessionId: string,
): Promise<{ promptPromise: Promise<PromptResponse>; runId: string }> {
  const before = harness.sentRunIds.length;
  const promptPromise = harness.agent.prompt(createPromptRequest(sessionId));
  await vi.waitFor(() => {
    expect(harness.sentRunIds.length).toBe(before + 1);
  });
  return {
    promptPromise,
    runId: harness.sentRunIds[before],
  };
}

async function cancelAndExpectAbortForPendingRun(
  harness: Harness,
  sessionId: string,
  sessionKey: string,
  pending: { promptPromise: Promise<PromptResponse>; runId: string },
) {
  await harness.agent.cancel({ sessionId } as CancelNotification);

  expect(harness.requestSpy).toHaveBeenCalledWith("chat.abort", {
    sessionKey,
    runId: pending.runId,
  });
  await expect(pending.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
}

async function deliverFinalChatEventAndExpectEndTurn(
  harness: Harness,
  sessionKey: string,
  pending: { promptPromise: Promise<PromptResponse>; runId: string },
  seq: number,
) {
  await harness.agent.handleGatewayEvent(
    createChatEvent({
      runId: pending.runId,
      sessionKey,
      seq,
      state: "final",
    }),
  );
  await expect(pending.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
}

function sessionUpdatePayloadAt(harness: Harness, index: number): SessionUpdatePayload {
  const [payload] = harness.sessionUpdateSpy.mock.calls[index] ?? [];
  if (!payload) {
    throw new Error(`expected session update call ${index + 1}`);
  }
  return payload as SessionUpdatePayload;
}

describe("acp translator cancel and run scoping", () => {
  it("cancel passes active runId to chat.abort", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
    const pending = await startPendingPrompt(harness, "session-1");

    await cancelAndExpectAbortForPendingRun(harness, "session-1", sessionKey, pending);
  });

  it("cancel uses pending runId when there is no active run", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
    const pending = await startPendingPrompt(harness, "session-1");
    harness.sessionStore.clearActiveRun("session-1");

    await cancelAndExpectAbortForPendingRun(harness, "session-1", sessionKey, pending);
  });

  it("cancel skips chat.abort when there is no active run and no pending prompt", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }]);

    await harness.agent.cancel({ sessionId: "session-1" } as CancelNotification);

    const abortCalls = harness.requestSpy.mock.calls.filter(([method]) => method === "chat.abort");
    expect(abortCalls).toHaveLength(0);
  });

  it("cancel from a session without active run does not abort another session sharing the same key", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([
      { sessionId: "session-1", sessionKey },
      { sessionId: "session-2", sessionKey },
    ]);
    const pending2 = await startPendingPrompt(harness, "session-2");

    await harness.agent.cancel({ sessionId: "session-1" } as CancelNotification);

    const abortCalls = harness.requestSpy.mock.calls.filter(([method]) => method === "chat.abort");
    expect(abortCalls).toHaveLength(0);
    expect(harness.sessionStore.getSession("session-2")?.activeRunId).toBe(pending2.runId);

    await deliverFinalChatEventAndExpectEndTurn(harness, sessionKey, pending2, 1);
  });

  it("drops chat events when runId does not match the active prompt", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
    const pending = await startPendingPrompt(harness, "session-1");

    await harness.agent.handleGatewayEvent(
      createChatEvent({
        runId: "run-other",
        sessionKey,
        seq: 1,
        state: "final",
      }),
    );
    expect(harness.sessionStore.getSession("session-1")?.activeRunId).toBe(pending.runId);

    await harness.agent.handleGatewayEvent(
      createChatEvent({
        runId: pending.runId,
        sessionKey,
        seq: 2,
        state: "final",
      }),
    );
    await expect(pending.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("projects gateway thinking blocks into hidden ACP thought chunks", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
    const pending = await startPendingPrompt(harness, "session-1");
    harness.sessionUpdateSpy.mockClear();

    await harness.agent.handleGatewayEvent(
      createChatEvent({
        runId: pending.runId,
        sessionKey,
        seq: 1,
        state: "delta",
        message: {
          content: [
            { type: "thinking", thinking: "Internal loop about NO_REPLY" },
            { type: "text", text: "Final visible reply" },
          ],
        },
      }),
    );

    const thoughtPayload = sessionUpdatePayloadAt(harness, 0);
    expect(thoughtPayload.sessionId).toBe("session-1");
    expect(thoughtPayload.update?.sessionUpdate).toBe("agent_thought_chunk");
    expect(thoughtPayload.update?.content).toEqual({
      type: "text",
      text: "Internal loop about NO_REPLY",
    });

    const messagePayload = sessionUpdatePayloadAt(harness, 1);
    expect(messagePayload.sessionId).toBe("session-1");
    expect(messagePayload.update?.sessionUpdate).toBe("agent_message_chunk");
    expect(messagePayload.update?.content).toEqual({
      type: "text",
      text: "Final visible reply",
    });
  });

  it("drops tool events when runId does not match the active prompt", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
    const pending = await startPendingPrompt(harness, "session-1");
    harness.sessionUpdateSpy.mockClear();

    await harness.agent.handleGatewayEvent(
      createToolEvent({
        runId: "run-other",
        sessionKey,
        stream: "tool",
        data: {
          phase: "start",
          name: "read_file",
          toolCallId: "tool-1",
          args: { path: "README.md" },
        },
      }),
    );

    expect(harness.sessionUpdateSpy).not.toHaveBeenCalled();

    await harness.agent.handleGatewayEvent(
      createChatEvent({
        runId: pending.runId,
        sessionKey,
        seq: 1,
        state: "final",
      }),
    );
    await expect(pending.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("routes events to the pending prompt that matches runId when session keys are shared", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([
      { sessionId: "session-1", sessionKey },
      { sessionId: "session-2", sessionKey },
    ]);
    const pending1 = await startPendingPrompt(harness, "session-1");
    const pending2 = await startPendingPrompt(harness, "session-2");
    harness.sessionUpdateSpy.mockClear();

    await harness.agent.handleGatewayEvent(
      createToolEvent({
        runId: pending2.runId,
        sessionKey,
        stream: "tool",
        data: {
          phase: "start",
          name: "read_file",
          toolCallId: "tool-2",
          args: { path: "notes.txt" },
        },
      }),
    );
    expect(harness.sessionUpdateSpy).toHaveBeenCalledTimes(1);
    const toolPayload = sessionUpdatePayloadAt(harness, 0);
    expect(toolPayload.sessionId).toBe("session-2");
    expect(toolPayload.update?.sessionUpdate).toBe("tool_call");
    expect(toolPayload.update?.toolCallId).toBe("tool-2");
    expect(toolPayload.update?.status).toBe("in_progress");

    await deliverFinalChatEventAndExpectEndTurn(harness, sessionKey, pending2, 1);
    expect(harness.sessionStore.getSession("session-1")?.activeRunId).toBe(pending1.runId);

    await harness.agent.handleGatewayEvent(
      createChatEvent({
        runId: pending1.runId,
        sessionKey,
        seq: 2,
        state: "final",
      }),
    );
    await expect(pending1.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });
});
