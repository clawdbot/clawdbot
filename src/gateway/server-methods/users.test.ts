import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateUsersLinkEmailResult,
  validateUsersSelfResult,
  validateUsersSetAvatarResult,
  validateUsersSetDisplayNameResult,
  validateUsersSetGitHubIdentityResult,
  validateUsersClearGitHubIdentityResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { usersHandlers } from "./users.js";

const linkEmail = vi.hoisted(() => vi.fn());
const listProfiles = vi.hoisted(() => vi.fn());
const setAvatar = vi.hoisted(() => vi.fn());
const setDisplayName = vi.hoisted(() => vi.fn());
const setGitHubIdentity = vi.hoisted(() => vi.fn());
const clearGitHubIdentity = vi.hoisted(() => vi.fn());
const resolveGitHubUserIdentity = vi.hoisted(() => vi.fn());
const ensureProfileForEmail = vi.hoisted(() => vi.fn());
const getUserProfileDisplay = vi.hoisted(() => vi.fn());
const getUserProfileListItem = vi.hoisted(() => vi.fn());
const resolveUserProfileId = vi.hoisted(() => vi.fn());

vi.mock("../../state/user-profiles.js", () => ({
  clearGitHubIdentity,
  ensureProfileForEmail,
  getUserProfileDisplay,
  getUserProfileListItem,
  linkEmail,
  listProfiles,
  resolveUserProfileId,
  setAvatar,
  setDisplayName,
  setGitHubIdentity,
  UserProfileGitHubIdentityConflictError: class UserProfileGitHubIdentityConflictError extends Error {},
  UserProfileNotFoundError: class UserProfileNotFoundError extends Error {},
}));

vi.mock("../github-user-identity.js", () => ({ resolveGitHubUserIdentity }));

async function runUsersHandler(
  method: keyof typeof usersHandlers,
  params: object,
  client?: object,
  context: object = {},
) {
  const respond = vi.fn();
  await expectDefined(
    usersHandlers[method],
    `${method} test invariant`,
  )({ client, context, params, respond } as never);
  return respond;
}

describe("users gateway methods", () => {
  const profile = {
    id: "profile-1",
    displayName: "Ada",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 1,
    emails: ["ada@example.com"],
    githubIdentity: null,
    hasAvatar: false,
  };
  const adminClient = { connect: { scopes: ["operator.admin"] } };
  const selfClient = {
    authenticatedUserId: "ada@example.com",
    connect: { scopes: ["operator.write"] },
  };

  beforeEach(() => {
    ensureProfileForEmail.mockReset();
    getUserProfileDisplay.mockReset();
    getUserProfileListItem.mockReset();
    resolveUserProfileId.mockReset();
    linkEmail.mockReset();
    listProfiles.mockReset();
    setAvatar.mockReset();
    setDisplayName.mockReset();
    setGitHubIdentity.mockReset();
    clearGitHubIdentity.mockReset();
    resolveGitHubUserIdentity.mockReset();
    getUserProfileDisplay.mockReturnValue({
      id: profile.id,
      displayName: profile.displayName,
      avatarRevision: String(profile.updatedAt),
      hasAvatar: profile.hasAvatar,
    });
  });

  it("lists profiles through the read method", async () => {
    listProfiles.mockReturnValue([{ id: "profile-1" }]);

    expect(await runUsersHandler("users.list", {})).toHaveBeenCalledWith(true, {
      profiles: [{ id: "profile-1" }],
    });
  });

  it("creates and returns the caller's profile idempotently", async () => {
    ensureProfileForEmail.mockReturnValue({ id: profile.id });
    getUserProfileListItem.mockReturnValue(profile);

    const first = await runUsersHandler("users.self", {}, selfClient);
    const second = await runUsersHandler("users.self", {}, selfClient);

    expect(first).toHaveBeenCalledWith(true, { profile });
    expect(second).toHaveBeenCalledWith(true, { profile });
    expect(validateUsersSelfResult(first.mock.calls[0]?.[1])).toBe(true);
    expect(ensureProfileForEmail).toHaveBeenNthCalledWith(1, "ada@example.com");
    expect(ensureProfileForEmail).toHaveBeenNthCalledWith(2, "ada@example.com");
    expect(getUserProfileListItem).toHaveBeenNthCalledWith(1, profile.id);
    expect(getUserProfileListItem).toHaveBeenNthCalledWith(2, profile.id);
  });

  it("uses the connect-time provider profile without recreating an email alias", async () => {
    const providerClient = {
      authenticatedUserId: "ada@github",
      authenticatedUserIsTailscaleProvider: true,
      authenticatedUserProfile: {
        profileId: profile.id,
        displayName: "Ada",
        hasAvatar: false,
        updatedAt: 1,
      },
      connect: { scopes: ["operator.write"] },
    };
    resolveUserProfileId.mockReturnValue(profile.id);
    getUserProfileListItem.mockReturnValue({ ...profile, emails: [] });

    const respond = await runUsersHandler("users.self", {}, providerClient);

    expect(respond).toHaveBeenCalledWith(true, { profile: { ...profile, emails: [] } });
    expect(ensureProfileForEmail).not.toHaveBeenCalled();
  });

  it("keeps generic proxy identities on the legacy profile fallback", async () => {
    const proxyClient = {
      authenticatedUserId: "ada@github",
      connect: { scopes: ["operator.write"] },
    };
    ensureProfileForEmail.mockReturnValue({ id: profile.id });
    getUserProfileListItem.mockReturnValue(profile);

    const respond = await runUsersHandler("users.self", {}, proxyClient);

    expect(respond).toHaveBeenCalledWith(true, { profile });
    expect(ensureProfileForEmail).toHaveBeenCalledWith("ada@github");
  });

  it("does not recreate a failed Tailscale provider snapshot as an email alias", async () => {
    const tailscaleClient = {
      authenticatedUserId: "ada@github",
      authenticatedUserIsTailscaleProvider: true,
      connect: { scopes: ["operator.write"] },
    };

    const respond = await runUsersHandler("users.self", {}, tailscaleClient);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "authenticated user profile is unavailable" }),
    );
    expect(ensureProfileForEmail).not.toHaveBeenCalled();
  });

  it("rejects users.self without an authenticated user", async () => {
    expect(
      await runUsersHandler("users.self", {}, { connect: { scopes: ["operator.write"] } }),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        message: "users.self requires an authenticated user",
      }),
    );
    expect(ensureProfileForEmail).not.toHaveBeenCalled();
  });

  it("validates and routes email links", async () => {
    linkEmail.mockReturnValue(profile);
    const refreshConnectedUserProfile = vi.fn();

    const respond = await runUsersHandler(
      "users.linkEmail",
      {
        email: "ada@example.com",
        targetProfileId: "profile-1",
      },
      undefined,
      { refreshConnectedUserProfile },
    );

    expect(respond).toHaveBeenCalledWith(true, { profile });
    expect(validateUsersLinkEmailResult(respond.mock.calls[0]?.[1])).toBe(true);
    expect(linkEmail).toHaveBeenCalledWith("ada@example.com", "profile-1");
    expect(refreshConnectedUserProfile).toHaveBeenCalledWith({
      id: profile.id,
      displayName: profile.displayName,
      avatarRevision: String(profile.updatedAt),
      hasAvatar: profile.hasAvatar,
      updatedAt: profile.updatedAt,
    });
  });

  it("returns protocol-complete display name mutations", async () => {
    setDisplayName.mockReturnValue(profile);
    const refreshConnectedUserProfile = vi.fn();

    const respond = await runUsersHandler(
      "users.setDisplayName",
      {
        profileId: "profile-1",
        displayName: "Ada",
      },
      adminClient,
      { refreshConnectedUserProfile },
    );

    expect(validateUsersSetDisplayNameResult(respond.mock.calls[0]?.[1])).toBe(true);
    expect(refreshConnectedUserProfile).toHaveBeenCalledWith({
      id: profile.id,
      displayName: profile.displayName,
      avatarRevision: "1",
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    });
  });

  it("sets and clears only the authenticated user's GitHub identity", async () => {
    ensureProfileForEmail.mockReturnValue({ id: profile.id });
    resolveUserProfileId.mockReturnValue(profile.id);
    resolveGitHubUserIdentity.mockResolvedValue({ accountId: 583231, login: "octocat" });
    const linked = {
      ...profile,
      githubIdentity: {
        login: "octocat",
        profileUrl: "https://github.com/octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
      },
    };
    setGitHubIdentity.mockReturnValue(linked);
    clearGitHubIdentity.mockReturnValue(profile);

    const setResponse = await runUsersHandler(
      "users.setGitHubIdentity",
      { username: "octocat" },
      selfClient,
    );
    const clearResponse = await runUsersHandler("users.clearGitHubIdentity", {}, selfClient);

    expect(resolveGitHubUserIdentity).toHaveBeenCalledWith("octocat");
    expect(setGitHubIdentity).toHaveBeenCalledWith(profile.id, {
      accountId: 583231,
      login: "octocat",
    });
    expect(validateUsersSetGitHubIdentityResult(setResponse.mock.calls[0]?.[1])).toBe(true);
    expect(validateUsersClearGitHubIdentityResult(clearResponse.mock.calls[0]?.[1])).toBe(true);
  });

  it("rejects GitHub identity changes without an authenticated profile", async () => {
    const anonymous = { connect: { scopes: ["operator.write"] } };
    for (const [method, params] of [
      ["users.setGitHubIdentity", { username: "octocat" }],
      ["users.clearGitHubIdentity", {}],
    ] as const) {
      expect(await runUsersHandler(method, params, anonymous)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
    }
    expect(resolveGitHubUserIdentity).not.toHaveBeenCalled();
  });

  it("returns protocol-complete avatar mutations", async () => {
    const firstProfile = {
      ...profile,
      avatarMime: "image/png" as const,
      hasAvatar: true,
      updatedAt: 2,
    };
    const secondProfile = { ...firstProfile };
    setAvatar
      .mockReturnValueOnce({ ok: true, value: firstProfile })
      .mockReturnValueOnce({ ok: true, value: secondProfile });
    getUserProfileDisplay
      .mockReturnValueOnce({
        id: profile.id,
        displayName: profile.displayName,
        avatarRevision: "first-content-hash-png",
        hasAvatar: true,
      })
      .mockReturnValueOnce({
        id: profile.id,
        displayName: profile.displayName,
        avatarRevision: "second-content-hash-png",
        hasAvatar: true,
      });
    const refreshConnectedUserProfile = vi.fn();

    const firstRespond = await runUsersHandler(
      "users.setAvatar",
      {
        profileId: "profile-1",
        mime: "image/png",
        avatarBase64: "AQ==",
      },
      adminClient,
      { refreshConnectedUserProfile },
    );
    const secondRespond = await runUsersHandler(
      "users.setAvatar",
      {
        profileId: profile.id,
        mime: "image/png",
        avatarBase64: "Ag==",
      },
      adminClient,
      { refreshConnectedUserProfile },
    );

    expect(validateUsersSetAvatarResult(firstRespond.mock.calls[0]?.[1])).toBe(true);
    expect(validateUsersSetAvatarResult(secondRespond.mock.calls[0]?.[1])).toBe(true);
    expect(firstRespond).toHaveBeenCalledWith(true, {
      profile: firstProfile,
      avatarRevision: "first-content-hash-png",
    });
    expect(secondRespond).toHaveBeenCalledWith(true, {
      profile: secondProfile,
      avatarRevision: "second-content-hash-png",
    });
    expect(firstProfile.updatedAt).toBe(secondProfile.updatedAt);
    expect(refreshConnectedUserProfile).toHaveBeenNthCalledWith(1, {
      id: firstProfile.id,
      displayName: firstProfile.displayName,
      avatarRevision: "first-content-hash-png",
      hasAvatar: true,
      updatedAt: firstProfile.updatedAt,
    });
    expect(refreshConnectedUserProfile).toHaveBeenNthCalledWith(2, {
      id: secondProfile.id,
      displayName: secondProfile.displayName,
      avatarRevision: "second-content-hash-png",
      hasAvatar: true,
      updatedAt: secondProfile.updatedAt,
    });
    expect(refreshConnectedUserProfile.mock.invocationCallOrder[0]).toBeLessThan(
      firstRespond.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(refreshConnectedUserProfile.mock.invocationCallOrder[1]).toBeLessThan(
      secondRespond.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("rejects blank email aliases as invalid requests", async () => {
    expect(
      await runUsersHandler("users.linkEmail", {
        email: "   ",
        targetProfileId: "profile-1",
      }),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message: "email must not be empty" }),
    );
    expect(linkEmail).not.toHaveBeenCalled();
  });

  it("rejects malformed avatar payloads before storage", async () => {
    expect(
      await runUsersHandler("users.setAvatar", {
        profileId: "profile-1",
        mime: "image/png",
        avatarBase64: "not base64",
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(setAvatar).not.toHaveBeenCalled();
  });

  it("returns avatar constraint failures as invalid requests", async () => {
    setAvatar.mockReturnValue({ ok: false, error: { code: "avatar_too_large" } });

    expect(
      await runUsersHandler(
        "users.setAvatar",
        {
          profileId: "profile-1",
          mime: "image/png",
          avatarBase64: "AQ==",
        },
        adminClient,
      ),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("allows an identified write caller to edit its own profile", async () => {
    ensureProfileForEmail.mockReturnValue(profile);
    resolveUserProfileId.mockReturnValue(profile.id);
    setDisplayName.mockReturnValue(profile);
    setAvatar.mockReturnValue({ ok: true, value: profile });

    const displayName = await runUsersHandler(
      "users.setDisplayName",
      { profileId: "profile-1", displayName: "Ada Lovelace" },
      selfClient,
    );
    const avatar = await runUsersHandler(
      "users.setAvatar",
      { profileId: "profile-1", mime: "image/png", avatarBase64: "AQ==" },
      selfClient,
    );

    expect(displayName).toHaveBeenCalledWith(true, { profile });
    expect(avatar).toHaveBeenCalledWith(true, {
      profile,
      avatarRevision: String(profile.updatedAt),
    });
    expect(ensureProfileForEmail).toHaveBeenCalledWith("ada@example.com");
  });

  it("authorizes provider-owned profile edits from the connect-time profile id", async () => {
    const providerClient = {
      authenticatedUserId: "ada@github",
      authenticatedUserIsTailscaleProvider: true,
      authenticatedUserProfile: {
        profileId: profile.id,
        displayName: "Ada",
        hasAvatar: false,
        updatedAt: 1,
      },
      connect: { scopes: ["operator.write"] },
    };
    resolveUserProfileId.mockReturnValue(profile.id);
    setDisplayName.mockReturnValue(profile);

    expect(
      await runUsersHandler(
        "users.setDisplayName",
        { profileId: profile.id, displayName: "Ada Lovelace" },
        providerClient,
      ),
    ).toHaveBeenCalledWith(true, { profile });
    expect(ensureProfileForEmail).not.toHaveBeenCalled();
  });

  it("denies an identified write caller changing another profile's avatar", async () => {
    ensureProfileForEmail.mockReturnValue(profile);
    resolveUserProfileId.mockReturnValue("profile-2");

    expect(
      await runUsersHandler(
        "users.setAvatar",
        { profileId: "profile-2", mime: "image/png", avatarBase64: "AQ==" },
        selfClient,
      ),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        message: "profile edits require the owning user or operator.admin",
      }),
    );
    expect(setAvatar).not.toHaveBeenCalled();
  });

  it("allows an owner to edit through a tombstoned durable profile id", async () => {
    ensureProfileForEmail.mockReturnValue(profile);
    resolveUserProfileId.mockReturnValue(profile.id);
    setDisplayName.mockReturnValue(profile);

    expect(
      await runUsersHandler(
        "users.setDisplayName",
        { profileId: "merged-profile-1", displayName: "Ada Lovelace" },
        selfClient,
      ),
    ).toHaveBeenCalledWith(true, { profile });
    expect(resolveUserProfileId).toHaveBeenCalledWith("merged-profile-1");
  });
});
