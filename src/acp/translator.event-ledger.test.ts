import type {
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { createInMemoryAcpEventLedger, type AcpEventLedger } from "./event-ledger.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

function createNewSessionRequest(cwd = "/tmp"): NewSessionRequest {
  return {
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as NewSessionRequest;
}

function createLoadSessionRequest(sessionId: string, cwd = "/tmp"): LoadSessionRequest {
  return {
    sessionId,
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as LoadSessionRequest;
}

function createPromptRequest(sessionId: string, text: string): PromptRequest {
  return {
    sessionId,
    prompt: [{ type: "text", text }],
    _meta: {},
  } as unknown as PromptRequest;
}

function createToolEvent(params: {
  sessionKey: string;
  runId: string;
  phase: "start" | "result";
  toolCallId: string;
}): EventFrame {
  return {
    event: "agent",
    payload: {
      sessionKey: params.sessionKey,
      runId: params.runId,
      stream: "tool",
      data: {
        phase: params.phase,
        toolCallId: params.toolCallId,
        name: "read",
        args: { path: "src/app.ts" },
        result: { content: [{ type: "text", text: "FILE:src/app.ts" }] },
      },
    },
  } as unknown as EventFrame;
}

function createChatEvent(params: {
  sessionKey: string;
  runId: string;
  state: "delta" | "final";
  text: string;
}): EventFrame {
  return {
    event: "chat",
    payload: {
      sessionKey: params.sessionKey,
      runId: params.runId,
      state: params.state,
      message: {
        content: [{ type: "text", text: params.text }],
      },
    },
  } as unknown as EventFrame;
}

async function waitForChatSend(requestMock: { mock: { calls: Array<readonly unknown[]> } }) {
  await vi.waitFor(() =>
    expect(requestMock.mock.calls.some((call) => call[0] === "chat.send")).toBe(true),
  );
}

describe("ACP translator event ledger replay", () => {
  it("loads complete ledger-backed sessions without the lossy Gateway transcript fallback", async () => {
    const eventLedger = createInMemoryAcpEventLedger();
    const firstSessionStore = createInMemorySessionStore();
    const firstConnection = createAcpConnection();
    const firstRequestMock = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { ok: true };
      }
      return { ok: true };
    });
    const firstRequest = firstRequestMock as GatewayClient["request"];
    const firstAgent = new AcpGatewayAgent(firstConnection, createAcpGateway(firstRequest), {
      eventLedger,
      sessionStore: firstSessionStore,
    });

    const created = await firstAgent.newSession(createNewSessionRequest());
    const firstSession = firstSessionStore.getSession(created.sessionId);
    if (!firstSession) {
      throw new Error("Expected new ACP session to be stored");
    }
    firstConnection.__sessionUpdateMock.mockClear();

    const promptPromise = firstAgent.prompt(createPromptRequest(created.sessionId, "Question"));
    await waitForChatSend(firstRequestMock);
    const runId = firstSessionStore.getSession(created.sessionId)?.activeRunId;
    if (!runId) {
      throw new Error("Expected active ACP run");
    }

    await firstAgent.handleGatewayEvent(
      createToolEvent({
        sessionKey: firstSession.sessionKey,
        runId,
        phase: "start",
        toolCallId: "tool-1",
      }),
    );
    await firstAgent.handleGatewayEvent(
      createToolEvent({
        sessionKey: firstSession.sessionKey,
        runId,
        phase: "result",
        toolCallId: "tool-1",
      }),
    );
    await firstAgent.handleGatewayEvent(
      createChatEvent({
        sessionKey: firstSession.sessionKey,
        runId,
        state: "delta",
        text: "Answer",
      }),
    );
    await firstAgent.handleGatewayEvent(
      createChatEvent({
        sessionKey: firstSession.sessionKey,
        runId,
        state: "final",
        text: "Answer",
      }),
    );
    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });

    const secondConnection = createAcpConnection();
    const secondRequestMock = vi.fn(async (method: string) => {
      if (method === "sessions.get") {
        throw new Error("ledger replay should not call sessions.get");
      }
      return { ok: true };
    });
    const secondRequest = secondRequestMock as GatewayClient["request"];
    const secondAgent = new AcpGatewayAgent(secondConnection, createAcpGateway(secondRequest), {
      eventLedger,
      sessionStore: createInMemorySessionStore(),
    });

    await secondAgent.loadSession(createLoadSessionRequest(created.sessionId));

    expect(secondRequestMock.mock.calls.map((call) => call[0])).not.toContain("sessions.get");
    const replayedUpdates = secondConnection.__sessionUpdateMock.mock.calls.map(
      (call) => call[0]?.update,
    );
    const replayedUpdateTypes = replayedUpdates.map((update) => update?.sessionUpdate);
    expect(replayedUpdateTypes).toEqual([
      "session_info_update",
      "available_commands_update",
      "user_message_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "session_info_update",
      "session_info_update",
      "available_commands_update",
    ]);
    expect(replayedUpdates[2]).toEqual({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Question" },
    });
    expect(replayedUpdates[5]).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Answer" },
    });
    expect(replayedUpdateTypes.indexOf("user_message_chunk")).toBeLessThan(
      replayedUpdateTypes.indexOf("agent_message_chunk"),
    );

    const ledgerReplay = await eventLedger.readReplay({
      sessionId: created.sessionId,
      sessionKey: firstSession.sessionKey,
    });
    expect(
      ledgerReplay.events.filter((event) => event.update.sessionUpdate === "user_message_chunk"),
    ).toHaveLength(1);

    const listedSessionStore = createInMemorySessionStore();
    const listedConnection = createAcpConnection();
    const listedRequestMock = vi.fn(async (method: string) => {
      if (method === "sessions.get") {
        throw new Error("listed session ledger replay should not call sessions.get");
      }
      return { ok: true };
    });
    const listedAgent = new AcpGatewayAgent(
      listedConnection,
      createAcpGateway(listedRequestMock as GatewayClient["request"]),
      {
        eventLedger,
        sessionStore: listedSessionStore,
      },
    );

    await listedAgent.loadSession(createLoadSessionRequest(firstSession.sessionKey));

    expect(listedRequestMock.mock.calls.map((call) => call[0])).not.toContain("sessions.get");
    const listedReplayTypes = listedConnection.__sessionUpdateMock.mock.calls.map(
      (call) => call[0]?.update?.sessionUpdate,
    );
    expect(listedReplayTypes).toEqual([
      "session_info_update",
      "available_commands_update",
      "user_message_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "session_info_update",
      "session_info_update",
      "available_commands_update",
    ]);

    const listedPrompt = listedAgent.prompt(
      createPromptRequest(firstSession.sessionKey, "Follow-up"),
    );
    await waitForChatSend(listedRequestMock);
    const listedRunId = listedSessionStore.getSession(firstSession.sessionKey)?.activeRunId;
    if (!listedRunId) {
      throw new Error("Expected listed ACP session to have an active run");
    }
    await listedAgent.handleGatewayEvent(
      createChatEvent({
        sessionKey: firstSession.sessionKey,
        runId: listedRunId,
        state: "final",
        text: "Follow-up answer",
      }),
    );
    await expect(listedPrompt).resolves.toEqual({ stopReason: "end_turn" });

    const canonicalReplay = await eventLedger.readReplay({
      sessionId: created.sessionId,
      sessionKey: firstSession.sessionKey,
    });
    expect(
      canonicalReplay.events.filter((event) => event.update.sessionUpdate === "user_message_chunk"),
    ).toHaveLength(2);
    await expect(
      eventLedger.readReplayBySessionId({ sessionId: firstSession.sessionKey }),
    ).resolves.toEqual({ complete: false, events: [] });

    firstSessionStore.clearAllSessionsForTest();
  });

  it("does not replay prompts that Gateway rejected before accepting the send", async () => {
    const eventLedger = createInMemoryAcpEventLedger();
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const requestMock = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        throw new Error("send failed before acceptance");
      }
      return { ok: true };
    });
    const agent = new AcpGatewayAgent(
      connection,
      createAcpGateway(requestMock as GatewayClient["request"]),
      {
        eventLedger,
        sessionStore,
      },
    );

    const created = await agent.newSession(createNewSessionRequest());
    const session = sessionStore.getSession(created.sessionId);
    if (!session) {
      throw new Error("Expected new ACP session to be stored");
    }

    await expect(
      agent.prompt(createPromptRequest(created.sessionId, "Never accepted")),
    ).rejects.toThrow("send failed before acceptance");

    const replay = await eventLedger.readReplay({
      sessionId: created.sessionId,
      sessionKey: session.sessionKey,
    });
    expect(replay.events.map((event) => event.update.sessionUpdate)).not.toContain(
      "user_message_chunk",
    );

    const loadConnection = createAcpConnection();
    const loadRequestMock = vi.fn(async (method: string) => {
      if (method === "sessions.get") {
        throw new Error("ledger replay should not call sessions.get");
      }
      return { ok: true };
    });
    const loadAgent = new AcpGatewayAgent(
      loadConnection,
      createAcpGateway(loadRequestMock as GatewayClient["request"]),
      {
        eventLedger,
        sessionStore: createInMemorySessionStore(),
      },
    );

    await loadAgent.loadSession(createLoadSessionRequest(created.sessionId));

    const replayedUpdates = loadConnection.__sessionUpdateMock.mock.calls.map(
      (call) => call[0]?.update?.sessionUpdate,
    );
    expect(replayedUpdates).not.toContain("user_message_chunk");
  });

  it("marks replay incomplete when an accepted prompt cannot be recorded", async () => {
    const innerLedger = createInMemoryAcpEventLedger();
    let markIncompleteResolve: ((value: unknown) => void) | undefined;
    const markIncompletePromise = new Promise((resolve) => {
      markIncompleteResolve = resolve;
    });
    const eventLedger: AcpEventLedger = {
      ...innerLedger,
      recordUserPrompt: async () => {
        throw new Error("ledger write failed");
      },
      markIncomplete: async (params) => {
        await innerLedger.markIncomplete(params);
        markIncompleteResolve?.(params);
      },
    };
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const requestMock = vi.fn(async (_method: string) => ({ ok: true }));
    const agent = new AcpGatewayAgent(
      connection,
      createAcpGateway(requestMock as GatewayClient["request"]),
      {
        eventLedger,
        sessionStore,
      },
    );

    const created = await agent.newSession(createNewSessionRequest());
    const session = sessionStore.getSession(created.sessionId);
    if (!session) {
      throw new Error("Expected new ACP session to be stored");
    }

    const prompt = agent.prompt(createPromptRequest(created.sessionId, "Question"));
    await waitForChatSend(requestMock);
    await markIncompletePromise;
    const runId = sessionStore.getSession(created.sessionId)?.activeRunId;
    if (!runId) {
      throw new Error("Expected active ACP run");
    }
    await agent.handleGatewayEvent(
      createChatEvent({
        sessionKey: session.sessionKey,
        runId,
        state: "final",
        text: "Answer",
      }),
    );
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });

    await expect(
      innerLedger.readReplay({ sessionId: created.sessionId, sessionKey: session.sessionKey }),
    ).resolves.toEqual({ complete: false, events: [] });
  });
});
