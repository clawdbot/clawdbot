import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntry,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  listSessionMembers,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail, listProfiles, setDisplayName } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createBoardViewTicket } from "../board-view-ticket.js";
import {
  authorizeResolvedSessionMutation,
  resolveSessionMutationAuthorization,
  canReceiveSessionEvent,
  filterDraftSessionsForClient,
  invalidateSessionSharingSnapshot,
} from "../session-sharing.js";
import { sessionReadHandlers } from "./sessions-read.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type ResolveSessionSharingTarget =
  (typeof import("../session-sharing.js"))["resolveSessionSharingTarget"];

const targetResolutionMock = vi.hoisted(() => ({
  calls: 0,
  override: undefined as
    | undefined
    | ((
        target: ReturnType<ResolveSessionSharingTarget>,
        callIndex: number,
      ) => ReturnType<ResolveSessionSharingTarget>),
}));

vi.mock("../session-sharing.js", async () => {
  const actual =
    await vi.importActual<typeof import("../session-sharing.js")>("../session-sharing.js");
  return {
    ...actual,
    resolveSessionSharingTarget: (params: Parameters<ResolveSessionSharingTarget>[0]) => {
      const target = actual.resolveSessionSharingTarget(params);
      const callIndex = ++targetResolutionMock.calls;
      return targetResolutionMock.override?.(target, callIndex) ?? target;
    },
  };
});

afterEach(() => {
  targetResolutionMock.calls = 0;
  targetResolutionMock.override = undefined;
  closeOpenClawAgentDatabasesForTest();
});

function soloClient(): GatewayClient {
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
  };
}

function identifiedClient(profileId: string, displayName: string | null = null): GatewayClient {
  return {
    ...soloClient(),
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: {
      profileId,
      displayName,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

function context(
  broadcast: ReturnType<typeof vi.fn>,
  runtimeConfig: ReturnType<GatewayRequestContext["getRuntimeConfig"]> = {},
): GatewayRequestContext {
  return {
    getRuntimeConfig: () => runtimeConfig,
    broadcast,
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
}

async function call(
  method: "session.visibility.set" | "session.members.list" | "session.members.add",
  params: Record<string, unknown>,
  requestContext: GatewayRequestContext,
  requestClient: GatewayClient = soloClient(),
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionSharingHandlers[method]?.({
    params,
    client: requestClient,
    context: requestContext,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  return responses;
}

describe("session sharing handlers", () => {
  it("keeps hidden incognito rows from changing non-owner list path metadata", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const incognitoKey = "agent:main:dashboard:incognito-private";
      await upsertSessionEntry(
        { agentId: "main", sessionKey: "agent:main:main" },
        { sessionId: "session-main", updatedAt: 1 },
      );
      const viewer = identifiedClient("viewer@example.com");
      const admin = soloClient();
      admin.connect.scopes = ["operator.admin"];
      const listFor = async (client: GatewayClient) => {
        const responses: Parameters<RespondFn>[] = [];
        await sessionReadHandlers["sessions.list"]?.({
          params: {},
          client,
          context: {
            ...context(vi.fn()),
            loadGatewayModelCatalog: async () => [],
          } as unknown as GatewayRequestContext,
          respond: (...response: Parameters<RespondFn>) => responses.push(response),
        } as never);
        return responses[0]?.[1] as
          | { path?: string; sessions?: Array<{ key: string }> }
          | undefined;
      };

      const before = await listFor(viewer);
      await upsertSessionEntry(
        {
          agentId: "main",
          sessionKey: incognitoKey,
          storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        },
        {
          sessionId: "session-incognito",
          updatedAt: 2,
          incognito: true,
          visibility: "shared",
          createdActor: { type: "human", id: "owner@example.com" },
        },
      );

      const hidden = await listFor(viewer);
      expect(hidden?.path).toBe(before?.path);
      expect(hidden?.sessions?.some((session) => session.key === incognitoKey)).toBe(false);
      const creator = await listFor(identifiedClient("owner@example.com"));
      expect(creator?.path).toBe(before?.path);
      expect(creator?.sessions?.some((session) => session.key === incognitoKey)).toBe(false);
      const visible = await listFor(admin);
      expect(visible?.sessions?.some((session) => session.key === incognitoKey)).toBe(true);
      expect(visible?.path).not.toBe(before?.path);
    });
  });

  it("rejects a visibility mutation when the queued session instance changed", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:stale-sharing-mutation";
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-authorized",
          updatedAt: 1,
          visibility: "shared",
        },
      );
      targetResolutionMock.override = (target, callIndex) =>
        callIndex === 2 && target
          ? {
              ...target,
              entry: { ...target.entry, sessionId: "session-replaced" },
            }
          : target;
      const broadcast = vi.fn();
      const respond = vi.fn();

      await expect(
        sessionSharingHandlers["session.visibility.set"]?.({
          params: { sessionKey, visibility: "draft" },
          client: soloClient(),
          context: context(broadcast),
          respond,
        } as never),
      ).rejects.toThrow("session changed before sharing mutation");

      expect(loadSessionEntry({ agentId: "main", sessionKey })?.visibility).toBe("shared");
      expect(respond).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalledWith(
        "session.sharing",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  it("authorizes runs against the resolved session so keyless runs cannot bypass restriction", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:main";
      const owner = { id: "owner@example.com", label: "Owner" };
      const outsider = identifiedClient("outsider");
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          createdActor: { type: "human", ...owner },
          visibility: "read-only",
        },
      );

      // The agent-run handler authorizes this resolved (default/effective) key
      // even when the request omitted sessionKey; a non-participant is blocked.
      expect(
        authorizeResolvedSessionMutation({
          cfg: {},
          client: outsider,
          sessionKey,
          agentId: "main",
        }),
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      // The owner, and a not-yet-created session, both pass.
      expect(
        authorizeResolvedSessionMutation({
          cfg: {},
          client: identifiedClient(owner.id, owner.label),
          sessionKey,
          agentId: "main",
        }),
      ).toBeNull();
      expect(
        authorizeResolvedSessionMutation({
          cfg: {},
          client: outsider,
          sessionKey: "agent:main:fresh",
          agentId: "main",
        }),
      ).toBeNull();
    });
  });

  it("projects a shared session member's truthful role in sessions.list", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:shared-member";
      const memberIdentity = { id: "member@example.com", label: "Member" };
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-shared-member",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner@example.com" },
          visibility: "shared",
        },
      );
      expect(
        addSessionMember(
          { agentId: "main", sessionKey },
          { identityId: memberIdentity.id, addedBy: "owner@example.com", addedAt: 1 },
        ).inserted,
      ).toBe(true);
      const responses: Parameters<RespondFn>[] = [];
      await sessionReadHandlers["sessions.list"]?.({
        params: { agentId: "main" },
        client: identifiedClient(memberIdentity.id, memberIdentity.label),
        context: {
          ...context(vi.fn()),
          loadGatewayModelCatalog: async () => [],
        } as unknown as GatewayRequestContext,
        respond: (...response: Parameters<RespondFn>) => responses.push(response),
      } as never);

      expect(responses[0]?.[0]).toBe(true);
      const payload = responses[0]?.[1] as
        | { sessions?: Array<{ key: string; sharingRole?: string }> }
        | undefined;
      expect(payload?.sessions?.find((session) => session.key === sessionKey)?.sharingRole).toBe(
        "member",
      );
    });
  });

  it("drops a session flipped to draft during the list await from a non-owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:mid-await-draft";
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-mid-await",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner@example.com" },
          visibility: "shared",
        },
      );
      // A member of the (soon-draft) session must also lose it: drafts are
      // owner+admin only.
      expect(
        addSessionMember(
          { agentId: "main", sessionKey },
          { identityId: "member@example.com", addedBy: "owner@example.com", addedAt: 1 },
        ).inserted,
      ).toBe(true);
      const outsider = identifiedClient("outsider@example.com");
      // The awaited model-catalog step flips the session to draft after the
      // pre-await draft filter ran, exercising the final fresh-target filter.
      const listWith = async (client: GatewayClient) => {
        await patchSessionEntry({ agentId: "main", sessionKey }, () => ({ visibility: "shared" }));
        invalidateSessionSharingSnapshot(sessionKey);
        const responses: Parameters<RespondFn>[] = [];
        await sessionReadHandlers["sessions.list"]?.({
          params: { agentId: "main" },
          client,
          context: {
            ...context(vi.fn()),
            loadGatewayModelCatalog: async () => {
              await patchSessionEntry({ agentId: "main", sessionKey }, () => ({
                visibility: "draft",
              }));
              invalidateSessionSharingSnapshot(sessionKey);
              return [];
            },
          } as unknown as GatewayRequestContext,
          respond: (...response: Parameters<RespondFn>) => responses.push(response),
        } as never);
        return (responses[0]?.[1] as { sessions?: Array<{ key: string }> } | undefined)?.sessions;
      };

      // Non-owner must not receive the now-draft row (no preview/metadata leak).
      expect((await listWith(outsider))?.some((session) => session.key === sessionKey)).toBe(false);
      // A member also loses a draft (owner+admin only).
      expect(
        (await listWith(identifiedClient("member@example.com")))?.some(
          (session) => session.key === sessionKey,
        ),
      ).toBe(false);
      // The owner still sees their own draft.
      expect(
        (await listWith(identifiedClient("owner@example.com")))?.some(
          (session) => session.key === sessionKey,
        ),
      ).toBe(true);
    });
  });

  it("lists profile ids and authorizes a selected profile as a member", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:profile-member";
      const profile = ensureProfileForEmail("member@example.com");
      setDisplayName(profile.id, "Member");
      const selectable = listProfiles().find((item) => item.id === profile.id);
      expect(selectable).toMatchObject({ id: profile.id, displayName: "Member" });
      if (!selectable) {
        throw new Error("expected member profile in picker identities");
      }
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-profile-member",
          updatedAt: 1,
          visibility: "read-only",
        },
      );
      const requestContext = context(vi.fn());

      const listed = await call("session.members.list", { sessionKey }, requestContext);
      expect(listed[0]?.[1]).toMatchObject({
        identities: expect.arrayContaining([
          expect.objectContaining({ type: "human", id: profile.id, label: "Member" }),
        ]),
      });
      expect(
        await call(
          "session.members.add",
          { sessionKey, identityId: selectable.id },
          requestContext,
        ),
      ).toEqual([[true, { ok: true, sessionKey, identityId: profile.id }, undefined]]);
      expect(
        authorizeResolvedSessionMutation({
          cfg: {},
          client: identifiedClient(profile.id, "Member"),
          sessionKey,
          agentId: "main",
        }),
      ).toBeNull();
    });
  });

  it("stores and lists membership against an alias-backed session row", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const canonicalKey = "agent:ops:work";
      const aliasKey = "agent:ops:main";
      const cfg = {
        session: { mainKey: "work" },
        agents: { list: [{ id: "ops", default: true }] },
      } as ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
      const profile = ensureProfileForEmail("alias-member@example.com");
      await upsertSessionEntry(
        { agentId: "ops", sessionKey: canonicalKey },
        { sessionId: "session-alias-member", updatedAt: 1, visibility: "read-only" },
      );
      const database = openOpenClawAgentDatabase({ agentId: "ops", env: state.env });
      database.db.exec("PRAGMA foreign_keys = OFF;");
      try {
        database.db
          .prepare("UPDATE session_nodes SET session_key = ? WHERE session_key = ?")
          .run(aliasKey, canonicalKey);
        database.db
          .prepare("UPDATE session_windows SET session_key = ? WHERE session_key = ?")
          .run(aliasKey, canonicalKey);
      } finally {
        database.db.exec("PRAGMA foreign_keys = ON;");
      }
      expect(
        database.db
          .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
          .get(canonicalKey),
      ).toBeUndefined();
      clearSessionStoreCacheForTest();
      const requestContext = context(vi.fn(), cfg);

      expect(
        await call(
          "session.members.add",
          { sessionKey: aliasKey, identityId: profile.id },
          requestContext,
        ),
      ).toEqual([
        [true, { ok: true, sessionKey: canonicalKey, identityId: profile.id }, undefined],
      ]);
      expect(listSessionMembers({ agentId: "ops", sessionKey: aliasKey })).toEqual([
        expect.objectContaining({ identityId: profile.id }),
      ]);
      const listed = await call("session.members.list", { sessionKey: aliasKey }, requestContext);
      expect(listed[0]?.[1]).toMatchObject({
        sessionKey: canonicalKey,
        members: [expect.objectContaining({ identityId: profile.id })],
      });
    });
  });

  it("authorizes board tickets against their signed agent-relative session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntry(
        { agentId: "main", sessionKey: "global" },
        { sessionId: "session-main-global", updatedAt: 1, visibility: "shared" },
      );
      await upsertSessionEntry(
        { agentId: "work", sessionKey: "global" },
        {
          sessionId: "session-work-global",
          updatedAt: 1,
          visibility: "read-only",
          createdActor: { type: "human", id: "owner@example.com" },
        },
      );
      const { ticket } = createBoardViewTicket({
        sessionKey: "global",
        agentId: "work",
        name: "status",
        revision: 1,
        viewGeneration: "a".repeat(32),
      });
      const memberClient = identifiedClient("outsider@example.com");
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      } as ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
      const requestContext = context(vi.fn(), cfg);

      expect(
        resolveSessionMutationAuthorization({
          client: memberClient,
          method: "board.action",
          requestParams: { ticket, agentId: "work" },
          context: requestContext,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });

      const { ticket: unscopedTicket } = createBoardViewTicket({
        sessionKey: "global",
        name: "status",
        revision: 1,
        viewGeneration: "b".repeat(32),
      });
      expect(
        resolveSessionMutationAuthorization({
          client: memberClient,
          method: "board.action",
          requestParams: { ticket: unscopedTicket, agentId: "work" },
          context: requestContext,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_MUTATION_TARGET_REQUIRED" } });
    });
  });

  it("revokes all member access while a session is draft and restores it when shared", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:member-transition";
      const owner = { id: "owner@example.com", label: "Owner" };
      const memberIdentity = { id: "member@example.com", label: "Member" };
      const memberClient = identifiedClient(memberIdentity.id, memberIdentity.label);
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-member-transition",
          updatedAt: 1,
          createdActor: { type: "human", ...owner },
          visibility: "shared",
        },
      );
      expect(
        addSessionMember(
          { agentId: "main", sessionKey },
          { identityId: memberIdentity.id, addedBy: owner.id, addedAt: 1 },
        ).inserted,
      ).toBe(true);
      const requestContext = {
        ...context(vi.fn()),
        execApprovalManager: {
          lookupApprovalId: () => ({ kind: "exact", id: "approval-1" }),
          getSnapshot: () => ({ request: { sessionKey, agentId: "main" } }),
        },
      } as unknown as GatewayRequestContext;
      const mutations: Array<[string, Record<string, unknown>]> = [
        ["chat.send", { sessionKey }],
        ["sessions.steer", { key: sessionKey }],
        ["sessions.abort", { key: sessionKey }],
        ["exec.approval.resolve", { id: "approval-1" }],
      ];
      const expectAccess = (allowed: boolean) => {
        for (const [method, requestParams] of mutations) {
          const error = resolveSessionMutationAuthorization({
            client: memberClient,
            method,
            requestParams,
            context: requestContext,
          }).error;
          if (allowed) {
            expect(error, method).toBeNull();
          } else {
            expect(error, method).toMatchObject({
              details: { code: "SESSION_PARTICIPATION_REQUIRED" },
            });
          }
        }
        const entry = loadSessionEntry({ agentId: "main", sessionKey });
        if (!entry) {
          throw new Error("expected member transition session entry");
        }
        const listed = filterDraftSessionsForClient({
          client: memberClient,
          store: { [sessionKey]: entry },
        });
        expect(Object.hasOwn(listed, sessionKey)).toBe(allowed);
        expect(
          canReceiveSessionEvent({
            cfg: {},
            client: memberClient as never,
            sessionKeys: [sessionKey],
            agentId: "main",
          }),
        ).toBe(allowed);
      };

      expectAccess(true);
      await patchSessionEntry({ agentId: "main", sessionKey }, () => ({ visibility: "draft" }));
      invalidateSessionSharingSnapshot(sessionKey);
      expectAccess(false);
      await patchSessionEntry({ agentId: "main", sessionKey }, () => ({ visibility: "shared" }));
      invalidateSessionSharingSnapshot(sessionKey);
      expectAccess(true);
    });
  });

  it("persists visibility and membership changes as transcript system notes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:main";
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        { sessionId: "session-main", updatedAt: 1 },
      );
      const broadcast = vi.fn();
      const requestContext = context(broadcast);

      expect(
        await call(
          "session.visibility.set",
          { sessionKey, visibility: "read-only" },
          requestContext,
        ),
      ).toEqual([[true, { ok: true, sessionKey, visibility: "read-only" }, undefined]]);
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.visibility).toBe("read-only");

      expect(
        await call(
          "session.members.add",
          { sessionKey, identityId: "local-operator" },
          requestContext,
        ),
      ).toEqual([[true, { ok: true, sessionKey, identityId: "local-operator" }, undefined]]);
      expect(listSessionMembers({ agentId: "main", sessionKey })).toEqual([
        expect.objectContaining({ identityId: "local-operator", addedBy: "local-operator" }),
      ]);

      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId: "session-main",
        sessionKey,
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({
              customType: "openclaw.system-note",
              content: expect.stringContaining("changed session visibility"),
            }),
          }),
          expect.objectContaining({
            message: expect.objectContaining({
              customType: "openclaw.system-note",
              content: expect.stringContaining("added local-operator"),
            }),
          }),
        ]),
      );
      expect(broadcast).toHaveBeenCalledWith(
        "session.sharing",
        expect.objectContaining({ sessionKey }),
        { sessionKeys: [sessionKey] },
      );

      const restrictedKey = "agent:main:restricted";
      await upsertSessionEntry(
        { agentId: "main", sessionKey: restrictedKey },
        {
          sessionId: "session-restricted",
          updatedAt: 2,
          visibility: "read-only",
          category: "Projects",
        },
      );
      expect(
        resolveSessionMutationAuthorization({
          client: identifiedClient("viewer"),
          method: "sessions.groups.delete",
          requestParams: { name: "Projects" },
          context: requestContext,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      expect(
        await call("session.members.list", { sessionKey: restrictedKey }, requestContext, {
          ...identifiedClient("viewer"),
        }),
      ).toEqual([
        [
          false,
          undefined,
          expect.objectContaining({
            details: expect.objectContaining({ code: "SESSION_SHARING_MANAGER_REQUIRED" }),
          }),
        ],
      ]);

      await patchSessionEntry({ agentId: "main", sessionKey }, () => ({ visibility: "shared" }));
      invalidateSessionSharingSnapshot();
      const viewerClient = identifiedClient("viewer") as never;
      expect(
        canReceiveSessionEvent({
          cfg: {},
          client: viewerClient,
          sessionKeys: ["main"],
          agentId: "main",
        }),
      ).toBe(true);
      await patchSessionEntry({ agentId: "main", sessionKey }, () => ({ visibility: "draft" }));
      invalidateSessionSharingSnapshot(sessionKey);
      expect(
        canReceiveSessionEvent({
          cfg: {},
          client: viewerClient,
          sessionKeys: ["main"],
          agentId: "main",
        }),
      ).toBe(false);

      await patchSessionEntry({ agentId: "main", sessionKey }, () => ({ visibility: "shared" }));
      const append = vi
        .spyOn(SessionManager.prototype, "appendMessage")
        .mockImplementationOnce(() => {
          throw new Error("audit unavailable");
        });
      const concurrent = await Promise.allSettled([
        call("session.visibility.set", { sessionKey, visibility: "read-only" }, requestContext),
        call("session.visibility.set", { sessionKey, visibility: "draft" }, requestContext),
      ]);
      append.mockRestore();
      expect(concurrent.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.visibility).toBe("draft");

      removeSessionMember({ agentId: "main", sessionKey }, "local-operator");
      const memberAppend = vi
        .spyOn(SessionManager.prototype, "appendMessage")
        .mockImplementationOnce(() => {
          throw new Error("audit unavailable");
        });
      const concurrentAdds = await Promise.allSettled([
        call("session.members.add", { sessionKey, identityId: "local-operator" }, requestContext),
        call("session.members.add", { sessionKey, identityId: "local-operator" }, requestContext),
      ]);
      memberAppend.mockRestore();
      expect(concurrentAdds.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
      expect(listSessionMembers({ agentId: "main", sessionKey })).toEqual([
        expect.objectContaining({ identityId: "local-operator" }),
      ]);
    });
  });
});
