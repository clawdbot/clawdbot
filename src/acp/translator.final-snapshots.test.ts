/** Tests final Gateway snapshots are emitted before ACP prompt resolution. */
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";
import { createLoadSessionRequest, createPromptRequest } from "./translator.bridge-test-helpers.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

describe("acp final chat snapshots", () => {
  async function createSnapshotHarness() {
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
    await agent.loadSession(createLoadSessionRequest("snapshot-session"));
    sessionUpdate.mockClear();
    const promptPromise = agent.prompt(createPromptRequest("snapshot-session", "hello"));
    const runId = sessionStore.getSession("snapshot-session")?.activeRunId;
    if (!runId) {
      throw new Error("Expected ACP prompt run to be active");
    }
    return { agent, sessionUpdate, promptPromise, runId, sessionStore };
  }

  it("emits final snapshot text before resolving end_turn", async () => {
    const { agent, sessionUpdate, promptPromise, runId, sessionStore } =
      await createSnapshotHarness();

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        sessionKey: "snapshot-session",
        runId,
        state: "final",
        stopReason: "end_turn",
        message: {
          content: [{ type: "text", text: "FINAL TEXT SHOULD BE EMITTED" }],
        },
      },
    } as unknown as EventFrame);

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "snapshot-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "FINAL TEXT SHOULD BE EMITTED" },
      },
    });
    expect(sessionStore.getSession("snapshot-session")?.activeRunId).toBeNull();
    sessionStore.clearAllSessionsForTest();
  });

  it("does not duplicate text when final repeats the last delta snapshot", async () => {
    const { agent, sessionUpdate, promptPromise, runId, sessionStore } =
      await createSnapshotHarness();

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        sessionKey: "snapshot-session",
        runId,
        state: "delta",
        message: {
          content: [{ type: "text", text: "Hello world" }],
        },
      },
    } as unknown as EventFrame);

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        sessionKey: "snapshot-session",
        runId,
        state: "final",
        stopReason: "end_turn",
        message: {
          content: [{ type: "text", text: "Hello world" }],
        },
      },
    } as unknown as EventFrame);

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    const chunks = sessionUpdate.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>)?.update &&
        (call[0] as Record<string, Record<string, unknown>>).update?.sessionUpdate ===
          "agent_message_chunk",
    );
    expect(chunks).toHaveLength(1);
    sessionStore.clearAllSessionsForTest();
  });

  it("emits only the missing tail when the final snapshot extends prior deltas", async () => {
    const { agent, sessionUpdate, promptPromise, runId, sessionStore } =
      await createSnapshotHarness();

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        sessionKey: "snapshot-session",
        runId,
        state: "delta",
        message: {
          content: [{ type: "text", text: "Hello" }],
        },
      },
    } as unknown as EventFrame);

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        sessionKey: "snapshot-session",
        runId,
        state: "final",
        stopReason: "max_tokens",
        message: {
          content: [{ type: "text", text: "Hello world" }],
        },
      },
    } as unknown as EventFrame);

    await expect(promptPromise).resolves.toEqual({ stopReason: "max_tokens" });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "snapshot-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "snapshot-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " world" },
      },
    });
    sessionStore.clearAllSessionsForTest();
  });
});
