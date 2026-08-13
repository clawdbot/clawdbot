import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptor,
} from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils.js";

const METHOD = "workboard.cards.dispatch";
const ensureProfileForEmail = vi.hoisted(() => vi.fn());
const getUserProfileDisplay = vi.hoisted(() =>
  vi.fn((profileId: string) => ({
    id: profileId,
    displayName: "Ada",
    avatarRevision: "1",
    hasAvatar: false,
  })),
);
const resolveUserProfileId = vi.hoisted(() => vi.fn());
const setDisplayName = vi.hoisted(() => vi.fn());

vi.mock("../state/user-profiles.js", () => ({
  ensureProfileForEmail,
  getUserProfileDisplay,
  getUserProfileListItem: vi.fn(),
  linkEmail: vi.fn(),
  listProfiles: vi.fn(),
  resolveUserProfileId,
  setAvatar: vi.fn(),
  setDisplayName,
  UserProfileNotFoundError: class UserProfileNotFoundError extends Error {},
}));

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  ensureProfileForEmail.mockReset();
  getUserProfileDisplay.mockClear();
  resolveUserProfileId.mockReset();
  setDisplayName.mockReset();
});

describe("gateway method authorization", () => {
  async function dispatch(scopes: string[]) {
    const handler: GatewayRequestHandler = ({ respond }) => respond(true, { ok: true });
    const methodRegistry = createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "workboard",
        name: METHOD,
        handler,
        scope: "operator.write",
      }),
    ]);
    const respond = vi.fn();

    // Reproduce a request whose attached dispatch registry is newer than the global runtime state.
    setActivePluginRegistry(createEmptyPluginRegistry());
    await handleGatewayRequest({
      req: { type: "req", id: "req-1", method: METHOD },
      respond,
      client: {
        connId: "conn-1",
        connect: {
          role: "operator",
          scopes,
          client: { id: "test", version: "1", platform: "test", mode: "test" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
        typeof handleGatewayRequest
      >[0]["context"],
      methodRegistry,
    });
    return respond;
  }

  it("authorizes from the attached registry used for dispatch", async () => {
    const allowed = await dispatch(["operator.write"]);
    const denied = await dispatch(["operator.read"]);

    expect(allowed).toHaveBeenCalledWith(true, { ok: true });
    expect(denied).toHaveBeenCalledWith(false, undefined, {
      code: "FORBIDDEN",
      message: "missing scope: operator.write",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.write",
        requiredScopes: ["operator.write"],
      },
    });
  });

  it("allows read-only projects.list to reach its redacting handler", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { projects: [] }));
    const respond = vi.fn();

    await handleGatewayRequest({
      req: { type: "req", id: "req-projects-read", method: "projects.list", params: {} },
      respond,
      client: {
        connId: "conn-projects-read",
        connect: {
          role: "operator",
          scopes: ["operator.read"],
          client: { id: "test", version: "1", platform: "test", mode: "test" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
        typeof handleGatewayRequest
      >[0]["context"],
      extraHandlers: { "projects.list": handler },
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { projects: [] });
  });

  it("rejects every node RPC when its connection no longer owns the pairing generation", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const respond = vi.fn();
    const isConnectionCurrentPairingState = vi.fn().mockResolvedValue(false);

    await handleGatewayRequest({
      req: { type: "req", id: "req-node-stale", method: "node.event", params: { event: "test" } },
      respond,
      client: {
        connId: "conn-node-stale",
        connect: {
          role: "node",
          scopes: [],
          device: {
            id: "node-stale",
            publicKey: "public-key",
            signature: "signature",
            signedAt: 1,
            nonce: "nonce",
          },
          client: { id: "node-host", version: "1", platform: "test", mode: "node" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: {
        logGateway: { warn: vi.fn() },
        nodeRegistry: { isConnectionCurrentPairingState },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      extraHandlers: { "node.event": handler },
    });

    expect(isConnectionCurrentPairingState).toHaveBeenCalledWith("conn-node-stale");
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: { code: "PAIRING_CHANGED" },
      }),
    );
  });

  async function dispatchProfileMutation(params: {
    authenticatedUserId?: string;
    profileId: string;
    scopes: string[];
  }) {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "req-users-1",
        method: "users.setDisplayName",
        params: { displayName: "Ada", profileId: params.profileId },
      },
      respond,
      client: {
        connId: "conn-users-1",
        ...(params.authenticatedUserId ? { authenticatedUserId: params.authenticatedUserId } : {}),
        connect: {
          role: "operator",
          scopes: params.scopes,
          client: { id: "test", version: "1", platform: "test", mode: "test" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
        typeof handleGatewayRequest
      >[0]["context"],
    });
    return respond;
  }

  it("admits write-scoped requests for handler-level self-service authorization", async () => {
    const respond = await dispatchProfileMutation({
      profileId: "profile-1",
      scopes: ["operator.write"],
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("rejects profile mutations before the handler without write scope", async () => {
    const respond = await dispatchProfileMutation({
      profileId: "profile-1",
      scopes: ["operator.read"],
    });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "FORBIDDEN",
      message: "missing scope: operator.write",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.write",
        requiredScopes: ["operator.write"],
      },
    });
  });

  it("allows an identified write caller to edit its own profile", async () => {
    const profile = { id: "profile-1" };
    ensureProfileForEmail.mockReturnValue(profile);
    resolveUserProfileId.mockReturnValue(profile.id);
    setDisplayName.mockReturnValue(profile);

    expect(
      await dispatchProfileMutation({
        authenticatedUserId: "ada@example.com",
        profileId: "profile-1",
        scopes: ["operator.write"],
      }),
    ).toHaveBeenCalledWith(true, { profile });
  });

  it("requires admin when an identified write caller targets another profile", async () => {
    ensureProfileForEmail.mockReturnValue({ id: "profile-1" });
    resolveUserProfileId.mockReturnValue("profile-2");

    expect(
      await dispatchProfileMutation({
        authenticatedUserId: "ada@example.com",
        profileId: "profile-2",
        scopes: ["operator.write"],
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("allows an admin caller to edit any profile", async () => {
    const profile = { id: "profile-2" };
    setDisplayName.mockReturnValue(profile);

    expect(
      await dispatchProfileMutation({
        profileId: "profile-2",
        scopes: ["operator.admin"],
      }),
    ).toHaveBeenCalledWith(true, { profile });
  });

  it("rejects a mutation when its authorized session instance is replaced before commit", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:commit-bound-authorization";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-shared",
          updatedAt: 1,
          visibility: "shared",
        },
      );

      let continueHandler = () => {};
      const handlerCanContinue = new Promise<void>((resolve) => {
        continueHandler = resolve;
      });
      let markHandlerStarted = () => {};
      const handlerStarted = new Promise<void>((resolve) => {
        markHandlerStarted = resolve;
      });
      const patchHandler = sessionMutationHandlers["sessions.patch"];
      if (!patchHandler) {
        throw new Error("sessions.patch handler is not registered");
      }
      const respond = vi.fn();
      const request = handleGatewayRequest({
        req: {
          type: "req",
          id: "req-session-commit-bound",
          method: "sessions.patch",
          params: { key: sessionKey, label: "stale mutation" },
        },
        respond,
        client: {
          connId: "conn-session-commit-bound",
          authenticatedUserId: "member@example.com",
          authenticatedUserProfile: {
            profileId: "member",
            displayName: "Member",
            hasAvatar: false,
            updatedAt: 1,
          },
          connect: {
            role: "operator",
            scopes: ["operator.write"],
            client: { id: "test", version: "1", platform: "test", mode: "test" },
            minProtocol: 1,
            maxProtocol: 1,
          },
        } as Parameters<typeof handleGatewayRequest>[0]["client"],
        isWebchatConnect: () => false,
        context: {
          getRuntimeConfig: () => ({}),
          logGateway: { warn: vi.fn() },
          broadcast: vi.fn(),
          broadcastToConnIds: vi.fn(),
          getSessionEventSubscriberConnIds: () => new Set(),
          chatAbortControllers: new Map(),
        } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
        extraHandlers: {
          "sessions.patch": async (options) => {
            markHandlerStarted();
            await handlerCanContinue;
            await patchHandler(options);
          },
        },
      });

      await handlerStarted;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-draft-replacement",
          updatedAt: 2,
          visibility: "draft",
          createdActor: { type: "human", id: "owner" },
        },
      );
      await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({
        visibility: "draft",
      }));
      continueHandler();
      await request;

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          details: expect.objectContaining({ code: "SESSION_MUTATION_AUTHORIZATION_CHANGED" }),
        }),
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
        sessionId: "session-draft-replacement",
        visibility: "draft",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey })).not.toHaveProperty("label");
    });
  });
});

describe("sessions.patchMany orchestration", () => {
  const context = (overrides: Record<string, unknown> = {}) =>
    ({
      getRuntimeConfig: () => ({}),
      loadGatewayModelCatalog: vi.fn(async () => []),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      dedupe: new Map(),
      ...overrides,
    }) as never;

  it("preserves request-order outcomes while isolating expected-identity failures", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      for (let index = 0; index < 3; index += 1) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:batch-${index}` },
          {
            sessionId: `session-${index}`,
            lifecycleRevision: `revision-${index}`,
            updatedAt: 1,
          },
        );
      }
      const respond = vi.fn();
      await sessionMutationHandlers["sessions.patchMany"]!({
        params: {
          targets: [0, 1, 2].map((index) => ({
            key: `agent:main:batch-${index}`,
            expectedSessionId: index === 1 ? "stale-session" : `session-${index}`,
            expectedLifecycleRevision: `revision-${index}`,
          })),
          patch: { unread: false },
        },
        respond,
        context: context(),
      } as never);

      const outcomes = respond.mock.calls[0]?.[1]?.outcomes;
      expect(outcomes).toEqual([
        { ok: true, key: "agent:main:batch-0" },
        {
          ok: false,
          key: "agent:main:batch-1",
          error: {
            code: "INVALID_REQUEST",
            details: { reason: "session-changed" },
            message: "Session agent:main:batch-1 changed before patch. Retry.",
          },
        },
        { ok: true, key: "agent:main:batch-2" },
      ]);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:batch-0" }),
      ).toHaveProperty("lastReadAt");
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:batch-1" }),
      ).not.toHaveProperty("lastReadAt");
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:batch-2" }),
      ).toHaveProperty("lastReadAt");
    });
  });

  it("rejects logical aliases before mutation", async () => {
    const respond = vi.fn();
    await sessionMutationHandlers["sessions.patchMany"]!({
      params: {
        targets: [{ key: "agent:main:duplicate" }, { key: "duplicate" }],
        patch: { archived: true },
      },
      respond,
      context: context(),
    } as never);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Duplicate target." }),
    );
  });

  it("projects non-archive patches in request order against prior successes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      for (let index = 0; index < 2; index += 1) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:label-${index}` },
          { sessionId: `session-label-${index}`, updatedAt: 1 },
        );
      }
      const respond = vi.fn();
      await sessionMutationHandlers["sessions.patchMany"]!({
        params: {
          targets: [0, 1].map((index) => ({ key: `agent:main:label-${index}` })),
          patch: { label: "Shared label" },
        },
        respond,
        context: context(),
      } as never);

      expect(respond.mock.calls[0]?.[1]?.outcomes).toEqual([
        { ok: true, key: "agent:main:label-0" },
        {
          ok: false,
          key: "agent:main:label-1",
          error: { code: "INVALID_REQUEST", message: "label already in use: Shared label" },
        },
      ]);
      expect(loadSessionEntry({ agentId: "main", sessionKey: "agent:main:label-0" })?.label).toBe(
        "Shared label",
      );
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:label-1" })?.label,
      ).toBeUndefined();
    });
  });

  it("does not reserve a projected label when target authorization fails", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKeys = [0, 1].map((index) => `agent:main:label-race-${index}`);
      for (const [index, sessionKey] of sessionKeys.entries()) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          { sessionId: `session-label-race-${index}`, updatedAt: 1 },
        );
      }
      const guardOrder: string[] = [];
      const assertCurrent = vi.fn(() => {
        throw new Error("outer all-target guard must not be delegated");
      });
      const assertTargetCurrent = vi.fn(({ sessionKey }: { sessionKey: string }) => {
        guardOrder.push(sessionKey);
        if (sessionKey === sessionKeys[0]) {
          throw new SessionMutationAuthorizationChangedError({
            code: "INVALID_REQUEST",
            message: "session changed before sessions.patchMany; retry the request",
          });
        }
      });
      const respond = vi.fn();

      await sessionMutationHandlers["sessions.patchMany"]!({
        params: {
          targets: sessionKeys.map((key) => ({ key })),
          patch: { label: "Shared label" },
        },
        respond,
        context: context(),
        sessionMutationAuthorization: { assertCurrent, assertTargetCurrent },
      } as never);

      expect(assertCurrent).not.toHaveBeenCalled();
      expect(guardOrder).toEqual(sessionKeys);
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          outcomes: [
            {
              ok: false,
              key: sessionKeys[0],
              error: {
                code: "INVALID_REQUEST",
                message: "session changed before sessions.patchMany; retry the request",
              },
            },
            { ok: true, key: sessionKeys[1] },
          ],
        },
        undefined,
      );
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: sessionKeys[0]! })?.label,
      ).toBeUndefined();
      expect(loadSessionEntry({ agentId: "main", sessionKey: sessionKeys[1]! })?.label).toBe(
        "Shared label",
      );
    });
  });

  it("checks labels against untouched sessions in the store snapshot", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:label-owner" },
        { label: "Existing label", sessionId: "session-label-owner", updatedAt: 1 },
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:label-target" },
        { sessionId: "session-label-target", updatedAt: 1 },
      );
      const respond = vi.fn();
      await sessionMutationHandlers["sessions.patchMany"]!({
        params: {
          targets: [{ key: "agent:main:label-target" }],
          patch: { label: "Existing label" },
        },
        respond,
        context: context(),
      } as never);

      expect(respond.mock.calls[0]?.[1]?.outcomes).toEqual([
        {
          ok: false,
          key: "agent:main:label-target",
          error: { code: "INVALID_REQUEST", message: "label already in use: Existing label" },
        },
      ]);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:label-target" })?.label,
      ).toBeUndefined();
    });
  });

  it("rejects an alias conflict introduced after preflight without blocking siblings", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        session: { mainKey: "work" },
        agents: { list: [{ id: "main", default: true }] },
      } satisfies OpenClawConfig;
      const canonicalKey = "agent:main:work";
      const conflictingAlias = "agent:main:main";
      const siblingKeys = ["agent:main:alias-race-before", "agent:main:alias-race-after"];
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: canonicalKey },
        { sessionId: "session-alias-race-canonical", updatedAt: 1 },
      );
      for (const [index, sessionKey] of siblingKeys.entries()) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          { sessionId: `session-alias-race-sibling-${index}`, updatedAt: 1 },
        );
      }

      const storePath = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: conflictingAlias,
      }).storePath;
      const writerStarted = createDeferredCore();
      const insertConflictingAlias = createDeferredCore();
      const writer = applySessionEntryCanonicalReplacements({
        agentId: "main",
        sessionKeys: [conflictingAlias],
        storePath,
        update: async () => {
          writerStarted.resolve();
          await insertConflictingAlias.promise;
          return {
            replacements: [
              {
                entry: { sessionId: "session-alias-race-conflict", updatedAt: 2 },
                previousSessionKeys: [],
                sessionKey: conflictingAlias,
              },
            ],
            result: undefined,
          };
        },
      });
      await writerStarted.promise;

      const preflightCompleted = createDeferredCore();
      const respond = vi.fn();
      const request = sessionMutationHandlers["sessions.patchMany"]!({
        params: {
          targets: [{ key: siblingKeys[0]! }, { key: conflictingAlias }, { key: siblingKeys[1]! }],
          patch: { unread: false },
        },
        respond,
        context: context({
          getRuntimeConfig: () => cfg,
          workerSessionPlacementService: {
            getMany: (sessionIds: string[]) => {
              if (sessionIds.includes("session-alias-race-canonical")) {
                preflightCompleted.resolve();
              }
              return new Map();
            },
          },
        }),
      } as never);

      await preflightCompleted.promise;
      insertConflictingAlias.resolve();
      await writer;
      await request;

      expect(respond.mock.calls[0]?.[1]?.outcomes).toEqual([
        { ok: true, key: siblingKeys[0] },
        {
          ok: false,
          key: conflictingAlias,
          error: {
            code: "UNAVAILABLE",
            message: "Session patch failed unexpectedly. Retry the request.",
            retryable: true,
          },
        },
        { ok: true, key: siblingKeys[1] },
      ]);
      expect(loadSessionEntry({ agentId: "main", sessionKey: canonicalKey })).toMatchObject({
        sessionId: "session-alias-race-canonical",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey: canonicalKey })).not.toHaveProperty(
        "lastReadAt",
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey: conflictingAlias })).toMatchObject({
        sessionId: "session-alias-race-conflict",
      });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: conflictingAlias }),
      ).not.toHaveProperty("lastReadAt");
      for (const sessionKey of siblingKeys) {
        expect(loadSessionEntry({ agentId: "main", sessionKey })).toHaveProperty("lastReadAt");
      }
    });
  });

  it("rejects an alias inserted after single-patch preflight while waiting for the writer", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        session: { mainKey: "work" },
        agents: { list: [{ id: "main", default: true }] },
      } satisfies OpenClawConfig;
      const canonicalKey = "agent:main:work";
      const conflictingAlias = "agent:main:main";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: canonicalKey },
        { sessionId: "session-single-alias-race-canonical", updatedAt: 1 },
      );

      const storePath = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: conflictingAlias,
      }).storePath;
      const writerStarted = createDeferredCore();
      const insertConflictingAlias = createDeferredCore();
      const writer = applySessionEntryCanonicalReplacements({
        agentId: "main",
        sessionKeys: [conflictingAlias],
        storePath,
        update: async () => {
          writerStarted.resolve();
          await insertConflictingAlias.promise;
          return {
            replacements: [
              {
                entry: { sessionId: "session-single-alias-race-conflict", updatedAt: 2 },
                previousSessionKeys: [],
                sessionKey: conflictingAlias,
              },
            ],
            result: undefined,
          };
        },
      });
      await writerStarted.promise;

      const preflightCompleted = createDeferredCore();
      const respond = vi.fn();
      const request = sessionMutationHandlers["sessions.patch"]!({
        params: { key: conflictingAlias, pinned: true },
        respond,
        context: context({
          getRuntimeConfig: () => cfg,
          workerSessionPlacementService: {
            getMany: (sessionIds: string[]) => {
              if (sessionIds.includes("session-single-alias-race-canonical")) {
                preflightCompleted.resolve();
              }
              return new Map();
            },
          },
        }),
      } as never);

      await preflightCompleted.promise;
      insertConflictingAlias.resolve();
      await writer;
      await request;

      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "UNAVAILABLE",
        message: "Session patch failed unexpectedly. Retry the request.",
        retryable: true,
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey: canonicalKey })).toMatchObject({
        sessionId: "session-single-alias-race-canonical",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey: canonicalKey })).not.toHaveProperty(
        "pinnedAt",
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey: conflictingAlias })).toMatchObject({
        sessionId: "session-single-alias-race-conflict",
      });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: conflictingAlias }),
      ).not.toHaveProperty("pinnedAt");
    });
  });

  it("isolates a target authorization race from sibling patches", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      for (let index = 0; index < 3; index += 1) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:race-${index}` },
          { sessionId: `session-race-${index}`, updatedAt: 1 },
        );
      }
      const respond = vi.fn();
      const assertCurrent = vi.fn(() => {
        throw new Error("outer all-target guard must not be delegated");
      });
      const assertTargetCurrent = vi.fn(({ sessionKey }: { sessionKey: string }) => {
        if (sessionKey.endsWith("-1")) {
          throw new SessionMutationAuthorizationChangedError({
            code: "INVALID_REQUEST",
            message: "session changed before sessions.patchMany; retry the request",
          });
        }
      });
      await sessionMutationHandlers["sessions.patchMany"]!({
        params: {
          targets: [0, 1, 2].map((index) => ({ key: `agent:main:race-${index}` })),
          patch: { unread: false },
        },
        respond,
        context: context(),
        sessionMutationAuthorization: { assertCurrent, assertTargetCurrent },
      } as never);

      expect(assertCurrent).not.toHaveBeenCalled();
      expect(assertTargetCurrent).toHaveBeenCalledTimes(3);
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          outcomes: [
            { ok: true, key: "agent:main:race-0" },
            {
              ok: false,
              key: "agent:main:race-1",
              error: {
                code: "INVALID_REQUEST",
                message: "session changed before sessions.patchMany; retry the request",
              },
            },
            { ok: true, key: "agent:main:race-2" },
          ],
        },
        undefined,
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey: "agent:main:race-0" })).toHaveProperty(
        "lastReadAt",
      );
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:race-1" }),
      ).not.toHaveProperty("lastReadAt");
      expect(loadSessionEntry({ agentId: "main", sessionKey: "agent:main:race-2" })).toHaveProperty(
        "lastReadAt",
      );
    });
  });

  it("isolates archive preparation authorization per target and continues in input order", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      for (let index = 0; index < 3; index += 1) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:archive-auth-${index}` },
          { sessionId: `session-archive-auth-${index}`, updatedAt: 1 },
        );
      }
      const respond = vi.fn();
      const assertCurrent = vi.fn(() => {
        throw new Error("outer all-target guard must not be used");
      });
      const assertTargetCurrent = vi.fn(({ sessionKey }: { sessionKey: string }) => {
        if (sessionKey.endsWith("-1")) {
          throw new SessionMutationAuthorizationChangedError({
            code: "INVALID_REQUEST",
            message: "archive authorization changed; retry the request",
          });
        }
      });

      await sessionMutationHandlers["sessions.patchMany"]!({
        params: {
          targets: [0, 1, 2].map((index) => ({
            key: `agent:main:archive-auth-${index}`,
            expectedSessionId: `session-archive-auth-${index}`,
          })),
          patch: { archived: true },
        },
        respond,
        context: context(),
        client: { connect: { scopes: ["operator.write"] } },
        sessionMutationAuthorization: { assertCurrent, assertTargetCurrent },
      } as never);

      expect(assertCurrent).not.toHaveBeenCalled();
      expect(assertTargetCurrent.mock.calls.map(([target]) => target.sessionKey)).toEqual([
        "agent:main:archive-auth-0",
        "agent:main:archive-auth-1",
        "agent:main:archive-auth-2",
        "agent:main:archive-auth-0",
        "agent:main:archive-auth-2",
      ]);
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          outcomes: [
            { ok: true, key: "agent:main:archive-auth-0" },
            {
              ok: false,
              key: "agent:main:archive-auth-1",
              error: {
                code: "INVALID_REQUEST",
                message: "archive authorization changed; retry the request",
              },
            },
            { ok: true, key: "agent:main:archive-auth-2" },
          ],
        },
        undefined,
      );
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:archive-auth-0" }),
      ).toHaveProperty("archivedAt");
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:archive-auth-1" }),
      ).not.toHaveProperty("archivedAt");
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:archive-auth-2" }),
      ).toHaveProperty("archivedAt");
    });
  });

  it("converts an unexpected target exception into an ordered isolated failure", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      for (let index = 0; index < 3; index += 1) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:throw-${index}` },
          { sessionId: `session-throw-${index}`, updatedAt: 1 },
        );
      }
      const respond = vi.fn();
      await sessionMutationHandlers["sessions.patchMany"]!({
        params: {
          targets: [0, 1, 2].map((index) => ({ key: `agent:main:throw-${index}` })),
          patch: { category: "Batch" },
        },
        respond,
        context: context({
          workerSessionPlacementService: {
            getMany: (sessionIds: string[]) => {
              if (sessionIds.includes("session-throw-1")) {
                throw new Error("private placement detail");
              }
              return new Map();
            },
          },
        }),
      } as never);

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          outcomes: [
            { ok: true, key: "agent:main:throw-0" },
            {
              ok: false,
              key: "agent:main:throw-1",
              error: {
                code: "UNAVAILABLE",
                message: "Session patch failed unexpectedly. Retry the request.",
                retryable: true,
              },
            },
            { ok: true, key: "agent:main:throw-2" },
          ],
        },
        undefined,
      );
    });
  });
});
