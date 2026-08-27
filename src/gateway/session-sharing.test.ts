import { afterEach, describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
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
  authorizeResolvedSessionMutation,
  authorizeSessionSharingTarget,
  resolveSessionMutationAuthorization,
  canReceiveSessionEvent,
  createSessionListEntryFilter,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
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
  githubSyncPending?: boolean;
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
    ...(params.githubSyncPending
      ? {
          authenticatedGitHubIdentitySync: async () => ({ profileId: "pending", updatedAt: 1 }),
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

function rolePolicyConfig(writeAgents: "*" | string[] = "*"): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "view",
        definitions: {
          none: {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
          view: {
            sessions: { others: "view" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
          suggest: {
            sessions: { others: "suggest" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
          write: {
            sessions: { others: "write" },
            agents: writeAgents,
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
}

function roleClient(
  role: "none" | "view" | "suggest" | "write",
  label: string = role,
): GatewayClient {
  const profile = ensureProfileForEmail(`${label}@example.test`);
  setUserProfileRole(profile.id, role);
  return client({ user: profile.id });
}

describe("session sharing policy", () => {
  it("denies starting a run on an existing foreign-agent session despite foreign-session write access", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig(["guest-agent"]);
      const writer = roleClient("write", "foreign-agent-writer");
      const owner = ensureProfileForEmail("foreign-agent-owner@example.test");
      const sessionKey = "agent:main:existing-maintainer-session";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "existing-maintainer-session",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", id: owner.id },
        },
      );

      expect(
        authorizeResolvedSessionMutation({
          cfg,
          client: writer,
          sessionKey,
          agentId: "main",
        }),
      ).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("main") });
      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
      for (const [method, requestParams] of [
        ["agent", { sessionKey }],
        ["chat.send", { sessionKey }],
        ["message.action", { sessionKey }],
        ["send", { sessionKey }],
        ["sessions.dispatch", { key: sessionKey }],
        ["sessions.send", { key: sessionKey }],
        ["sessions.steer", { key: sessionKey }],
        ["talk.client.create", { sessionKey }],
        ["talk.session.create", { sessionKey }],
        ["tools.invoke", { sessionKey }],
        ["wake", { sessionKey }],
      ] as const) {
        expect(
          resolveSessionMutationAuthorization({ client: writer, method, requestParams, context })
            .error,
          method,
        ).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("main") });
      }
      expect(
        resolveSessionMutationAuthorization({
          client: writer,
          method: "sessions.patch",
          requestParams: { key: sessionKey },
          context,
        }).error,
      ).toBeNull();
    });
  });

  it("enforces closed role ceilings above shared visibility while preserving explicit membership and admin access", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const owner = roleClient("none", "owner");
      const ownerId = owner.authenticatedUserProfile?.profileId;
      const sessionKey = "agent:main:team-shared";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-team-shared",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", id: ownerId! },
        },
      );
      const sharedTarget = resolveSessionSharingTarget({ cfg, sessionKey });
      expect(sharedTarget).not.toBeNull();
      if (!sharedTarget) {
        throw new Error("expected persisted team session");
      }

      for (const roleName of ["view", "suggest"] as const) {
        const viewer = roleClient(roleName);
        expect(resolveSessionSharingRole({ cfg, client: viewer, target: sharedTarget })).toBe(
          "viewer",
        );
        expect(
          authorizeSessionSharingTarget({ cfg, client: viewer, target: sharedTarget }),
        ).toMatchObject({
          details: { code: "SESSION_PARTICIPATION_REQUIRED", visibility: "shared" },
        });
        for (const method of [
          "chat.send",
          "mcp.app.callTool",
          "mcp.app.updateModelContext",
          "talk.client.create",
          "talk.client.toolCall",
          "talk.client.transcript",
          "talk.client.close",
          "talk.client.steer",
          "talk.session.create",
          "talk.session.steer",
          "taskSuggestions.create",
          "sessions.companion.reset",
          "wake",
        ]) {
          expect(
            resolveSessionMutationAuthorization({
              client: viewer,
              method,
              requestParams: { sessionKey },
              context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
            }).error,
            `${roleName}: ${method}`,
          ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
        }
        expect(
          resolveSessionMutationAuthorization({
            client: viewer,
            method: "sessions.assignOwner",
            requestParams: { key: sessionKey },
            context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
          }).error,
        ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
        for (const method of ["sessions.companion.ask", "sessions.companion.state"]) {
          expect(
            resolveSessionMutationAuthorization({
              client: viewer,
              method,
              requestParams: { sessionKey },
              context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
            }).error,
            `${roleName}: ${method}`,
          ).toBeNull();
        }

        addSessionMember(
          { agentId: "main", sessionKey },
          {
            identityId: viewer.authenticatedUserProfile!.profileId,
            addedBy: ownerId!,
            expectedSessionId: "session-team-shared",
          },
        );
        expect(resolveSessionSharingRole({ cfg, client: viewer, target: sharedTarget })).toBe(
          "member",
        );
        expect(
          authorizeSessionSharingTarget({ cfg, client: viewer, target: sharedTarget }),
        ).toBeNull();
      }

      const writer = roleClient("write");
      expect(resolveSessionSharingRole({ cfg, client: writer, target: sharedTarget })).toBe(
        "member",
      );
      expect(
        authorizeSessionSharingTarget({ cfg, client: writer, target: sharedTarget }),
      ).toBeNull();

      const unassigned = ensureProfileForEmail("unassigned@example.test");
      expect(
        authorizeSessionSharingTarget({
          cfg,
          client: client({ user: unassigned.id }),
          target: sharedTarget,
        }),
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      expect(resolveSessionSharingRole({ cfg, client: owner, target: sharedTarget })).toBe("owner");
      expect(
        authorizeSessionSharingTarget({ cfg, client: owner, target: sharedTarget }),
      ).toBeNull();

      const admin = client({ user: unassigned.id, scopes: ["operator.admin"] });
      expect(resolveSessionSharingRole({ cfg, client: admin, target: sharedTarget })).toBe("admin");
      expect(
        authorizeSessionSharingTarget({ cfg, client: admin, target: sharedTarget }),
      ).toBeNull();
      expect(
        authorizeSessionSharingTarget({ cfg: {}, client: writer, target: sharedTarget }),
      ).toBeNull();
      expect(
        authorizeSessionSharingTarget({ cfg, client: client({}), target: sharedTarget }),
      ).toMatchObject({ code: "INVALID_REQUEST" });
      const systemOwner = client({});
      systemOwner.internal = { operatorRoleActor: { kind: "system" } };
      expect(
        authorizeSessionSharingTarget({ cfg, client: systemOwner, target: sharedTarget }),
      ).toBeNull();
      expect(
        createSessionListEntryFilter({ cfg, client: client({}) })?.(sessionKey, sharedTarget.entry),
      ).toBe(false);
      expect(createSessionListEntryFilter({ cfg, client: systemOwner })).toBeUndefined();
      expect(
        canReceiveSessionEvent({ cfg, client: client({}) as never, sessionKeys: [sessionKey] }),
      ).toBe(false);
    });
  });

  it("keeps draft and incognito carve-outs even for roles permitting foreign-session writes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const writer = roleClient("write", "draft-writer");
      const owner = ensureProfileForEmail("draft-owner@example.test");

      for (const visibility of ["draft", "incognito"] as const) {
        const sessionKey = `agent:main:dashboard:${visibility === "incognito" ? "incognito-" : ""}role-carveout`;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: `session-${visibility}`,
            updatedAt: 1,
            visibility: visibility === "draft" ? "draft" : "shared",
            ...(visibility === "incognito" ? { incognito: true as const } : {}),
            createdActor: { type: "human", id: owner.id },
          },
        );
        const restricted = resolveSessionSharingTarget({ cfg, sessionKey });
        expect(restricted).not.toBeNull();
        if (!restricted) {
          throw new Error("expected persisted restricted session");
        }
        expect(resolveSessionSharingRole({ cfg, client: writer, target: restricted })).toBe(
          "viewer",
        );
        const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
        expect(
          resolveSessionMutationAuthorization({
            client: writer,
            method: "chat.send",
            requestParams: { sessionKey },
            context,
          }).error,
        ).not.toBeNull();
      }
    });
  });

  it("hides foreign cron sessions with none access across listings, reads, mutations, and broadcasts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const creator = roleClient("none", "cron-creator");
      const creatorId = creator.authenticatedUserProfile!.profileId;
      const restricted = roleClient("none", "restricted");
      const restrictedId = restricted.authenticatedUserProfile!.profileId;
      const foreignKey = "agent:main:cron:job-1:run:run-1";
      const ownKey = "agent:main:team-own";
      const foreignEntry = {
        sessionId: "session-cron-run",
        updatedAt: 1,
        createdVia: "cron" as const,
        createdActor: { type: "human" as const, id: creatorId },
      };
      await upsertSessionEntryCore({ agentId: "main", sessionKey: foreignKey }, foreignEntry);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: ownKey },
        {
          sessionId: "session-team-own",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", id: restrictedId },
        },
      );
      addSessionMember(
        { agentId: "main", sessionKey: foreignKey },
        { identityId: restrictedId, addedBy: creatorId, expectedSessionId: foreignEntry.sessionId },
      );

      const entryFilter = createSessionListEntryFilter({ cfg, client: restricted });
      const creatorEntryFilter = createSessionListEntryFilter({ cfg, client: creator });
      expect(entryFilter?.(foreignKey, foreignEntry)).toBe(false);
      expect(creatorEntryFilter?.(foreignKey, foreignEntry)).toBe(true);
      expect(
        entryFilter?.(ownKey, {
          sessionId: "session-team-own",
          updatedAt: 1,
          createdActor: { type: "human", id: restrictedId },
        }),
      ).toBe(true);
      expect(
        canReceiveSessionEvent({ cfg, client: restricted as never, sessionKeys: [foreignKey] }),
      ).toBe(false);
      expect(
        canReceiveSessionEvent({ cfg, client: creator as never, sessionKeys: [foreignKey] }),
      ).toBe(true);
      expect(
        canReceiveSessionEvent({ cfg, client: restricted as never, sessionKeys: [ownKey] }),
      ).toBe(true);

      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
      for (const [method, requestParams] of [
        ["chat.history", { sessionKey: foreignKey }],
        ["chat.send", { sessionKey: foreignKey }],
        ["mcp.app.callTool", { sessionKey: foreignKey }],
        ["mcp.app.updateModelContext", { sessionKey: foreignKey }],
        ["sessions.get", { key: foreignKey }],
        ["sessions.assignOwner", { key: foreignKey }],
        ["sessions.resolve", { key: foreignKey }],
        ["sessions.preview", { keys: [foreignKey] }],
        ["sessions.search", { sessionKeys: [foreignKey] }],
        ["sessions.files.list", { sessionKey: foreignKey }],
        ["sessions.files.get", { sessionKey: foreignKey }],
        ["sessions.branches.list", { sessionKey: foreignKey }],
        ["sessions.companion.ask", { sessionKey: foreignKey }],
        ["sessions.companion.reset", { sessionKey: foreignKey }],
        ["sessions.companion.state", { sessionKey: foreignKey }],
        ["artifacts.list", { sessionKey: foreignKey }],
        ["session.suggestions.list", { sessionKey: foreignKey }],
        ["session.typing", { sessionKey: foreignKey }],
        ["talk.client.create", { sessionKey: foreignKey }],
        ["talk.client.toolCall", { sessionKey: foreignKey }],
        ["talk.client.transcript", { sessionKey: foreignKey }],
        ["talk.client.close", { sessionKey: foreignKey }],
        ["talk.client.steer", { sessionKey: foreignKey }],
        ["talk.session.create", { sessionKey: foreignKey }],
        ["talk.session.steer", { sessionKey: foreignKey }],
        ["taskSuggestions.create", { sessionKey: foreignKey }],
        ["wake", { sessionKey: foreignKey }],
      ] as const) {
        expect(
          resolveSessionMutationAuthorization({
            client: restricted,
            method,
            requestParams,
            context,
          }).error,
          method,
        ).toMatchObject({
          code: "INVALID_REQUEST",
          message: `Session "${foreignKey}" was not found.`,
        });
      }
      for (const method of ["chat.history", "chat.send"] as const) {
        expect(
          resolveSessionMutationAuthorization({
            client: creator,
            method,
            requestParams: { sessionKey: foreignKey },
            context,
          }).error,
          `creator ${method}`,
        ).toBeNull();
      }
      expect(
        resolveSessionMutationAuthorization({
          client: restricted,
          method: "chat.history",
          requestParams: { sessionKey: ownKey },
          context,
        }).error,
      ).toBeNull();
      expect(
        createSessionListEntryFilter({ cfg: {}, client: restricted })?.(foreignKey, foreignEntry),
      ).toBe(true);
      const admin = client({ user: restrictedId, scopes: ["operator.admin"] });
      expect(createSessionListEntryFilter({ cfg, client: admin })).toBeUndefined();
      expect(
        resolveSessionMutationAuthorization({
          client: admin,
          method: "chat.history",
          requestParams: { sessionKey: foreignKey },
          context,
        }).error,
      ).toBeNull();
    });
  });

  it("fails closed instead of treating pending GitHub identity as a solo owner", () => {
    const pending = client({ githubSyncPending: true });
    const draft = target({ type: "human", id: "profile-owner" });

    expect(resolveSessionSharingRole({ client: pending, target: draft })).toBe("viewer");
  });

  it("returns retryable unavailability from direct session guards while profile sync is pending", () => {
    const pending = client({ githubSyncPending: true });
    const ownedTarget = target({ type: "human", id: "profile-owner" });
    const incognitoTarget = {
      ...ownedTarget,
      canonicalKey: "agent:main:dashboard:incognito-direct-guard",
      entry: { ...ownedTarget.entry, incognito: true as const },
    };

    expect(
      authorizeIncognitoSessionTarget({
        client: pending,
        sessionKey: incognitoTarget.canonicalKey,
        target: incognitoTarget,
      }),
    ).toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
      details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
    });
    expect(
      resolveSessionMutationAuthorization({
        client: pending,
        method: "send",
        requestParams: { sessionKey: "agent:main:main" },
        context: {} as GatewayRequestContext,
      }).error,
    ).toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
      details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
    });
  });

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
      const sessionAlias = "dashboard:incognito-private";
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
      const directRequests = (requestedKey: string) => [
        { method: "chat.history", requestParams: { sessionKey: requestedKey } },
        { method: "chat.send", requestParams: { sessionKey: requestedKey } },
        { method: "sessions.get", requestParams: { key: requestedKey } },
        { method: "sessions.preview", requestParams: { keys: [requestedKey] } },
        { method: "sessions.search", requestParams: { sessionKeys: [requestedKey] } },
      ];

      for (const visibleClient of [admin, solo]) {
        expect(isListed(visibleClient, sessionKey, entry)).toBe(true);
        expect(
          canReceiveSessionEvent({
            cfg,
            client: visibleClient as never,
            sessionKeys: [sessionKey],
          }),
        ).toBe(true);
        for (const requestedKey of [sessionKey, sessionAlias]) {
          for (const request of directRequests(requestedKey)) {
            expect(
              resolveSessionMutationAuthorization({
                client: visibleClient,
                ...request,
                context,
              }).error,
            ).toBeNull();
          }
        }
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
        for (const requestedKey of [sessionKey, sessionAlias]) {
          for (const request of directRequests(requestedKey)) {
            expect(
              resolveSessionMutationAuthorization({
                client: hiddenClient,
                ...request,
                context,
              }).error,
            ).toMatchObject({
              code: "INVALID_REQUEST",
              message: `Incognito session "${requestedKey}" was not found.`,
            });
          }
        }
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
    for (const method of ["sessions.reset", "sessions.move"]) {
      expect(
        resolveSessionMutationAuthorization({
          client: client({}),
          method,
          requestParams: {},
          context,
        }).error,
        method,
      ).toMatchObject({ details: { code: "SESSION_MUTATION_TARGET_REQUIRED" } });
    }
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
