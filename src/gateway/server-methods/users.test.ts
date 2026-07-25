import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateUsersLinkEmailResult,
  validateUsersSelfResult,
  validateUsersSetAvatarResult,
  validateUsersSetDisplayNameResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { usersHandlers } from "./users.js";

const linkEmail = vi.hoisted(() => vi.fn());
const listProfiles = vi.hoisted(() => vi.fn());
const setAvatar = vi.hoisted(() => vi.fn());
const setDisplayName = vi.hoisted(() => vi.fn());
const ensureProfileForEmail = vi.hoisted(() => vi.fn());
const getUserProfileListItem = vi.hoisted(() => vi.fn());
const resolveUserProfileId = vi.hoisted(() => vi.fn());

vi.mock("../../state/user-profiles.js", () => ({
  ensureProfileForEmail,
  getUserProfileListItem,
  linkEmail,
  listProfiles,
  resolveUserProfileId,
  setAvatar,
  setDisplayName,
  UserProfileNotFoundError: class UserProfileNotFoundError extends Error {},
}));

async function runUsersHandler(
  method: keyof typeof usersHandlers,
  params: object,
  client?: object,
) {
  const respond = vi.fn();
  await expectDefined(
    usersHandlers[method],
    `${method} test invariant`,
  )({ client, params, respond } as never);
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
    hasAvatar: false,
  };
  const adminClient = { connect: { scopes: ["operator.admin"] } };
  const selfClient = {
    authenticatedUserId: "ada@example.com",
    connect: { scopes: ["operator.write"] },
  };

  beforeEach(() => {
    ensureProfileForEmail.mockReset();
    getUserProfileListItem.mockReset();
    resolveUserProfileId.mockReset();
    linkEmail.mockReset();
    listProfiles.mockReset();
    setAvatar.mockReset();
    setDisplayName.mockReset();
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

    const respond = await runUsersHandler("users.linkEmail", {
      email: "ada@example.com",
      targetProfileId: "profile-1",
    });

    expect(respond).toHaveBeenCalledWith(true, { profile });
    expect(validateUsersLinkEmailResult(respond.mock.calls[0]?.[1])).toBe(true);
    expect(linkEmail).toHaveBeenCalledWith("ada@example.com", "profile-1");
  });

  it("returns protocol-complete display name mutations", async () => {
    setDisplayName.mockReturnValue(profile);

    const respond = await runUsersHandler(
      "users.setDisplayName",
      {
        profileId: "profile-1",
        displayName: "Ada",
      },
      adminClient,
    );

    expect(validateUsersSetDisplayNameResult(respond.mock.calls[0]?.[1])).toBe(true);
  });

  it("returns protocol-complete avatar mutations", async () => {
    setAvatar.mockReturnValue({
      ok: true,
      value: { ...profile, avatarMime: "image/png", hasAvatar: true },
    });

    const respond = await runUsersHandler(
      "users.setAvatar",
      {
        profileId: "profile-1",
        mime: "image/png",
        avatarBase64: "AQ==",
      },
      adminClient,
    );

    expect(validateUsersSetAvatarResult(respond.mock.calls[0]?.[1])).toBe(true);
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
    expect(avatar).toHaveBeenCalledWith(true, { profile });
    expect(ensureProfileForEmail).toHaveBeenCalledWith("ada@example.com");
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
