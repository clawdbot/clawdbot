import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionsConfig from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  authorizeResolvedSessionMutation,
  resolveSessionMutationAuthorization,
} from "./session-sharing.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

function identifiedClient(userId: string): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserId: userId,
    authenticatedUserProfile: {
      profileId: userId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

describe("session mutation authorization store caches", () => {
  it("fails a patchMany request when a nested target is incognito", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:dashboard:incognito-patch-many";
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: "session-incognito", updatedAt: 1, incognito: true },
      );
      const result = resolveSessionMutationAuthorization({
        client: identifiedClient("viewer@example.com"),
        method: "sessions.patchMany",
        requestParams: {
          targets: [{ key: sessionKey, agentId: "main" }],
          patch: { archived: true },
        },
        context: { chatAbortControllers: new Map(), getRuntimeConfig: () => ({}) } as never,
      });
      expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
    });
  });

  it("authorizes every patchMany target before dispatch", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sharedKey = "agent:main:batch-shared";
      const draftKey = "agent:main:batch-private";
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey: sharedKey },
        { sessionId: "session-shared", updatedAt: 1, visibility: "shared" },
      );
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey: draftKey },
        {
          sessionId: "session-private",
          updatedAt: 1,
          visibility: "draft",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );

      const result = resolveSessionMutationAuthorization({
        client: identifiedClient("viewer@example.com"),
        method: "sessions.patchMany",
        requestParams: {
          targets: [{ key: sharedKey }, { key: draftKey }],
          patch: { unread: false },
        },
        context: { chatAbortControllers: new Map(), getRuntimeConfig: () => ({}) } as never,
      });

      expect(result.authorization).toBeUndefined();
      expect(result.error).toMatchObject({
        code: "INVALID_REQUEST",
        details: { code: "SESSION_PARTICIPATION_REQUIRED", sessionKey: draftKey },
      });
    });
  });

  it("reuses metadata for padded patchMany targets and fences replacements", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:padded-batch-target";
      const prompt = "authorization does not need this prompt snapshot".repeat(512);
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-original",
          updatedAt: 1,
          visibility: "shared",
          skillsSnapshot: { prompt, skills: [] },
        },
      );
      const target = { sessionKey: ` ${sessionKey} `, agentId: " main " };
      const result = resolveSessionMutationAuthorization({
        client: identifiedClient("viewer@example.com"),
        method: "sessions.patchMany",
        requestParams: {
          targets: [{ key: target.sessionKey, agentId: target.agentId }],
          patch: { unread: false },
        },
        context: { chatAbortControllers: new Map(), getRuntimeConfig: () => ({}) } as never,
      });

      expect(result.error).toBeNull();
      expect(result.authorization).toBeDefined();
      const authorization = result.authorization!;
      const parseSpy = vi.spyOn(JSON, "parse");
      expect(() => authorization.assertTargetCurrent(target)).not.toThrow();
      expect(parseSpy.mock.calls.some(([serialized]) => serialized.includes(prompt))).toBe(false);
      parseSpy.mockRestore();

      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: "session-replacement", updatedAt: 2, visibility: "shared" },
      );

      expect(() => authorization.assertTargetCurrent(target)).toThrow(
        "session changed before sessions.patchMany; retry the request",
      );
    });
  });

  it("bounds malformed patchMany target discovery before schema validation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const hiddenKey = "agent:main:dashboard:incognito-over-limit";
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey: hiddenKey },
        { sessionId: "session-hidden", updatedAt: 1, incognito: true },
      );
      const targets = Array.from({ length: 101 }, (_, index) => ({
        key: `agent:main:over-limit-${index}`,
      }));
      targets.push({ key: hiddenKey });

      const result = resolveSessionMutationAuthorization({
        client: identifiedClient("viewer@example.com"),
        method: "sessions.patchMany",
        requestParams: { targets, patch: { archived: true } },
        context: { chatAbortControllers: new Map(), getRuntimeConfig: () => ({}) } as never,
      });

      expect(result.error).toBeNull();
      expect(result.authorization).toBeDefined();
    });
  });

  it("materializes and discovers each store once when one request resolves multiple targets", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      for (const [sessionKey, sessionId] of [
        ["agent:main:cache-one", "session-cache-one"],
        ["agent:main:cache-two", "session-cache-two"],
      ] as const) {
        await sessionAccessor.upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          { sessionId, updatedAt: 1, visibility: "shared", category: "Cache Test" },
        );
      }

      const materializations = new Map<string, number>();
      const originalListSessionEntries = sessionAccessor.listSessionEntriesCore;
      vi.spyOn(sessionAccessor, "listSessionEntriesCore").mockImplementation((scope) => {
        const entries = originalListSessionEntries(scope);
        if (scope?.clone === false) {
          const storePath = scope.storePath ?? "default";
          materializations.set(storePath, (materializations.get(storePath) ?? 0) + 1);
        }
        return entries;
      });
      const discoverySpy = vi.spyOn(sessionsConfig, "resolveExistingAgentSessionStoreTargetsSync");
      const cfg = {};

      expect(
        resolveSessionMutationAuthorization({
          client: identifiedClient("viewer@example.com"),
          method: "sessions.groups.delete",
          requestParams: { name: "Cache Test" },
          context: {
            chatAbortControllers: new Map(),
            getRuntimeConfig: () => cfg,
          } as never,
        }).error,
      ).toBeNull();

      expect([...materializations.values()]).toEqual([1]);
      expect(discoverySpy.mock.calls.filter((call) => call[1] === "main")).toHaveLength(1);
    });
  });

  it.each([
    {
      name: "shared",
      sessionKey: "agent:main:cache-parity-shared",
      entry: { sessionId: "session-shared", updatedAt: 1, visibility: "shared" as const },
    },
    {
      name: "private draft",
      sessionKey: "agent:main:cache-parity-private",
      entry: {
        sessionId: "session-private",
        updatedAt: 1,
        visibility: "draft" as const,
        createdActor: {
          type: "human" as const,
          source: "profile" as const,
          id: "owner@example.com",
        },
      },
    },
    {
      name: "incognito",
      sessionKey: "agent:main:dashboard:incognito-cache-parity",
      entry: {
        sessionId: "session-incognito",
        updatedAt: 1,
        visibility: "shared" as const,
        incognito: true as const,
        createdActor: {
          type: "human" as const,
          source: "profile" as const,
          id: "owner@example.com",
        },
      },
    },
  ])("matches uncached $name authorization", async ({ sessionKey, entry }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await sessionAccessor.upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
      const cfg = {};
      const requestClient = identifiedClient("viewer@example.com");
      const uncachedError = authorizeResolvedSessionMutation({
        cfg,
        client: requestClient,
        sessionKey,
        agentId: "main",
      });

      expect(
        resolveSessionMutationAuthorization({
          client: requestClient,
          method: "chat.send",
          requestParams: { sessionKey, agentId: "main" },
          context: {
            chatAbortControllers: new Map(),
            getRuntimeConfig: () => cfg,
          } as never,
        }).error,
      ).toEqual(uncachedError);
    });
  });
});
