import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createInMemoryAcpEventLedger } from "./event-ledger.js";
import { AcpGatewayAgent } from "./translator.js";
import { createChatEvent, promptAgent } from "./translator.prompt-harness.test-support.js";
import type { AcpAgentWaitResult } from "./translator.prompt-state.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

async function createReconnectHarness(result: AcpAgentWaitResult) {
  const sessionId = "session-1";
  const sessionKey = "agent:main:main";
  const sessionStore = createInMemorySessionStore();
  sessionStore.createSession({ sessionId, sessionKey, cwd: "/tmp" });
  const eventLedger = createInMemoryAcpEventLedger();
  await eventLedger.startSession({ sessionId, sessionKey, cwd: "/tmp", complete: true });
  const connection = createAcpConnection();
  let runId: string | undefined;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "chat.send") {
      runId = typeof params?.idempotencyKey === "string" ? params.idempotencyKey : undefined;
    }
    return method === "agent.wait" ? result : {};
  }) as GatewayClient["request"];
  const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
    eventLedger,
    sessionStore,
  });
  const promptPromise = promptAgent(agent, sessionId);
  promptPromise.catch(() => {});
  await vi.waitFor(() => expect(runId).toBeTypeOf("string"));

  return {
    agent,
    connection,
    eventLedger,
    promptPromise,
    runId: runId as string,
    sessionId,
    sessionKey,
  };
}

async function streamText(
  harness: Awaited<ReturnType<typeof createReconnectHarness>>,
  text: string,
) {
  await harness.agent.handleGatewayEvent(
    createChatEvent({
      runId: harness.runId,
      sessionKey: harness.sessionKey,
      seq: 1,
      state: "delta",
      message: { content: [{ type: "text", text }] },
    }),
  );
}

function reconnect(harness: Awaited<ReturnType<typeof createReconnectHarness>>) {
  harness.agent.handleGatewayDisconnect("1006: connection lost");
  harness.agent.handleGatewayReconnect();
}

function messageChunks(harness: Awaited<ReturnType<typeof createReconnectHarness>>) {
  return harness.connection["__sessionUpdateMock"].mock.calls.flatMap(([notification]) => {
    const update = notification.update;
    return update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
      ? [update.content.text]
      : [];
  });
}

describe("acp translator reconnect settlement", () => {
  it.each([
    {
      name: "full reply",
      result: {
        status: "ok",
        terminalReply: { disposition: "visible", text: "final answer" },
      } satisfies AcpAgentWaitResult,
      streamed: undefined,
      recovered: "final answer",
    },
    {
      name: "sticky timeout suffix",
      result: {
        status: "timeout",
        terminalReply: { disposition: "visible", text: "final answer" },
      } satisfies AcpAgentWaitResult,
      streamed: "final",
      recovered: " answer",
    },
    {
      name: "trim-normalized suffix",
      result: {
        status: "ok",
        terminalReply: { disposition: "visible", text: "final answer" },
      } satisfies AcpAgentWaitResult,
      streamed: " final",
      recovered: " answer",
    },
  ])("recovers the $name before resolving", async ({ result, streamed, recovered }) => {
    const harness = await createReconnectHarness(result);
    if (streamed) {
      await streamText(harness, streamed);
    }

    reconnect(harness);

    await expect(harness.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    expect(messageChunks(harness).filter((text) => text === recovered)).toHaveLength(1);
    const replay = await harness.eventLedger.readReplay({
      sessionId: harness.sessionId,
      sessionKey: harness.sessionKey,
    });
    expect(
      replay.events.some(
        (event) =>
          event.update.sessionUpdate === "agent_message_chunk" &&
          event.update.content.type === "text" &&
          event.update.content.text === recovered,
      ),
    ).toBe(true);
  });

  it("recovers visible text before rejecting a failed run", async () => {
    const harness = await createReconnectHarness({
      status: "error",
      error: "boom",
      terminalReply: { disposition: "visible", text: "final answer" },
    });

    reconnect(harness);

    await expect(harness.promptPromise).rejects.toThrow("boom");
    expect(messageChunks(harness)).toEqual(["final answer", "[OpenClaw interruption] boom"]);
  });

  it("claims recovery before a late final event can emit the suffix twice", async () => {
    const harness = await createReconnectHarness({
      status: "ok",
      terminalReply: { disposition: "visible", text: "final answer" },
    });
    await streamText(harness, "final");
    let releaseRecord!: () => void;
    const recordBlocked = new Promise<void>((resolve) => {
      releaseRecord = resolve;
    });
    const recordUpdate = harness.eventLedger.recordUpdate.bind(harness.eventLedger);
    harness.eventLedger.recordUpdate = async (params) => {
      if (
        params.update.sessionUpdate === "agent_message_chunk" &&
        params.update.content.type === "text" &&
        params.update.content.text === " answer"
      ) {
        await recordBlocked;
      }
      await recordUpdate(params);
    };

    reconnect(harness);
    await vi.waitFor(() => expect(messageChunks(harness)).toContain(" answer"));
    const lateFinal = harness.agent.handleGatewayEvent(
      createChatEvent({
        runId: harness.runId,
        sessionKey: harness.sessionKey,
        seq: 2,
        state: "final",
        message: { content: [{ type: "text", text: "final answer" }] },
      }),
    );
    releaseRecord();
    await lateFinal;

    await expect(harness.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    expect(messageChunks(harness).filter((text) => text === " answer")).toHaveLength(1);
  });

  it("settles after recovered update delivery rejects", async () => {
    const harness = await createReconnectHarness({
      status: "ok",
      terminalReply: { disposition: "visible", text: "final answer" },
    });
    harness.connection.sessionUpdate = vi.fn(async () => {
      throw new Error("client gone");
    }) as typeof harness.connection.sessionUpdate;

    reconnect(harness);

    await expect(harness.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    const replay = await harness.eventLedger.readReplay({
      sessionId: harness.sessionId,
      sessionKey: harness.sessionKey,
    });
    expect(
      replay.events.some(
        (event) =>
          event.update.sessionUpdate === "agent_message_chunk" &&
          event.update.content.type === "text" &&
          event.update.content.text === "final answer",
      ),
    ).toBe(true);
  });
});
