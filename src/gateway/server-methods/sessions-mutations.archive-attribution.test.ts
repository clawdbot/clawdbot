import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  listSessionEntries,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  listSessionMembers,
} from "../../config/sessions/session-sharing-store.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadGatewaySessionRow } from "../session-utils.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { sessionLog } from "./sessions-shared.js";
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
  } as unknown as GatewayRequestContext;
}

async function patchSession(
  params: { key: string; archived: boolean; label?: string },
  requestClient: GatewayClient,
) {
  const responses = await invokePatchSession(params, requestClient);
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
}

async function invokePatchSession(
  params: { key: string; archived: boolean; label?: string },
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
  it("stamps the transition actor, audits each transition, and preserves the first archiver", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:archive-attribution";
      const sessionId = "session-archive-attribution";
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: 1, pinnedAt: 2 },
      );

      await patchSession({ key: sessionKey, archived: true }, client("profile-ada", "Ada"));
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
        archivedAt: expect.any(Number),
        archivedBy: { type: "human", id: "profile-ada", label: "Ada" },
      });

      await patchSession({ key: sessionKey, archived: true }, client("profile-bob", "Bob"));
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.archivedBy).toEqual({
        type: "human",
        id: "profile-ada",
        label: "Ada",
      });

      await patchSession({ key: sessionKey, archived: false }, client("profile-bob", "Bob"));
      const restored = loadSessionEntry({ agentId: "main", sessionKey });
      expect(restored?.archivedAt).toBeUndefined();
      expect(restored?.archivedBy).toBeUndefined();

      const noteContents = (
        await loadTranscriptEvents({ agentId: "main", sessionId, sessionKey })
      ).flatMap((event) => {
        if (!event || typeof event !== "object" || !("message" in event)) {
          return [];
        }
        const message = event.message;
        if (
          !message ||
          typeof message !== "object" ||
          !("customType" in message) ||
          message.customType !== "openclaw.system-note" ||
          !("content" in message) ||
          typeof message.content !== "string"
        ) {
          return [];
        }
        return [message.content];
      });
      expect(noteContents).toEqual([
        "System note: archived by Ada",
        "System note: unarchived by Bob",
      ]);
    });
  });

  it("does not fabricate attribution or an actor-stamped audit for an unidentified client", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:solo-archive";
      const sessionId = "session-solo-archive";
      await upsertSessionEntry({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });

      await patchSession({ key: sessionKey, archived: true }, client());

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
      await upsertSessionEntry(
        { agentId: "main", sessionKey: canonicalKey },
        {
          sessionId: "session-canonical-happy-archive",
          updatedAt: 1,
        },
      );
      await upsertSessionEntry(
        { agentId: "main", sessionKey: aliasKey },
        { sessionId: "session-alias-happy-archive", updatedAt: 2 },
      );

      await patchSession({ key: aliasKey, archived: true }, client("profile-ada", "Ada"));

      expect(loadGatewaySessionRow(canonicalKey, { agentId: "main" })).toMatchObject({
        archived: true,
        archivedAt: expect.any(Number),
        archivedBy: { type: "human", id: "profile-ada" },
      });
    });
  });

  it("keeps an alias archive when its best-effort audit note fails", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const canonicalKey = "agent:main:alias-archive";
      const aliasKey = "alias-archive";
      const memberId = "profile-member";
      await upsertSessionEntry(
        { agentId: "main", sessionKey: canonicalKey },
        {
          sessionId: "session-canonical-before-archive",
          updatedAt: 1,
          label: "canonical",
        },
      );
      await upsertSessionEntry(
        { agentId: "main", sessionKey: aliasKey },
        {
          sessionId: "session-alias-before-archive",
          updatedAt: 2,
          label: "alias",
        },
      );
      const memberScope = { agentId: "main", sessionKey: canonicalKey };
      addSessionMember(memberScope, {
        identityId: memberId,
        addedBy: "profile-owner",
        addedAt: 123,
      });
      expect(listSessionMembers(memberScope)).toEqual([
        { identityId: memberId, addedBy: "profile-owner", addedAt: 123 },
      ]);
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const readCandidateState = () => ({
        entries: listSessionEntries({ agentId: "main" })
          .filter(({ sessionKey }) => sessionKey === canonicalKey || sessionKey === aliasKey)
          .toSorted((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
        members: listSessionMembers(memberScope),
      });
      const readTotalChanges = () =>
        (
          database.db.prepare("SELECT total_changes() AS value").get() as {
            value: number;
          }
        ).value;
      let stateAtFailure: ReturnType<typeof readCandidateState> | undefined;
      let changesAtFailure: number | undefined;
      const append = vi
        .spyOn(SessionManager.prototype, "appendMessage")
        .mockImplementationOnce(() => {
          stateAtFailure = readCandidateState();
          changesAtFailure = readTotalChanges();
          throw new Error("audit unavailable");
        });
      const warn = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});

      try {
        const responses = await invokePatchSession(
          { key: aliasKey, archived: true },
          client("profile-ada", "Ada"),
        );
        expect(responses).toHaveLength(1);
        expect(responses[0]?.[0]).toBe(true);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            `sessions.patch: archived audit note failed for ${canonicalKey}; archive kept: audit unavailable`,
          ),
        );
      } finally {
        append.mockRestore();
        warn.mockRestore();
      }

      expect(loadGatewaySessionRow(canonicalKey, { agentId: "main" })).toMatchObject({
        archived: true,
        archivedAt: expect.any(Number),
        archivedBy: { type: "human", id: "profile-ada" },
      });
      expect(readCandidateState()).toEqual(stateAtFailure);
      expect(readTotalChanges()).toBe(changesAtFailure);
    });
  });
});
