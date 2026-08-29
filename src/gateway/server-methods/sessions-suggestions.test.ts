import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  readSessionTranscriptMessageEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import {
  addSessionSuggestion,
  listSessionSuggestions,
  SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
} from "../../config/sessions/session-suggestion-store.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSessionSharingTarget } from "../session-sharing.js";
import { getSessionSuggestionTestMocks } from "./sessions-suggestions.test-mocks.js";
import {
  call,
  client,
  context,
  registerSessionSuggestionTestLifecycle,
  responseSuggestionId,
  sessionKey,
  upsertDefaultSuggestionSession,
} from "./sessions-suggestions.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = getSessionSuggestionTestMocks();
registerSessionSuggestionTestLifecycle(mocks);

describe("session suggestion handlers", () => {
  it("admits bare fixed-store keys only through their persisted owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.path("shared-sessions.sqlite");
      await upsertSessionEntryCore(
        { agentId: "ops", sessionKey: "global", storePath },
        {
          sessionId: "session-ops-global",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "suggest",
        },
      );
      const ownedConfig = {
        session: { scope: "global", store: storePath },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      } as ReturnType<GatewayRequestContext["getRuntimeConfig"]>;

      const admitted = await call(
        "session.suggestions.list",
        { sessionKey: "global" },
        client("owner", "Owner"),
        context(vi.fn(), ownedConfig),
      );
      expect(admitted.responses[0]).toMatchObject([true, { role: "owner", suggestions: [] }]);

      const ownerlessConfig = {
        ...ownedConfig,
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } as ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
      const rejected = await call(
        "session.suggestions.list",
        { sessionKey: "global" },
        client("owner", "Owner"),
        context(vi.fn(), ownerlessConfig),
      );
      expect(rejected.responses[0]?.[2]).toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("has no explicit owner"),
      });
    });
  });

  it("attributes a bare-key suggestion send to the persisted owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.path("shared-sessions.sqlite");
      await upsertSessionEntryCore(
        { agentId: "ops", sessionKey: "global", storePath },
        {
          sessionId: "session-ops-global",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "suggest",
        },
      );
      const ownedConfig = {
        session: { scope: "global", store: storePath },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      } as ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
      const requestContext = context(vi.fn(), ownedConfig);
      const added = await call(
        "session.suggestions.add",
        { sessionKey: "global", text: "steer the owner" },
        client("alice", "Alice"),
        requestContext,
      );
      const id = responseSuggestionId(added);

      const resolved = await call(
        "session.suggestions.resolve",
        { sessionKey: "global", id, resolution: "send" },
        client("owner", "Owner"),
        requestContext,
      );

      expect(resolved.responses[0]?.[0]).toBe(true);
      expect(mocks.handleChatSend.mock.calls[0]?.[0]?.params).toMatchObject({
        agentId: "ops",
        queueMode: "steer",
      });
    });
  });

  it("rejects archived suggestion creation and non-dismiss resolutions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const archivedKey = "agent:main:archived-suggestions";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: archivedKey },
        {
          sessionId: "session-archived",
          updatedAt: 1,
          archivedAt: 2,
          createdActor: { type: "human", id: "owner" },
          visibility: "suggest",
        },
      );
      addSessionSuggestion(
        { agentId: "main", sessionKey: archivedKey },
        {
          id: "archived-suggestion",
          authorId: "alice",
          text: "archived work",
          expectedSessionId: "session-archived",
        },
      );
      const owner = client("owner", "Owner");

      const add = await call(
        "session.suggestions.add",
        { sessionKey: archivedKey, text: "new archived work" },
        owner,
      );
      expect(add.responses[0]?.[0]).toBe(false);
      expect(add.responses[0]?.[2]?.message).toMatch(/is archived/);

      for (const resolution of ["send", "queue", "edit"] as const) {
        const resolved = await call(
          "session.suggestions.resolve",
          { sessionKey: archivedKey, id: "archived-suggestion", resolution },
          owner,
        );
        expect(resolved.responses[0]?.[0]).toBe(false);
        expect(resolved.responses[0]?.[2]?.message).toMatch(/is archived/);
      }
      expect(mocks.handleChatSend).not.toHaveBeenCalled();

      const dismissed = await call(
        "session.suggestions.resolve",
        { sessionKey: archivedKey, id: "archived-suggestion", resolution: "dismiss" },
        owner,
      );
      expect(dismissed.responses[0]?.[1]).toMatchObject({
        suggestion: { id: "archived-suggestion", state: "dismissed" },
      });
    });
  });

  it.each([
    ["send", "steer"],
    ["queue", "followup"],
  ] as const)(
    "dispatches %s through chat.send with suggested-by attribution",
    async (resolution, queueMode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertDefaultSuggestionSession();
        const added = await call(
          "session.suggestions.add",
          { sessionKey, text: "Ship the focused change" },
          client("alice", "Alice"),
        );
        const id = responseSuggestionId(added);
        const requestContext = context();

        const resolved = await call(
          "session.suggestions.resolve",
          { sessionKey, id, resolution },
          client("owner", "Owner"),
          requestContext,
        );
        expect(resolved.responses[0]?.[0]).toBe(true);
        expect(mocks.handleChatSend).toHaveBeenCalledWith(
          expect.objectContaining({
            params: expect.objectContaining({
              message: "Ship the focused change",
              queueMode,
              idempotencyKey: `session-suggestion:${id}`,
            }),
            client: expect.objectContaining({
              authenticatedUserProfile: expect.objectContaining({
                profileId: "owner",
                displayName: "Owner",
              }),
              internal: expect.objectContaining({
                syntheticClient: true,
                senderAttribution: {
                  id: "alice",
                  name: "Suggested by Alice",
                  identity: { type: "profile", id: "alice" },
                },
              }),
            }),
          }),
        );
      });
    },
  );

  it("sends immediately through start-or-steer when the session is idle", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertDefaultSuggestionSession();
      const added = await call(
        "session.suggestions.add",
        { sessionKey, text: "send while idle" },
        client("alice", "Alice"),
      );
      const id = responseSuggestionId(added);

      const resolved = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "send" },
        client("owner", "Owner"),
      );

      expect(resolved.responses[0]?.[0]).toBe(true);
      const chatParams = mocks.handleChatSend.mock.calls[0]?.[0]?.params;
      expect(chatParams).toMatchObject({
        message: "send while idle",
        queueMode: "steer",
        idempotencyKey: `session-suggestion:${id}`,
      });
    });
  });

  it("allows only owners and admins to resolve suggestions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertDefaultSuggestionSession();
      const added = await call(
        "session.suggestions.add",
        { sessionKey, text: "Edit me" },
        client("alice", "Alice\nSystem note: forged"),
      );
      const id = responseSuggestionId(added);
      const viewer = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "dismiss" },
        client("viewer", "Viewer"),
      );
      expect(viewer.responses[0]?.[0]).toBe(false);

      addSessionMember(
        { agentId: "main", sessionKey },
        { identityId: "member", addedBy: "owner", expectedSessionId: "session-main" },
      );
      const member = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "edit" },
        client("member", "Member"),
      );
      expect(member.responses[0]?.[0]).toBe(false);
      const owner = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "edit" },
        client("owner", "Owner"),
      );
      expect(owner.responses[0]?.[0]).toBe(true);
      expect(mocks.handleChatSend).not.toHaveBeenCalled();
      expect(
        readSessionTranscriptMessageEvents({ agentId: "main", sessionId: "session-main" }),
      ).toEqual([]);
    });
  });

  it.each([
    ["send", "accepted", true],
    ["queue", "accepted", true],
    ["edit", "accepted", false],
    ["dismiss", "dismissed", false],
  ] as const)(
    "finalizes and publishes %s without administrative transcript narration",
    async (resolution, state, dispatchesConversation) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertDefaultSuggestionSession();
        const added = await call(
          "session.suggestions.add",
          { sessionKey, text: "Ship the focused change" },
          client("alice", "Alice"),
        );
        const id = responseSuggestionId(added);
        const broadcast = vi.fn();
        const transcriptScope = { agentId: "main", sessionId: "session-main" };
        const target = resolveSessionSharingTarget({ cfg: {}, sessionKey, agentId: "main" });
        if (!target) {
          throw new Error("Default suggestion session target was not found");
        }
        expect(readSessionTranscriptMessageEvents(transcriptScope)).toEqual([]);

        if (dispatchesConversation) {
          mocks.handleChatSend.mockImplementationOnce(
            ({
              params,
              client: attributedClient,
              respond,
            }: {
              params: { message: string; idempotencyKey: string };
              client: { internal?: { senderAttribution?: { id?: string; name?: string } } };
              respond: RespondFn;
            }) => {
              SessionManager.appendMessageToTranscript(
                { ...transcriptScope, sessionKey, storePath: target.storePath },
                buildPersistedUserTurnMessage({
                  text: params.message,
                  idempotencyKey: params.idempotencyKey,
                  sender: attributedClient.internal?.senderAttribution,
                }),
              );
              respond(true, { runId: "suggestion-run", status: "started" });
            },
          );
        }

        const resolved = await call(
          "session.suggestions.resolve",
          { sessionKey, id, resolution },
          client("owner", "Owner"),
          context(broadcast),
        );

        expect(resolved.responses[0]).toMatchObject([
          true,
          { suggestion: { id, state, text: "Ship the focused change" } },
        ]);
        expect(listSessionSuggestions({ agentId: "main", sessionKey })).toMatchObject([
          { id, state, text: "Ship the focused change" },
        ]);
        expect(broadcast).toHaveBeenCalledWith(
          "session.suggestion",
          expect.objectContaining({
            action: "resolved",
            suggestion: expect.objectContaining({ id, state }),
          }),
          expect.objectContaining({ sessionKeys: [sessionKey] }),
        );

        const events = readSessionTranscriptMessageEvents(transcriptScope);
        if (dispatchesConversation) {
          expect(events).toHaveLength(1);
          expect(events[0]?.event).toMatchObject({
            message: {
              role: "user",
              content: "Ship the focused change",
              idempotencyKey: `session-suggestion:${id}`,
              __openclaw: {
                senderId: "alice",
                senderName: "Suggested by Alice",
                senderIdentity: { type: "profile", id: "alice" },
              },
            },
          });
          expect(mocks.handleChatSend).toHaveBeenCalledOnce();
        } else {
          expect(events).toEqual([]);
          expect(mocks.handleChatSend).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("keeps typing dormant for one identity and broadcasts for two live viewers", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      await upsertDefaultSuggestionSession();
      const broadcast = vi.fn();
      const requestContext = context(broadcast);
      mocks.presence = [
        {
          user: { id: "alice", identity: { type: "profile", id: "alice" } },
          watchedSessions: [sessionKey],
        },
      ];
      const solo = await call(
        "session.typing",
        { sessionKey, sessionId: "session-main", typing: true },
        client("alice", "Alice"),
        requestContext,
      );
      expect(solo.responses[0]?.[1]).toEqual({ ok: true, broadcast: false });
      expect(broadcast).not.toHaveBeenCalled();

      mocks.presence.push({
        user: { id: "owner", identity: { type: "profile", id: "owner" } },
        watchedSessions: [sessionKey],
      });
      const collaborative = await call(
        "session.typing",
        { sessionKey, sessionId: "session-main", typing: true },
        client("alice", "Alice"),
        requestContext,
      );
      expect(collaborative.responses[0]?.[1]).toEqual({ ok: true, broadcast: true });
      expect(broadcast).toHaveBeenCalledWith(
        "session.typing",
        expect.objectContaining({ actor: { type: "human", id: "alice", label: "Alice" } }),
        expect.objectContaining({ sessionKeys: [sessionKey], dropIfSlow: true }),
      );

      vi.setSystemTime(1_100);
      const earlyStop = await call(
        "session.typing",
        { sessionKey, sessionId: "session-main", typing: false },
        client("alice", "Alice"),
        requestContext,
      );
      expect(earlyStop.responses[0]?.[1]).toEqual({ ok: true, broadcast: false });
      await vi.advanceTimersByTimeAsync(900);
      expect(broadcast).toHaveBeenLastCalledWith(
        "session.typing",
        expect.objectContaining({ typing: false }),
        expect.any(Object),
      );

      vi.setSystemTime(2_100);
      const earlyRestart = await call(
        "session.typing",
        { sessionKey, sessionId: "session-main", typing: true },
        client("alice", "Alice"),
        requestContext,
      );
      expect(earlyRestart.responses[0]?.[1]).toEqual({ ok: true, broadcast: false });
      await vi.advanceTimersByTimeAsync(900);
      expect(broadcast).toHaveBeenLastCalledWith(
        "session.typing",
        expect.objectContaining({ typing: true }),
        expect.any(Object),
      );

      mocks.presence = [
        {
          user: { id: "owner", identity: { type: "profile", id: "owner" } },
          watchedSessions: [sessionKey],
        },
        {
          user: { id: "bob", identity: { type: "profile", id: "bob" } },
          watchedSessions: [sessionKey],
        },
      ];
      vi.setSystemTime(4_000);
      const notViewing = await call(
        "session.typing",
        { sessionKey, sessionId: "session-main", typing: true },
        client("mallory", "Mallory"),
        requestContext,
      );
      expect(notViewing.responses[0]?.[1]).toEqual({ ok: true, broadcast: false });

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 2,
          createdActor: { type: "human", id: "owner" },
          visibility: "shared",
        },
      );
      mocks.presence = [
        {
          user: { id: "shared-alice", identity: { type: "profile", id: "shared-alice" } },
          watchedSessions: [sessionKey],
        },
        {
          user: { id: "owner", identity: { type: "profile", id: "owner" } },
          watchedSessions: [sessionKey],
        },
      ];
      vi.setSystemTime(5_000);
      const sharedViewer = await call(
        "session.typing",
        { sessionKey, sessionId: "session-main", typing: true },
        client("shared-alice", "Shared Alice"),
        requestContext,
      );
      expect(sharedViewer.responses[0]?.[1]).toEqual({ ok: true, broadcast: true });
    });
  });

  it("returns structured errors for blank text and clientless dispatch", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertDefaultSuggestionSession();
      const blank = await call(
        "session.suggestions.add",
        { sessionKey, text: "   " },
        client("alice", "Alice"),
      );
      expect(blank.responses[0]?.[0]).toBe(false);
      expect(blank.responses[0]?.[2]?.message).toMatch(/text is required/);

      const added = await call(
        "session.suggestions.add",
        { sessionKey, text: "send me" },
        client("alice", "Alice"),
      );
      const dispatch = await call(
        "session.suggestions.resolve",
        { sessionKey, id: responseSuggestionId(added), resolution: "send" },
        null,
      );
      expect(dispatch.responses[0]?.[0]).toBe(false);
      expect(dispatch.responses[0]?.[2]?.message).toMatch(/connected client required/);
      const listed = await call(
        "session.suggestions.list",
        { sessionKey },
        client("owner", "Owner"),
      );
      expect(listed.responses[0]?.[1]).toMatchObject({
        suggestions: [{ state: "pending", text: "send me" }],
      });
    });
  });

  it("responds once when a typing target is unknown", async () => {
    const unknown = await call(
      "session.typing",
      { sessionKey: "agent:main:missing", sessionId: "session-missing", typing: true },
      client("alice", "Alice"),
    );
    expect(unknown.responses).toHaveLength(1);
    expect(unknown.responses[0]?.[0]).toBe(false);
    expect(unknown.responses[0]?.[2]?.message).toMatch(/unknown session/);
    const unknownAdd = await call(
      "session.suggestions.add",
      { sessionKey: "agent:main:missing", text: "hello" },
      null,
    );
    expect(unknownAdd.responses).toHaveLength(1);
    expect(unknownAdd.responses[0]?.[0]).toBe(false);
  });

  it("keeps an uncertain dispatch claimed until retry reconciliation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      await upsertDefaultSuggestionSession();
      const added = await call(
        "session.suggestions.add",
        { sessionKey, text: "retry me" },
        client("alice", "Alice"),
      );
      const id = responseSuggestionId(added);
      mocks.handleChatSend.mockRejectedValueOnce(new Error("dispatch exploded"));
      const resolved = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "send" },
        client("owner", "Owner"),
      );
      expect(resolved.responses[0]?.[0]).toBe(false);
      expect(resolved.responses[0]?.[2]?.message).toBe("dispatch exploded");
      const listed = await call(
        "session.suggestions.list",
        { sessionKey },
        client("owner", "Owner"),
      );
      expect(listed.responses[0]?.[1]).toMatchObject({
        suggestions: [{ state: "pending", text: "retry me" }],
      });
      const alternate = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "dismiss" },
        client("owner", "Owner"),
      );
      expect(alternate.responses[0]?.[0]).toBe(false);
      expect(alternate.responses[0]?.[2]?.message).toMatch(/already in progress/);

      now += SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS;
      const mismatchedRetry = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "queue" },
        client("owner", "Owner"),
      );
      expect(mismatchedRetry.responses[0]?.[0]).toBe(false);
      expect(mismatchedRetry.responses[0]?.[2]?.message).toMatch(/original send action/);
      const reconciled = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "send" },
        client("owner", "Owner"),
      );
      expect(reconciled.responses[0]?.[0]).toBe(true);
    });
  });

  it("claims a pending suggestion before dispatching it", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertDefaultSuggestionSession();
      const added = await call(
        "session.suggestions.add",
        { sessionKey, text: "only once" },
        client("alice", "Alice"),
      );
      const id = responseSuggestionId(added);
      const gate = createDeferred();
      mocks.handleChatSend.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
        await gate.promise;
        respond(true, { runId: "suggestion-run", status: "started" });
      });
      const first = call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "send" },
        client("owner", "Owner"),
      );
      await vi.waitFor(() => expect(mocks.handleChatSend).toHaveBeenCalledTimes(1));
      const duplicate = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "dismiss" },
        client("owner", "Owner"),
      );
      expect(duplicate.responses[0]?.[0]).toBe(false);
      expect(duplicate.responses[0]?.[2]?.message).toMatch(/already in progress/);
      gate.resolve();
      expect((await first).responses[0]?.[0]).toBe(true);
      expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
    });
  });

  it("returns a structured error when the session is replaced after dispatch", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-before-dispatch",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "suggest",
        },
      );
      const added = await call(
        "session.suggestions.add",
        { sessionKey, text: "dispatch before reset" },
        client("alice", "Alice"),
      );
      const dispatched = createDeferred();
      mocks.handleChatSend.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
        await dispatched.promise;
        respond(true, { runId: "suggestion-run", status: "started" });
      });
      const broadcast = vi.fn();
      const resolving = call(
        "session.suggestions.resolve",
        { sessionKey, id: responseSuggestionId(added), resolution: "send" },
        client("owner", "Owner"),
        context(broadcast),
      );
      await vi.waitFor(() => expect(mocks.handleChatSend).toHaveBeenCalledOnce());

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-after-dispatch",
          updatedAt: 2,
          createdActor: { type: "human", id: "owner" },
          visibility: "suggest",
        },
      );
      expect(listSessionSuggestions({ agentId: "main", sessionKey })).toEqual([]);
      dispatched.resolve(undefined);
      const result = await resolving;

      expect(result.responses).toHaveLength(1);
      expect(result.responses[0]?.[0]).toBe(false);
      expect(result.responses[0]?.[2]).toMatchObject({
        code: "UNAVAILABLE",
        retryable: false,
        details: {
          code: "SESSION_SUGGESTION_SESSION_CHANGED",
          sessionKey,
        },
      });
      expect(broadcast).not.toHaveBeenCalled();
    });
  });

  it.each(["claim", "release", "finalize"] as const)(
    "maps a session replacement during %s to the structured terminal error",
    async (phase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "session-race",
            updatedAt: 1,
            createdActor: { type: "human", id: "owner" },
            visibility: "suggest",
          },
        );
        const added = await call(
          "session.suggestions.add",
          { sessionKey, text: `replace during ${phase}` },
          client("alice", "Alice"),
        );
        if (phase === "release") {
          mocks.handleChatSend.mockImplementationOnce(
            async ({ respond }: { respond: RespondFn }) => {
              respond(false, undefined, {
                code: "INVALID_REQUEST",
                message: "definite dispatch rejection",
              });
            },
          );
        }
        mocks.suggestionMutationFailure = phase;
        const broadcast = vi.fn();

        const result = await call(
          "session.suggestions.resolve",
          {
            sessionKey,
            id: responseSuggestionId(added),
            resolution: phase === "release" ? "send" : "dismiss",
          },
          client("owner", "Owner"),
          context(broadcast),
        );

        expect(result.responses).toHaveLength(1);
        expect(result.responses[0]?.[0]).toBe(false);
        expect(result.responses[0]?.[2]).toMatchObject({
          code: "UNAVAILABLE",
          retryable: false,
          details: {
            code: "SESSION_SUGGESTION_SESSION_CHANGED",
            sessionKey,
          },
        });
        expect(broadcast).not.toHaveBeenCalled();
      });
    },
  );

  it("keeps an unexpected claim-release failure retryable", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-release-failure",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "suggest",
        },
      );
      const added = await call(
        "session.suggestions.add",
        { sessionKey, text: "retry after release failure" },
        client("alice", "Alice"),
      );
      mocks.handleChatSend.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "definite dispatch rejection",
        });
      });
      mocks.suggestionMutationFailure = "release-unexpected";

      const result = await call(
        "session.suggestions.resolve",
        { sessionKey, id: responseSuggestionId(added), resolution: "send" },
        client("owner", "Owner"),
      );

      expect(result.responses).toHaveLength(1);
      expect(result.responses[0]?.[2]).toMatchObject({
        code: "UNAVAILABLE",
        message: "release storage failed",
        retryable: true,
        retryAfterMs: SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
      });
    });
  });

  it("releases a durable claim after a definite dispatch rejection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertDefaultSuggestionSession();
      const added = await call(
        "session.suggestions.add",
        { sessionKey, text: "try again" },
        client("alice", "Alice"),
      );
      const id = responseSuggestionId(added);
      mocks.handleChatSend.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "dispatch rejected",
        });
      });
      const rejected = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "send" },
        client("owner", "Owner"),
      );
      expect(rejected.responses[0]?.[0]).toBe(false);
      expect(rejected.responses[0]?.[2]?.message).toBe("dispatch rejected");

      const edit = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "edit" },
        client("owner", "Owner"),
      );
      expect(edit.responses[0]?.[0]).toBe(true);
    });
  });
});
