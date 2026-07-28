import { afterEach, describe, expect, it } from "vitest";
import { upsertSessionEntry } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  allowedSessionVisibilities,
  authorizeIncognitoSessionTarget,
  resolveSessionMutationAuthorization,
  canReceiveSessionEvent,
  filterDraftSessionsForClient,
  resolveSessionSharingRole,
  resolveSessionVisibility,
} from "./session-sharing.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

type SharingTarget = Parameters<typeof resolveSessionSharingRole>[0]["target"];

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
    storePath: "/tmp/sessions.json",
  };
}

describe("session sharing policy", () => {
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
    expect(filterDraftSessionsForClient({ client: owner, store: { main: entry } })).toHaveProperty(
      "main",
    );
    expect(filterDraftSessionsForClient({ client: viewer, store: { main: entry } })).toEqual({});
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
      await upsertSessionEntry({ agentId: "main", sessionKey }, entry);
      const owner = client({ user: "owner@example.com" });
      const viewer = client({ user: "viewer@example.com" });
      const admin = client({ user: "admin@example.com", scopes: ["operator.admin"] });
      const solo = client({});
      const cfg = {};
      const context = { chatAbortControllers: new Map(), getRuntimeConfig: () => cfg } as never;

      for (const visibleClient of [admin, solo]) {
        expect(
          filterDraftSessionsForClient({ client: visibleClient, store: { [sessionKey]: entry } }),
        ).toHaveProperty(sessionKey);
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
        expect(
          filterDraftSessionsForClient({ client: hiddenClient, store: { [sessionKey]: entry } }),
        ).toEqual({});
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
      await upsertSessionEntry(
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
      await upsertSessionEntry(
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
      await upsertSessionEntry(
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
