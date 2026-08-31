// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionGoal } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mutateChatGoal } from "./chat-goals.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

const goal: SessionGoal = {
  schemaVersion: 1,
  id: "goal-a",
  objective: "Review the UI",
  status: "paused",
  createdAt: 1,
  updatedAt: 2,
  tokenStart: 0,
  tokensUsed: 10,
  continuationTurns: 0,
};

afterEach(() => vi.restoreAllMocks());

function goalHost(requestHandlers: Record<string, unknown>) {
  return makeChatHost({
    currentSessionId: "session-a",
    chatMessage: "Unrelated draft",
    sessionsResult: {
      ...createSessionsListResult(),
      sessions: [{ key: "agent:main", kind: "direct", updatedAt: 2, goal }],
    },
    requestHandlers,
  });
}

describe("Goal control requests", () => {
  it("edits literal objective text through the typed owner and leaves the chat draft alone", async () => {
    const objective = "  /goal clear\n  is literal text ";
    const host = goalHost({
      "sessions.goal.update": {
        status: "updated",
        goalId: goal.id,
        goal: { ...goal, objective, updatedAt: 3 },
      },
    });
    expect(await mutateChatGoal(host, { action: "edit", goalId: goal.id, objective })).toBe(true);
    expect(host.request).toHaveBeenCalledWith(
      "sessions.goal.update",
      expect.objectContaining({
        sessionKey: host.sessionKey,
        sessionId: "session-a",
        goalId: goal.id,
        operationId: expect.any(String),
        issuedAtMs: expect.any(Number),
        action: "edit",
        objective,
      }),
    );
    expect(host.sessions.state.result?.sessions[0]?.goal?.objective).toBe(objective);
    expect(host.chatMessage).toBe("Unrelated draft");
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });

  it("adopts a fresh Resume run without inventing a user message", async () => {
    const host = goalHost({
      "sessions.goal.update": {
        status: "started",
        goalId: goal.id,
        runId: "resume-run",
        goal: { ...goal, status: "active", updatedAt: 3 },
      },
    });
    expect(await mutateChatGoal(host, { action: "resume", goalId: goal.id })).toBe(true);
    expect(host.chatRunId).toBe("resume-run");
    expect(host.chatMessages).toEqual([]);
    expect(host.chatMessage).toBe("Unrelated draft");
  });

  it("reuses a lost-ACK operation and refreshes replayed state without resurrecting the run", async () => {
    let fail = true;
    const host = goalHost({
      "sessions.goal.update": () => {
        if (fail) {
          throw new Error("Gateway disconnected before the acknowledgment");
        }
        return {
          status: "started",
          goalId: goal.id,
          runId: "old-resume-run",
          replayed: true,
          goal: { ...goal, status: "active" },
        };
      },
    });
    const refresh = vi.spyOn(host.sessions, "refresh").mockResolvedValue();
    expect(await mutateChatGoal(host, { action: "resume", goalId: goal.id })).toBe(false);
    const firstRequest = host.request.mock.calls.find(
      ([method]) => method === "sessions.goal.update",
    )?.[1];
    fail = false;
    host.client = createTestGatewayClient(host.request);
    host.connectionEpoch += 1;
    expect(await mutateChatGoal(host, { action: "resume", goalId: goal.id })).toBe(true);
    const requests = host.request.mock.calls.filter(
      ([method]) => method === "sessions.goal.update",
    );
    expect(requests[1]?.[1]).toEqual(firstRequest);
    expect(refresh).toHaveBeenCalledOnce();
    expect(host.chatRunId).toBeNull();
    expect(host.sessions.state.result?.sessions[0]?.goal?.status).toBe("paused");
  });

  it("does not apply a delayed clear to a replacement goal", async () => {
    const pending = createDeferred<{ status: string; goalId: string }>();
    const host = goalHost({ "sessions.goal.clear": () => pending.promise });
    const clear = mutateChatGoal(host, { action: "clear", goalId: goal.id });
    host.sessions.patchRowLocal(host.sessionKey, { goal: { ...goal, id: "replacement-goal" } });
    pending.resolve({ status: "cleared", goalId: goal.id });
    await clear;
    expect(host.sessions.state.result?.sessions[0]?.goal?.id).toBe("replacement-goal");
  });

  it("does not apply a delayed Resume to a different visible session", async () => {
    const pending = createDeferred<{ status: string; goalId: string; runId: string }>();
    const host = goalHost({ "sessions.goal.update": () => pending.promise });
    const resume = mutateChatGoal(host, { action: "resume", goalId: goal.id });
    host.sessionKey = "agent:main:other";
    host.currentSessionId = "session-b";
    pending.resolve({ status: "started", goalId: goal.id, runId: "old-session-run" });
    expect(await resume).toBe(true);
    expect(host.chatRunId).toBeNull();
    expect(host.chatMessage).toBe("Unrelated draft");
  });
});
