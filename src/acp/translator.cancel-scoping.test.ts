import type {
  AgentSideConnection,
  CancelNotification,
  PromptRequest,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
/** Tests prompt cancellation scoping across concurrent ACP sessions and Gateway runs. */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, type Mock, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

type Harness = {
  agent: AcpGatewayAgent;
  requestSpy: Mock<
    (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  >;
  sessionUpdateSpy: Mock<AgentSideConnection["sessionUpdate"]>;
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

function createHarness(
  sessions: Array<{ sessionId: string; sessionKey: string }>,
  options: { provenanceMode?: "meta" | "meta+receipt" } = {},
): Harness {
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
  const sessionUpdateSpy = vi.fn<AgentSideConnection["sessionUpdate"]>(async () => {});
  connection.sessionUpdate = sessionUpdateSpy;
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
    { sessionStore, ...options },
  );

  return {
    agent,
    requestSpy,
    sessionUpdateSpy,
    sessionStore,
    sentRunIds,
  };
}

function blockAcceptedPromptAbort(harness: Harness) {
  const firstSettlement = vi.fn();
  let releaseAbort: (() => void) | undefined;
  harness.requestSpy.mockImplementation(async (method, params) => {
    if (method === "chat.send") {
      const runId = expectDefined(
        params?.idempotencyKey as string | undefined,
        "accepted Gateway run id",
      );
      harness.sentRunIds.push(runId);
      return { runId, status: "started" };
    }
    if (method === "chat.abort") {
      expect(firstSettlement).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
    }
    return {};
  });
  return {
    observeFirstSettlement(promise: Promise<PromptResponse>) {
      void promise.then(firstSettlement);
    },
    async waitForAbort() {
      await vi.waitFor(() => {
        expect(releaseAbort).toBeDefined();
      });
    },
    releaseAbort() {
      expectDefined(releaseAbort, "blocked exact Gateway abort")();
    },
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
    runId: expectDefined(harness.sentRunIds[before], "harness.sentRunIds[before] test invariant"),
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
  it("aborts an accepted active prompt before settlement and replacement submission", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
    const blockedAbort = blockAcceptedPromptAbort(harness);
    const first = await startPendingPrompt(harness, "session-1");
    blockedAbort.observeFirstSettlement(first.promptPromise);

    const replacementPromise = harness.agent.prompt(createPromptRequest("session-1"));
    await blockedAbort.waitForAbort();

    expect(harness.requestSpy).toHaveBeenCalledWith("chat.abort", {
      sessionKey,
      runId: first.runId,
    });
    expect(harness.sentRunIds).toEqual([first.runId]);
    blockedAbort.releaseAbort();
    await vi.waitFor(() => {
      expect(harness.sentRunIds).toHaveLength(2);
    });
    const replacement = {
      promptPromise: replacementPromise,
      runId: expectDefined(harness.sentRunIds[1], "accepted replacement Gateway run id"),
    };

    expect(harness.requestSpy.mock.calls.map(([method]) => method)).toEqual([
      "chat.send",
      "chat.abort",
      "chat.send",
    ]);
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    expect(harness.sessionStore.getSession("session-1")?.activeRunId).toBe(replacement.runId);

    await deliverFinalChatEventAndExpectEndTurn(harness, sessionKey, replacement, 1);
  });

  it.each([
    {
      closure: "cancel",
      close: (harness: Harness) => harness.agent.cancel({ sessionId: "session-1" }),
    },
    {
      closure: "closeSession",
      close: (harness: Harness) =>
        harness.agent.closeSession({ sessionId: "session-1", _meta: {} }),
    },
    {
      closure: "shutdown",
      close: (harness: Harness) => harness.agent.shutdown(),
    },
  ])(
    "does not submit a replacement closed by $closure while its prior abort is pending",
    async ({ close, closure }) => {
      const sessionKey = "agent:main:shared";
      const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
      const first = await startPendingPrompt(harness, "session-1");
      let releaseAbort: (() => void) | undefined;
      harness.requestSpy.mockImplementationOnce(async (method: string) => {
        expect(method).toBe("chat.abort");
        await new Promise<void>((resolve) => {
          releaseAbort = resolve;
        });
        return {};
      });

      const replacement = harness.agent.prompt(createPromptRequest("session-1"));
      await vi.waitFor(() => {
        expect(releaseAbort).toBeDefined();
      });
      const closed = close(harness);

      expect(harness.sentRunIds).toEqual([first.runId]);
      expectDefined(releaseAbort, `${closure} owns the blocked prior abort`)();
      await closed;
      await Promise.resolve();

      expect(harness.sentRunIds).toEqual([first.runId]);
      await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
      await expect(replacement).resolves.toEqual({ stopReason: "cancelled" });
      expect(harness.sessionStore.getSession("session-1")?.activeRunId).not.toBeTruthy();
    },
  );

  it("settles shutdown when a superseded prompt's abort never returns", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
    const first = await startPendingPrompt(harness, "session-1");
    harness.requestSpy.mockImplementationOnce(async (method: string) => {
      expect(method).toBe("chat.abort");
      return await new Promise<Record<string, unknown>>(() => {});
    });

    const replacement = harness.agent.prompt(createPromptRequest("session-1"));
    await vi.waitFor(() => {
      expect(harness.requestSpy).toHaveBeenCalledWith("chat.abort", {
        sessionKey,
        runId: first.runId,
      });
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const shutdownResult = await Promise.race([
      harness.agent.shutdown().then(() => "closed" as const),
      new Promise<"still pending">((resolve) => {
        timeout = setTimeout(() => resolve("still pending"), 25);
      }),
    ]);
    clearTimeout(timeout);

    expect(shutdownResult).toBe("closed");
    expect(harness.sentRunIds).toEqual([first.runId]);
    await expect(replacement).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("closes an admitted prompt when shutdown interrupts its blocked final snapshot", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
    let releaseSnapshot: (() => void) | undefined;
    harness.requestSpy.mockImplementation(async (method, params) => {
      if (method === "chat.send") {
        const runId = expectDefined(
          params?.idempotencyKey as string | undefined,
          "accepted terminal Gateway run id",
        );
        harness.sentRunIds.push(runId);
        return { runId, status: "started" };
      }
      if (method === "sessions.list") {
        return await new Promise<Record<string, unknown>>((resolve) => {
          releaseSnapshot = () => resolve({ sessions: [] });
        });
      }
      return {};
    });
    const pending = await startPendingPrompt(harness, "session-1");
    const terminalEvent = harness.agent.handleGatewayEvent(
      createChatEvent({ runId: pending.runId, sessionKey, seq: 1, state: "final" }),
    );
    await vi.waitFor(() => {
      expect(releaseSnapshot).toBeDefined();
    });

    const shutdownSettled = vi.fn();
    const shutdown = harness.agent.shutdown().then(shutdownSettled);
    try {
      await vi.waitFor(() => {
        expect(shutdownSettled).toHaveBeenCalledOnce();
      });
      await expect(pending.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    } finally {
      expectDefined(releaseSnapshot, "blocked terminal session snapshot")();
      await terminalEvent;
      await shutdown;
    }
  });

  it("closes every queued overlapping admission when cancellation wins the blocked abort", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
    const first = await startPendingPrompt(harness, "session-1");
    let releaseAbort: (() => void) | undefined;
    harness.requestSpy.mockImplementationOnce(async (method: string) => {
      expect(method).toBe("chat.abort");
      await new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      return {};
    });

    const second = harness.agent.prompt(createPromptRequest("session-1"));
    await vi.waitFor(() => {
      expect(releaseAbort).toBeDefined();
    });
    const third = harness.agent.prompt(createPromptRequest("session-1"));
    const cancellation = harness.agent.cancel({ sessionId: "session-1" });

    expectDefined(releaseAbort, "blocked prior abort")();
    await cancellation;
    await Promise.resolve();

    expect(harness.sentRunIds).toEqual([first.runId]);
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    await expect(third).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("submits only the latest of three overlapping prompts after the active abort settles", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
    const blockedAbort = blockAcceptedPromptAbort(harness);
    const first = await startPendingPrompt(harness, "session-1");
    blockedAbort.observeFirstSettlement(first.promptPromise);

    const secondPrompt = harness.agent.prompt({
      ...createPromptRequest("session-1"),
      prompt: [{ type: "text", text: "second" }],
    });
    await blockedAbort.waitForAbort();
    const thirdPrompt = harness.agent.prompt({
      ...createPromptRequest("session-1"),
      prompt: [{ type: "text", text: "third" }],
    });
    await Promise.resolve();
    expect(harness.sentRunIds).toEqual([first.runId]);

    blockedAbort.releaseAbort();
    await vi.waitFor(() => {
      const sendCalls = harness.requestSpy.mock.calls.filter(([method]) => method === "chat.send");
      expect(sendCalls.at(-1)?.[1]?.message).toContain("third");
    });

    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    await expect(secondPrompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(harness.sentRunIds).toHaveLength(2);
    expect(
      harness.requestSpy.mock.calls
        .filter(([method]) => method === "chat.send")
        .map(([, params]) => params?.message),
    ).toEqual(["[Working directory: /tmp]\n\nhello", "[Working directory: /tmp]\n\nthird"]);
    const thirdRunId = expectDefined(
      harness.sentRunIds[1],
      "third prompt remains the final admitted run",
    );
    expect(harness.sessionStore.getSession("session-1")?.activeRunId).toBe(thirdRunId);
    await deliverFinalChatEventAndExpectEndTurn(
      harness,
      sessionKey,
      { promptPromise: thirdPrompt, runId: thirdRunId },
      1,
    );
  });

  it("does not replay a superseded prompt after its delayed provenance rejection", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }], {
      provenanceMode: "meta",
    });
    let rejectFirstSend: ((error: Error) => void) | undefined;
    harness.requestSpy.mockImplementation(async (method, params) => {
      if (method !== "chat.send") {
        return {};
      }
      const runId = params?.idempotencyKey;
      if (typeof runId === "string") {
        harness.sentRunIds.push(runId);
      }
      if (harness.sentRunIds.length === 1) {
        return await new Promise<Record<string, unknown>>((_, reject) => {
          rejectFirstSend = reject;
        });
      }
      return await new Promise<Record<string, unknown>>(() => {});
    });
    const first = await startPendingPrompt(harness, "session-1");
    const replacement = await startPendingPrompt(harness, "session-1");
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });

    expectDefined(
      rejectFirstSend,
      "blocked first chat.send request",
    )(
      Object.assign(new Error("system provenance fields require admin scope"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      }),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(harness.sentRunIds).toEqual([first.runId, replacement.runId]);
    expect(harness.sessionStore.getSession("session-1")?.activeRunId).toBe(replacement.runId);
    await deliverFinalChatEventAndExpectEndTurn(harness, sessionKey, replacement, 1);
  });

  it("does not let a stale final event clear a replacement admitted during client delivery", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
    const first = await startPendingPrompt(harness, "session-1");
    let releaseDelivery: (() => void) | undefined;
    harness.sessionUpdateSpy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseDelivery = resolve;
        }),
    );

    const staleFinal = harness.agent.handleGatewayEvent(
      createChatEvent({
        runId: first.runId,
        sessionKey,
        seq: 1,
        state: "final",
        message: { content: [{ type: "text", text: "old response" }] },
      }),
    );
    await vi.waitFor(() => {
      expect(releaseDelivery).toBeDefined();
    });

    const replacement = await startPendingPrompt(harness, "session-1");
    expectDefined(releaseDelivery, "blocked session-update delivery")();
    await staleFinal;

    expect(harness.sessionStore.getSession("session-1")?.activeRunId).toBe(replacement.runId);
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    await deliverFinalChatEventAndExpectEndTurn(harness, sessionKey, replacement, 2);
  });

  it("does not let a stale cancel completion remove a newer prompt", async () => {
    const sessionKey = "agent:main:shared";
    const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
    const first = await startPendingPrompt(harness, "session-1");
    let releaseAbort: (() => void) | undefined;
    harness.requestSpy.mockImplementationOnce(async (method: string) => {
      expect(method).toBe("chat.abort");
      await new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      return {};
    });

    const cancellation = harness.agent.cancel({ sessionId: "session-1" } as CancelNotification);
    await vi.waitFor(() => {
      expect(releaseAbort).toBeDefined();
    });
    const replacement = await startPendingPrompt(harness, "session-1");

    expectDefined(releaseAbort, "blocked chat.abort request")();
    await cancellation;
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    expect(harness.sessionStore.getSession("session-1")?.activeRunId).toBe(replacement.runId);

    await harness.agent.handleGatewayEvent(
      createChatEvent({
        runId: replacement.runId,
        sessionKey,
        seq: 1,
        state: "final",
      }),
    );
    await expect(
      Promise.race([replacement.promptPromise, Promise.resolve("still pending")]),
    ).resolves.toEqual({ stopReason: "end_turn" });
  });

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

  it.each(["delta", "final"] as const)(
    "drops stale text from a mixed %s snapshot after replacement during thought delivery",
    async (state) => {
      const sessionKey = "agent:main:shared";
      const harness = createHarness([{ sessionId: "session-1", sessionKey }]);
      const first = await startPendingPrompt(harness, "session-1");
      let releaseThought: (() => void) | undefined;
      harness.sessionUpdateSpy.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseThought = resolve;
          }),
      );

      const staleSnapshot = harness.agent.handleGatewayEvent(
        createChatEvent({
          runId: first.runId,
          sessionKey,
          seq: 1,
          state,
          message: {
            content: [
              { type: "thinking", thinking: "old hidden thought" },
              { type: "text", text: "old visible response" },
            ],
          },
        }),
      );
      await vi.waitFor(() => {
        expect(releaseThought).toBeDefined();
      });

      const replacement = await startPendingPrompt(harness, "session-1");
      expectDefined(releaseThought, "blocked stale thought delivery")();
      await staleSnapshot;

      const visibleChunks = harness.sessionUpdateSpy.mock.calls.filter(
        ([payload]) => payload.update.sessionUpdate === "agent_message_chunk",
      );
      expect(visibleChunks).toEqual([]);
      expect(harness.sessionStore.getSession("session-1")?.activeRunId).toBe(replacement.runId);
      await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
      await deliverFinalChatEventAndExpectEndTurn(harness, sessionKey, replacement, 2);
    },
  );

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
