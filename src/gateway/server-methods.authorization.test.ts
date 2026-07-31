import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  patchSessionEntry,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptor,
} from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const METHOD = "workboard.cards.dispatch";
const ensureProfileForEmail = vi.hoisted(() => vi.fn());
const resolveUserProfileId = vi.hoisted(() => vi.fn());
const setDisplayName = vi.hoisted(() => vi.fn());

vi.mock("../state/user-profiles.js", () => ({
  ensureProfileForEmail,
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
      await upsertSessionEntry(
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
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-draft-replacement",
          updatedAt: 2,
          visibility: "draft",
          createdActor: { type: "human", id: "owner" },
        },
      );
      await patchSessionEntry({ agentId: "main", sessionKey }, () => ({
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
