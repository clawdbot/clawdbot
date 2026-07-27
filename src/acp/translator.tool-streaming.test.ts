/** Tests Gateway tool streaming to ACP tool-call update mapping. */
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import {
  createLoadSessionRequest,
  createPromptRequest,
  createToolEvent,
  createChatFinalEvent,
} from "./translator.bridge-test-helpers.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

describe("acp tool streaming bridge behavior", () => {
  it("maps Gateway tool partial output and file locations into ACP tool updates", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection["__sessionUpdateMock"];
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return new Promise(() => {});
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("tool-session"));
    sessionUpdate.mockClear();

    const promptPromise = agent.prompt(createPromptRequest("tool-session", "Inspect app.ts"));

    await agent.handleGatewayEvent(
      createToolEvent({
        sessionKey: "tool-session",
        phase: "start",
        toolCallId: "tool-1",
        name: "read",
        args: { path: "src/app.ts", line: 12 },
      }),
    );
    await agent.handleGatewayEvent(
      createToolEvent({
        sessionKey: "tool-session",
        phase: "update",
        toolCallId: "tool-1",
        name: "read",
        partialResult: {
          content: [{ type: "text", text: "partial output" }],
          details: { path: "src/app.ts" },
        },
      }),
    );
    await agent.handleGatewayEvent(
      createToolEvent({
        sessionKey: "tool-session",
        phase: "result",
        toolCallId: "tool-1",
        name: "read",
        result: {
          content: [{ type: "text", text: "FILE:src/app.ts" }],
          details: { path: "src/app.ts" },
        },
      }),
    );
    await agent.handleGatewayEvent(createChatFinalEvent("tool-session"));
    await promptPromise;

    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "tool-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "read: path: src/app.ts, line: 12",
        status: "in_progress",
        rawInput: { path: "src/app.ts", line: 12 },
        kind: "read",
        locations: [{ path: "src/app.ts", line: 12 }],
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "tool-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "in_progress",
        rawOutput: {
          content: [{ type: "text", text: "partial output" }],
          details: { path: "src/app.ts" },
        },
        content: [
          {
            type: "content",
            content: { type: "text", text: "partial output" },
          },
        ],
        locations: [{ path: "src/app.ts", line: 12 }],
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "tool-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: {
          content: [{ type: "text", text: "FILE:src/app.ts" }],
          details: { path: "src/app.ts" },
        },
        content: [
          {
            type: "content",
            content: { type: "text", text: "FILE:src/app.ts" },
          },
        ],
        locations: [{ path: "src/app.ts", line: 12 }],
      },
    });

    sessionStore.clearAllSessionsForTest();
  });
});
