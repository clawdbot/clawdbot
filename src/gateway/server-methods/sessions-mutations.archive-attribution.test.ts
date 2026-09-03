import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadGatewaySessionRow } from "../session-utils.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function client(profileId?: string, displayName?: string): GatewayClient {
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
    ...(profileId
      ? {
          authenticatedUserId: `${profileId}@example.com`,
          authenticatedUserProfile: {
            profileId,
            displayName: displayName ?? null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

function context(): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    loadGatewayModelCatalog: vi.fn(async () => []),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

async function patchSession(
  params: { key: string; archived: boolean; expectedSessionId: string; label?: string },
  requestClient: GatewayClient,
) {
  const responses = await invokePatchSession(params, requestClient);
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
}

async function invokePatchSession(
  params: { key: string; archived: boolean; expectedSessionId: string; label?: string },
  requestClient: GatewayClient,
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionMutationHandlers["sessions.patch"]?.({
    params,
    client: requestClient,
    context: context(),
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  return responses;
}

describe("sessions.patch archive attribution", () => {
  it("stamps the transition actor without adding transcript events and preserves the first archiver", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:archive-attribution";
      const sessionId = "session-archive-attribution";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: 1, pinnedAt: 2 },
      );

      await patchSession(
        { key: sessionKey, archived: true, expectedSessionId: sessionId },
        client("profile-ada", "Ada"),
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
        archivedAt: expect.any(Number),
        archivedBy: { type: "human", id: "profile-ada", label: "Ada" },
      });

      await patchSession(
        { key: sessionKey, archived: true, expectedSessionId: sessionId },
        client("profile-bob", "Bob"),
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.archivedBy).toEqual({
        type: "human",
        id: "profile-ada",
        label: "Ada",
      });

      await patchSession(
        { key: sessionKey, archived: false, expectedSessionId: sessionId },
        client("profile-bob", "Bob"),
      );
      const restored = loadSessionEntry({ agentId: "main", sessionKey });
      expect(restored?.archivedAt).toBeUndefined();
      expect(restored?.archivedBy).toBeUndefined();

      expect(await loadTranscriptEvents({ agentId: "main", sessionId, sessionKey })).toEqual([]);
    });
  });

  it("does not fabricate attribution or transcript events for an unidentified client", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:solo-archive";
      const sessionId = "session-solo-archive";
      await upsertSessionEntryCore({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });

      await patchSession(
        { key: sessionKey, archived: true, expectedSessionId: sessionId },
        client(),
      );

      const archived = loadSessionEntry({ agentId: "main", sessionKey });
      expect(archived?.archivedAt).toEqual(expect.any(Number));
      expect(archived?.archivedBy).toBeUndefined();
      expect(await loadTranscriptEvents({ agentId: "main", sessionId, sessionKey })).toEqual([]);
    });
  });

  it("archives through an alias with attribution", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const canonicalKey = "agent:main:alias-happy-archive";
      const aliasKey = "alias-happy-archive";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: canonicalKey },
        {
          sessionId: "session-canonical-happy-archive",
          updatedAt: 1,
        },
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: aliasKey },
        { sessionId: "session-alias-happy-archive", updatedAt: 2 },
      );

      await patchSession(
        {
          key: aliasKey,
          archived: true,
          expectedSessionId: "session-alias-happy-archive",
        },
        client("profile-ada", "Ada"),
      );

      expect(loadGatewaySessionRow(canonicalKey, { agentId: "main" })).toMatchObject({
        archived: true,
        archivedAt: expect.any(Number),
        archivedBy: { type: "human", id: "profile-ada" },
      });
    });
  });
});
