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
  it("materializes and discovers each store once when one request resolves multiple targets", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      for (const [sessionKey, sessionId] of [
        ["agent:main:cache-one", "session-cache-one"],
        ["agent:main:cache-two", "session-cache-two"],
      ] as const) {
        await sessionAccessor.upsertSessionEntry(
          { agentId: "main", sessionKey },
          { sessionId, updatedAt: 1, visibility: "shared", category: "Cache Test" },
        );
      }

      const materializations = new Map<string, number>();
      const originalListSessionEntries = sessionAccessor.listSessionEntries;
      vi.spyOn(sessionAccessor, "listSessionEntries").mockImplementation((scope) => {
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
        createdActor: { type: "human" as const, id: "owner@example.com" },
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
        createdActor: { type: "human" as const, id: "owner@example.com" },
      },
    },
  ])("matches uncached $name authorization", async ({ sessionKey, entry }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await sessionAccessor.upsertSessionEntry({ agentId: "main", sessionKey }, entry);
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
