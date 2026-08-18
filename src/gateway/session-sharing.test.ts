import { afterEach, describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionGroupHandlers } from "./server-methods/sessions-groups.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import {
  listSessionGroupDefaults,
  putSessionGroups,
  updateSessionGroupDefaults,
} from "./session-groups.js";
import {
  allowedSessionVisibilities,
  authorizeIncognitoSessionTarget,
  resolveSessionMutationAuthorization,
  canReceiveSessionEvent,
  createSessionListEntryFilter,
  resolveSessionSharingRole,
  resolveSessionVisibility,
  SessionMutationAuthorizationChangedError,
} from "./session-sharing.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

type SharingTarget = Parameters<typeof resolveSessionSharingRole>[0]["target"];

function isListed(
  requestClient: GatewayClient,
  sessionKey: string,
  entry: SharingTarget["entry"],
): boolean {
  return createSessionListEntryFilter({ client: requestClient })?.(sessionKey, entry) ?? true;
}

function client(params: {
  user?: string;
  deviceId?: string;
  displayName?: string;
  scopes?: string[];
}): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
        ...(params.displayName ? { displayName: params.displayName } : {}),
      },
      role: "operator",
      scopes: params.scopes ?? ["operator.read", "operator.write"],
      ...(params.deviceId
        ? {
            device: {
              id: params.deviceId,
              publicKey: "key",
              signature: "signature",
              signedAt: 1,
              nonce: "nonce",
            },
          }
        : {}),
    },
    ...(params.user
      ? {
          authenticatedUserId: params.user,
          authenticatedUserProfile: {
            profileId: params.user,
            displayName: params.displayName ?? null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

function target(createdActor?: { type: "human"; id: string; label?: string }): SharingTarget {
  return {
    agentId: "main",
    canonicalKey: "agent:main:main",
    entry: {
      sessionId: "session-main",
      updatedAt: 1,
      visibility: "draft",
      ...(createdActor ? { createdActor } : {}),
    },
    storeKey: "agent:main:main",
    storeKeys: ["agent:main:main"],
    storePath: "/tmp/sessions.json",
  };
}

describe("session sharing policy", () => {
  it("requires participation before sessions.create can adopt a categorized key", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:dashboard:categorized-adoption";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-categorized-adoption",
          updatedAt: 1,
          visibility: "read-only",
          category: "Personal",
          createdActor: { type: "human", id: "owner@example.com" },
        },
      );

      const authorization = resolveSessionMutationAuthorization({
        client: client({ user: "viewer@example.com" }),
        method: "sessions.create",
        requestParams: { key: sessionKey, category: "Projects" },
        context: { getRuntimeConfig: () => ({}) } as GatewayRequestContext,
      });

      expect(authorization.error).toMatchObject({
        details: { code: "SESSION_PARTICIPATION_REQUIRED" },
      });
    });
  });

  it("extracts every message-cut lifecycle target from sessionKey", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:message-cut-target";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-message-cut-target",
          updatedAt: 1,
          visibility: "read-only",
          createdActor: { type: "human", id: "owner" },
        },
      );
      const context = { getRuntimeConfig: () => ({}) } as GatewayRequestContext;
      for (const method of ["sessions.fork", "sessions.rewind", "sessions.branches.switch"]) {
        expect(
          resolveSessionMutationAuthorization({
            client: client({ user: "owner" }),
            method,
            requestParams: { sessionKey },
            context,
          }),
        ).toMatchObject({ error: null, authorization: expect.any(Object) });
        expect(
          resolveSessionMutationAuthorization({
            client: client({ user: "outsider" }),
            method,
            requestParams: { sessionKey },
            context,
          }).error,
        ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      }
    });
  });

  it("rechecks group members before committing a defaults update", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      putSessionGroups(["Race"]);
      updateSessionGroupDefaults("Race", { cwd: "/repos/race", worktree: true });
      const viewer = client({ user: "viewer@example.com" });
      const context = {
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;
      const authorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.update",
        requestParams: { name: " Race ", cwd: null, worktree: false },
        context,
      });
      expect(authorization.error).toBeNull();

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:late-restricted-member" },
        {
          sessionId: "session-late-restricted-member",
          updatedAt: 1,
          visibility: "read-only",
          category: "Race",
          createdActor: { type: "human", id: "owner@example.com" },
        },
      );

      await expect(
        sessionGroupHandlers["sessions.groups.update"]?.({
          params: { name: " Race ", cwd: null, worktree: false },
          client: viewer,
          context,
          sessionMutationAuthorization: authorization.authorization,
          respond: () => undefined,
        } as never),
      ).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
      expect(listSessionGroupDefaults()).toEqual([
        { name: "Race", cwd: "/repos/race", worktree: true },
      ]);
    });
  });

  it("filters group defaults and blocks updates for sessions the caller cannot mutate", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      putSessionGroups(["Projects", "Personal"]);
      updateSessionGroupDefaults("Projects", { cwd: "/repos/projects", worktree: true });
      updateSessionGroupDefaults("Personal", { cwd: "/repos/personal", worktree: false });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:restricted-project" },
        {
          sessionId: "session-restricted-project",
          updatedAt: 1,
          visibility: "read-only",
          category: "Projects",
          createdActor: { type: "human", id: "owner@example.com" },
        },
      );
      const viewer = client({ user: "viewer@example.com" });
      const context = {
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;

      expect(
        resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.update",
          requestParams: { name: "Projects", cwd: null, worktree: false },
          context,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });

      const responses: Parameters<RespondFn>[] = [];
      await sessionGroupHandlers["sessions.groups.defaults"]?.({
        params: {},
        client: viewer,
        context,
        respond: (...response: Parameters<RespondFn>) => responses.push(response),
      } as never);
      expect(responses).toEqual([
        [
          true,
          { defaults: [{ name: "Personal", cwd: "/repos/personal", worktree: false }] },
          undefined,
        ],
      ]);

      const personalAuthorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.update",
        requestParams: { name: "Personal", cwd: null, worktree: false },
        context,
      });
      expect(personalAuthorization.error).toBeNull();
      const updateResponses: Parameters<RespondFn>[] = [];
      await sessionGroupHandlers["sessions.groups.update"]?.({
        params: { name: "Personal", cwd: null, worktree: false },
        client: viewer,
        context,
        sessionMutationAuthorization: personalAuthorization.authorization,
        respond: (...response: Parameters<RespondFn>) => updateResponses.push(response),
      } as never);
      expect(updateResponses).toEqual([
        [true, { ok: true, defaults: [{ name: "Personal", worktree: false }] }, undefined],
      ]);
    });
  });

  it("reports an incognito denial against the caller's requested key", () => {
    const hiddenTarget = {
      ...target({ type: "human", id: "owner@example.com" }),
      canonicalKey: "agent:main:dashboard:incognito-private",
      entry: {
        sessionId: "session-incognito",
        updatedAt: 1,
        visibility: "suggest" as const,
        incognito: true as const,
      },
    };
    expect(
      authorizeIncognitoSessionTarget({
        client: client({ user: "viewer@example.com" }),
        sessionKey: "requested-incognito-alias",
        target: hiddenTarget,
      })?.message,
    ).toBe('Incognito session "requested-incognito-alias" was not found.');
  });

  it("keeps identity-less solo mode owner-equivalent for restricted sessions", () => {
    const role = resolveSessionSharingRole({ client: client({}), target: target() });
    expect(role).toBe("owner");
  });

  it("uses only the trusted operator identity prepared during connection admission", () => {
    expect(
      resolveSessionSharingRole({
        client: client({ user: "alice@example.com" }),
        target: target({ type: "human", id: "alice@example.com", label: "Alice" }),
      }),
    ).toBe("owner");

    const rawHandshakeOnly = client({});
    rawHandshakeOnly.authenticatedUserId = "viewer@example.com";
    rawHandshakeOnly.connect.device = {
      id: "viewer-device",
      publicKey: "key",
      signature: "signature",
      signedAt: 1,
      nonce: "nonce",
    };
    expect(
      resolveSessionSharingRole({
        client: rawHandshakeOnly,
        target: target({ type: "human", id: "owner@example.com", label: "Owner" }),
      }),
    ).toBe("owner");
  });

  it("uses the landed createdActor contract and hides drafts from other identified operators", () => {
    const owner = client({ user: "owner@example.com" });
    const viewer = client({ user: "viewer@example.com" });
    const entry = {
      sessionId: "session-main",
      updatedAt: 1,
      visibility: "draft" as const,
      createdActor: { type: "human" as const, id: "owner@example.com", label: "Owner" },
    };
    expect(isListed(owner, "main", entry)).toBe(true);
    expect(isListed(viewer, "main", entry)).toBe(false);
  });

  it("keeps incognito admin-only while treating identityless connections as owner-equivalent", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:dashboard:incognito-private";
      const entry = {
        sessionId: "session-incognito",
        updatedAt: 1,
        visibility: "shared" as const,
        incognito: true as const,
        createdActor: { type: "human" as const, id: "owner@example.com" },
      };
      await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
      const owner = client({ user: "owner@example.com" });
      const viewer = client({ user: "viewer@example.com" });
      const admin = client({ user: "admin@example.com", scopes: ["operator.admin"] });
      const solo = client({});
      const cfg = {};
      const context = { chatAbortControllers: new Map(), getRuntimeConfig: () => cfg } as never;

      for (const visibleClient of [admin, solo]) {
        expect(isListed(visibleClient, sessionKey, entry)).toBe(true);
        expect(
          canReceiveSessionEvent({
            cfg,
            client: visibleClient as never,
            sessionKeys: [sessionKey],
          }),
        ).toBe(true);
        expect(
          resolveSessionMutationAuthorization({
            client: visibleClient,
            method: "chat.send",
            requestParams: { sessionKey },
            context,
          }).error,
        ).toBeNull();
      }

      for (const hiddenClient of [owner, viewer]) {
        expect(isListed(hiddenClient, sessionKey, entry)).toBe(false);
        expect(
          canReceiveSessionEvent({
            cfg,
            client: hiddenClient as never,
            sessionKeys: [sessionKey],
          }),
        ).toBe(false);
        expect(
          resolveSessionMutationAuthorization({
            client: hiddenClient,
            method: "chat.send",
            requestParams: { sessionKey },
            context,
          }).error,
        ).toMatchObject({
          code: "INVALID_REQUEST",
          message: `Incognito session "${sessionKey}" was not found.`,
        });
      }
    });
  });

  it("defaults legacy entries and omitted policy flags to enabled", () => {
    expect(resolveSessionVisibility({})).toBe("shared");
    expect(allowedSessionVisibilities({})).toEqual(["shared", "read-only", "suggest", "draft"]);
    expect(allowedSessionVisibilities({ session: { sharing: { suggest: false } } })).toEqual([
      "shared",
      "read-only",
      "draft",
    ]);
  });

  it("keeps agent scope for indirect run and approval authorization", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "global" },
        { sessionId: "session-main-global", updatedAt: 1, visibility: "shared" },
      );
      await upsertSessionEntryCore(
        { agentId: "work", sessionKey: "global" },
        {
          sessionId: "session-work-global",
          updatedAt: 1,
          visibility: "read-only",
          createdActor: { type: "human", id: "owner@example.com" },
        },
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:solo-draft" },
        { sessionId: "session-solo-draft", updatedAt: 1, visibility: "draft" },
      );
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      } as never;
      const context = {
        chatAbortControllers: new Map([["run-1", { sessionKey: "global", agentId: "work" }]]),
        execApprovalManager: {
          lookupApprovalId: () => ({ kind: "exact", id: "approval-1" }),
          getSnapshot: () => ({ request: { sessionKey: "global", agentId: "work" } }),
        },
        getRuntimeConfig: () => cfg,
      } as never;
      const outsider = client({ user: "outsider@example.com" });

      for (const [method, requestParams] of [
        ["sessions.abort", { runId: "run-1" }],
        ["exec.approval.resolve", { id: "approval-1" }],
      ] as const) {
        expect(
          resolveSessionMutationAuthorization({ client: outsider, method, requestParams, context })
            .error,
        ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      }
      expect(
        resolveSessionMutationAuthorization({
          client: client({}),
          method: "chat.send",
          requestParams: { sessionKey: "agent:main:solo-draft" },
          context,
        }).error,
      ).toBeNull();
    });
  });

  it("fails closed when a required session mutation has no target", () => {
    const context = { chatAbortControllers: new Map(), getRuntimeConfig: () => ({}) } as never;
    expect(
      resolveSessionMutationAuthorization({
        client: client({}),
        method: "sessions.reset",
        requestParams: {},
        context,
      }).error,
    ).toMatchObject({ details: { code: "SESSION_MUTATION_TARGET_REQUIRED" } });
    expect(
      resolveSessionMutationAuthorization({
        client: client({ scopes: ["operator.admin"] }),
        method: "sessions.reset",
        requestParams: {},
        context,
      }).error,
    ).toBeNull();
  });

  it("fails closed for scoped events whose session row was deleted", () => {
    expect(
      canReceiveSessionEvent({
        cfg: {},
        client: client({ user: "viewer@example.com" }) as never,
        sessionKeys: ["agent:main:deleted-draft"],
      }),
    ).toBe(false);
  });

  it("limits suggestion events to participants and the suggestion author", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:suggestions";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-suggestions",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "suggest",
        },
      );
      addSessionMember(
        { agentId: "main", sessionKey },
        {
          identityId: "member",
          addedBy: "owner",
          expectedSessionId: "session-suggestions",
        },
      );
      const check = (user: string) =>
        canReceiveSessionEvent({
          cfg: {},
          client: client({ user }) as never,
          sessionKeys: [sessionKey],
          event: "session.suggestion",
          payload: { suggestion: { author: { id: "author" } } },
        });

      expect(check("author")).toBe(true);
      expect(check("member")).toBe(true);
      expect(check("owner")).toBe(true);
      expect(check("viewer")).toBe(false);
      expect(
        canReceiveSessionEvent({
          cfg: {},
          client: client({}) as never,
          sessionKeys: [sessionKey],
          event: "session.suggestion",
          payload: { suggestion: { author: { id: "author" } } },
        }),
      ).toBe(false);
    });
  });

  it("keeps draft typing events owner and admin only", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:draft-typing";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-draft",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "draft",
        },
      );
      addSessionMember(
        { agentId: "main", sessionKey },
        { identityId: "member", addedBy: "owner", expectedSessionId: "session-draft" },
      );
      const check = (user: string, event: string) =>
        canReceiveSessionEvent({
          cfg: {},
          client: client({ user }) as never,
          sessionKeys: [sessionKey],
          event,
        });

      expect(check("owner", "session.typing")).toBe(true);
      expect(check("member", "session.typing")).toBe(false);
      expect(check("viewer", "session.typing")).toBe(false);
      expect(check("member", "session.message")).toBe(false);
      expect(
        canReceiveSessionEvent({
          cfg: {},
          client: client({ user: "admin", scopes: ["operator.admin"] }) as never,
          sessionKeys: [sessionKey],
          event: "session.typing",
        }),
      ).toBe(true);
      expect(
        canReceiveSessionEvent({
          cfg: {},
          client: client({}) as never,
          sessionKeys: [sessionKey],
          event: "session.typing",
        }),
      ).toBe(false);
    });
  });
});
