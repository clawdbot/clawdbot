import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptor,
} from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
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
});
