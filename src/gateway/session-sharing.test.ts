import { afterEach, describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
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
} from "./session-sharing.js";
import {
  sharingPolicyClient as client,
  roleClient,
  rolePolicyConfig,
} from "./session-sharing.test-utils.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

type SharingTarget = Parameters<typeof resolveSessionSharingRole>[0]["target"];

function isListed(
  requestClient: GatewayClient,
  sessionKey: string,
  entry: SharingTarget["entry"],
): boolean {
  return createSessionListEntryFilter({ client: requestClient })?.(sessionKey, entry) ?? true;
}

function target(createdActor?: { type: "human"; id: string; label?: string }): SharingTarget {
  return {
    agentId: "main",
    canonicalKey: "agent:main:main",
    entry: {
      sessionId: "session-main",
      updatedAt: 1,
      visibility: "draft",
      ...(createdActor
        ? {
            createdVia: "operator" as const,
            createdActor: { ...createdActor, source: "profile" as const },
          }
        : {}),
    },
    storeKey: "agent:main:main",
    storeKeys: ["agent:main:main"],
    storePath: "/tmp/sessions.json",
  };
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
          createdActor: { type: "human", source: "profile", id: owner.id },
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
        ["sessions.goal.update", { sessionKey, action: "resume" }],
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
      for (const [method, requestParams] of [
        ["sessions.patch", { key: sessionKey }],
        ["sessions.goal.update", { sessionKey, action: "pause" }],
        ["sessions.goal.clear", { sessionKey }],
      ] as const) {
        expect(
          resolveSessionMutationAuthorization({ client: writer, method, requestParams, context })
            .error,
          method,
        ).toBeNull();
      }
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
          createdActor: { type: "human", source: "profile", id: ownerId! },
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
        for (const method of [
          "chat.history",
          "chat.startup",
          "chat.metadata",
          "sessions.companion.ask",
          "sessions.companion.state",
        ]) {
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
            createdActor: { type: "human", source: "profile", id: owner.id },
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
        createdActor: { type: "human" as const, source: "profile" as const, id: creatorId },
      };
      await upsertSessionEntryCore({ agentId: "main", sessionKey: foreignKey }, foreignEntry);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: ownKey },
        {
          sessionId: "session-team-own",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: restrictedId },
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
          createdActor: { type: "human", source: "profile", id: restrictedId },
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
        ["chat.metadata", { sessionKey: foreignKey }],
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
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
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
          createdActor: { type: "human", source: "profile", id: "owner" },
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

  it.each([false, true])(
    "keeps identity-less solo mode owner-equivalent for restricted sessions (owner profile: %s)",
    (withOwnerProfile) => {
      const solo = client(withOwnerProfile ? { user: "gateway-owner" } : {});
      expect(resolveSessionSharingRole({ client: solo, target: target() })).toBe("owner");
    },
  );

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
    const entry = target({ type: "human", id: "owner@example.com", label: "Owner" }).entry;
    expect(isListed(owner, "main", entry)).toBe(true);
    expect(isListed(viewer, "main", entry)).toBe(false);
  });

  it("keeps incognito admin-only while treating identityless connections as owner-equivalent", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:dashboard:incognito-private";
      const sessionAlias = "dashboard:incognito-private";
      const entry = {
        ...target({ type: "human", id: "owner@example.com" }).entry,
        sessionId: "session-incognito",
        visibility: "shared" as const,
        incognito: true as const,
      };
      await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
      const owner = client({ user: "owner@example.com" });
      const viewer = client({ user: "viewer@example.com" });
      const admin = client({ user: "admin@example.com", scopes: ["operator.admin"] });
      const solo = client({});
      const profiledSolo = client({ user: "gateway-owner" });
      const cfg = {};
      const context = { chatAbortControllers: new Map(), getRuntimeConfig: () => cfg } as never;
      const directRequests = (requestedKey: string) => [
        { method: "chat.history", requestParams: { sessionKey: requestedKey } },
        { method: "chat.metadata", requestParams: { sessionKey: requestedKey } },
        { method: "chat.send", requestParams: { sessionKey: requestedKey } },
        { method: "sessions.get", requestParams: { key: requestedKey } },
        { method: "sessions.preview", requestParams: { keys: [requestedKey] } },
        { method: "sessions.search", requestParams: { sessionKeys: [requestedKey] } },
      ];

      for (const [requestClient, visible] of [
        [admin, true],
        [solo, true],
        [profiledSolo, true],
        [owner, false],
        [viewer, false],
      ] as const) {
        expect(isListed(requestClient, sessionKey, entry)).toBe(visible);
        expect(
          canReceiveSessionEvent({
            cfg,
            client: requestClient as never,
            sessionKeys: [sessionKey],
          }),
        ).toBe(visible);
        for (const requestedKey of [sessionKey, sessionAlias]) {
          for (const request of directRequests(requestedKey)) {
            const { error } = resolveSessionMutationAuthorization({
              client: requestClient,
              ...request,
              context,
            });
            if (visible) {
              expect(error).toBeNull();
            } else {
              expect(error).toMatchObject({
                code: "INVALID_REQUEST",
                message: `Incognito session "${requestedKey}" was not found.`,
              });
            }
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

  it("keeps agent scope for progress cards and indirect run and approval authorization", async () => {
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
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
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
        ["progressCard.get", { sessionKey: "global", agentId: "work" }],
        ["progressCard.put", { sessionKey: "global", agentId: "work" }],
      ] as const) {
        expect(
          resolveSessionMutationAuthorization({ client: outsider, method, requestParams, context })
            .error,
        ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      }
      for (const method of ["progressCard.get", "progressCard.put"]) {
        expect(
          resolveSessionMutationAuthorization({
            client: outsider,
            method,
            requestParams: { sessionKey: "global", agentId: "main" },
            context,
          }).error,
        ).toBeNull();
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
          createdActor: { type: "human", source: "profile", id: "owner" },
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
          createdActor: { type: "human", source: "profile", id: "owner" },
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
