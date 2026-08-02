import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionSuggestionHandlers } from "./sessions-suggestions.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  presence: [] as Array<{
    user?: { id: string; name?: string };
    watchedSessions?: string[];
  }>,
}));

vi.mock("../../infra/system-presence.js", () => ({
  listSystemPresence: () => mocks.presence,
}));

function client(profileId: string, connId: string): GatewayClient {
  return {
    connId,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
        instanceId: connId,
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: {
      profileId,
      displayName: profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

function context(broadcast = vi.fn()): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    broadcast,
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
}

async function callTyping(params: {
  sessionKey: string;
  sessionId: string;
  typing: boolean;
  client: GatewayClient;
  context: GatewayRequestContext;
}) {
  const responses: Parameters<RespondFn>[] = [];
  const requestParams = {
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    typing: params.typing,
  };
  await sessionSuggestionHandlers["session.typing"]?.({
    req: { type: "req", id: "typing-request", method: "session.typing", params: requestParams },
    params: requestParams,
    client: params.client,
    context: params.context,
    isWebchatConnect: () => true,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  });
  return responses[0]?.[1];
}

beforeEach(() => {
  mocks.presence = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

describe("session typing handler", () => {
  it("keeps an identity typing until its last active connection stops", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const sessionKey = "agent:main:main";
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "shared",
        },
      );
      mocks.presence = [
        { user: { id: "multi" }, watchedSessions: [sessionKey] },
        { user: { id: "owner" }, watchedSessions: [sessionKey] },
      ];
      const broadcast = vi.fn();
      const requestContext = context(broadcast);
      const params = { sessionKey, sessionId: "session-main", context: requestContext };
      const tabOne = client("multi", "multi-tab-1");
      const tabTwo = client("multi", "multi-tab-2");

      expect(await callTyping({ ...params, typing: true, client: tabOne })).toEqual({
        ok: true,
        broadcast: true,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await callTyping({ ...params, typing: true, client: tabTwo })).toEqual({
        ok: true,
        broadcast: false,
      });
      await vi.advanceTimersByTimeAsync(300);
      expect(await callTyping({ ...params, typing: false, client: tabOne })).toEqual({
        ok: true,
        broadcast: false,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await callTyping({ ...params, typing: false, client: tabTwo })).toEqual({
        ok: true,
        broadcast: false,
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(broadcast.mock.calls.map((call) => call[1].typing)).toEqual([true, false]);
    });
  });

  it("does not carry active connections across a session replacement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(15_000);
      const sessionKey = "agent:main:typing-instance";
      const writeSession = (sessionId: string, updatedAt: number) =>
        upsertSessionEntry(
          { agentId: "main", sessionKey },
          {
            sessionId,
            updatedAt,
            createdActor: { type: "human" as const, id: "owner" },
            visibility: "shared" as const,
          },
        );
      await writeSession("session-before-reset", 1);
      mocks.presence = [
        { user: { id: "alice" }, watchedSessions: [sessionKey] },
        { user: { id: "owner" }, watchedSessions: [sessionKey] },
      ];
      const broadcast = vi.fn();
      const requestContext = context(broadcast);
      const oldTab = client("alice", "old-tab");
      const newTab = client("alice", "new-tab");

      expect(
        await callTyping({
          sessionKey,
          sessionId: "session-before-reset",
          typing: true,
          client: oldTab,
          context: requestContext,
        }),
      ).toEqual({ ok: true, broadcast: true });
      await writeSession("session-after-reset", 2);
      expect(
        await callTyping({
          sessionKey,
          sessionId: "session-before-reset",
          typing: true,
          client: oldTab,
          context: requestContext,
        }),
      ).toEqual({ ok: true, broadcast: false });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        await callTyping({
          sessionKey,
          sessionId: "session-after-reset",
          typing: true,
          client: newTab,
          context: requestContext,
        }),
      ).toEqual({ ok: true, broadcast: true });
      expect(broadcast.mock.calls[1]?.[1]).toMatchObject({
        sessionId: "session-after-reset",
        typing: true,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(
        await callTyping({
          sessionKey,
          sessionId: "session-after-reset",
          typing: false,
          client: newTab,
          context: requestContext,
        }),
      ).toEqual({ ok: true, broadcast: false });
      await vi.advanceTimersByTimeAsync(900);
      expect(broadcast.mock.calls.map((call) => call[1].typing)).toEqual([true, true, false]);
    });
  });

  it("drops a delayed refresh after the session is replaced", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(20_000);
      const sessionKey = "agent:main:typing-reset";
      const scope = { agentId: "main", sessionKey };
      await upsertSessionEntry(scope, {
        sessionId: "session-before-reset",
        updatedAt: 1,
        createdActor: { type: "human", id: "owner" },
        visibility: "shared",
      });
      mocks.presence = [
        { user: { id: "alice" }, watchedSessions: [sessionKey] },
        { user: { id: "owner" }, watchedSessions: [sessionKey] },
      ];
      const broadcast = vi.fn();
      const params = {
        sessionKey,
        sessionId: "session-before-reset",
        client: client("alice", "alice-tab"),
        context: context(broadcast),
      };

      expect(await callTyping({ ...params, typing: true })).toEqual({
        ok: true,
        broadcast: true,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await callTyping({ ...params, typing: true })).toEqual({
        ok: true,
        broadcast: false,
      });
      await upsertSessionEntry(scope, {
        sessionId: "session-after-reset",
        updatedAt: 2,
        createdActor: { type: "human", id: "owner" },
        visibility: "shared",
      });
      await vi.advanceTimersByTimeAsync(900);
      expect(broadcast).toHaveBeenCalledTimes(1);
    });
  });
});
