import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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

function context(broadcast = vi.fn(), cfg: OpenClawConfig = {}): GatewayRequestContext {
  return {
    getRuntimeConfig: () => cfg,
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
  preview?: string;
  agentId?: string;
  client: GatewayClient;
  context: GatewayRequestContext;
}) {
  const responses: Parameters<RespondFn>[] = [];
  const requestParams = {
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    typing: params.typing,
    ...(params.preview !== undefined ? { preview: params.preview } : {}),
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
  it("broadcasts bounded draft previews and never includes previews after typing stops", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(30_000);
      const sessionKey = "agent:main:preview";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-preview",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "shared",
        },
      );
      mocks.presence = [
        { user: { id: "alice" }, watchedSessions: [sessionKey] },
        { user: { id: "owner" }, watchedSessions: [sessionKey] },
      ];
      const broadcast = vi.fn();
      const params = {
        sessionKey,
        sessionId: "session-preview",
        client: client("alice", "alice-preview"),
        context: context(broadcast),
      };

      expect(await callTyping({ ...params, typing: true, preview: "  first draft  " })).toEqual({
        ok: true,
        broadcast: true,
      });
      expect(broadcast.mock.calls[0]?.[1]).toMatchObject({ typing: true, preview: "first draft" });

      const oversizedPreview = "😀".repeat(405);
      await vi.advanceTimersByTimeAsync(250);
      expect(await callTyping({ ...params, typing: true, preview: oversizedPreview })).toEqual({
        ok: true,
        broadcast: true,
      });
      expect(broadcast.mock.calls[1]?.[1].preview).toBe("😀".repeat(400));

      await vi.advanceTimersByTimeAsync(1_000);
      expect(await callTyping({ ...params, typing: false, preview: "must not leak" })).toEqual({
        ok: true,
        broadcast: true,
      });
      expect(broadcast.mock.calls[2]?.[1]).toMatchObject({ typing: false });
      expect(broadcast.mock.calls[2]?.[1]).not.toHaveProperty("preview");
    });
  });

  it("keeps a live draft preview when another connection sends boolean-only typing", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(40_000);
      const sessionKey = "agent:main:shared-preview";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-shared-preview",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "shared",
        },
      );
      mocks.presence = [
        { user: { id: "alice" }, watchedSessions: [sessionKey] },
        { user: { id: "owner" }, watchedSessions: [sessionKey] },
      ];
      const broadcast = vi.fn();
      const params = {
        sessionKey,
        sessionId: "session-shared-preview",
        context: context(broadcast),
      };

      expect(
        await callTyping({
          ...params,
          typing: true,
          preview: "still drafting",
          client: client("alice", "alice-preview-tab"),
        }),
      ).toEqual({ ok: true, broadcast: true });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        await callTyping({
          ...params,
          typing: true,
          client: client("alice", "alice-presence-tab"),
        }),
      ).toEqual({ ok: true, broadcast: true });

      expect(broadcast.mock.calls[1]?.[1]).toMatchObject({
        typing: true,
        preview: "still drafting",
      });
    });
  });

  it.each([
    { agentId: "main", expected: ["agent:main:global"] },
    { agentId: "work", expected: ["agent:work:global"] },
  ])("uses the canonical global subscription keys for $agentId", async ({ agentId, expected }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        agents: { list: [{ id: "main" }, { id: "work" }] },
      } satisfies OpenClawConfig;
      await upsertSessionEntryCore(
        { agentId, sessionKey: "global" },
        {
          sessionId: `session-${agentId}`,
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "shared",
        },
      );
      mocks.presence = [
        { user: { id: "alice" }, watchedSessions: ["global"] },
        { user: { id: "owner" }, watchedSessions: ["global"] },
      ];
      const broadcast = vi.fn();

      expect(
        await callTyping({
          sessionKey: "global",
          sessionId: `session-${agentId}`,
          agentId,
          typing: true,
          client: client("alice", `alice-${agentId}`),
          context: context(broadcast, cfg),
        }),
      ).toEqual({ ok: true, broadcast: true });
      expect(broadcast).toHaveBeenCalledWith(
        "session.typing",
        expect.objectContaining({ agentId, sessionKey: "global" }),
        expect.objectContaining({ agentId, sessionKeys: expected }),
      );
    });
  });

  it("keeps an identity typing until its last active connection stops", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const sessionKey = "agent:main:main";
      await upsertSessionEntryCore(
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
        upsertSessionEntryCore(
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
      await upsertSessionEntryCore(scope, {
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
      await upsertSessionEntryCore(scope, {
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
