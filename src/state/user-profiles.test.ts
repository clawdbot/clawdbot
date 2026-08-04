import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  ensureProfileForEmail,
  formatUserProfileAvatarEtag,
  getProfileAvatar,
  linkEmail,
  listProfiles,
  resolveUserProfileId,
  setAvatar,
  setDisplayName,
} from "./user-profiles.js";

const statePaths: string[] = [];

function stateOptions() {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-user-profiles-"));
  const path = join(directory, "openclaw.sqlite");
  statePaths.push(path);
  return { path };
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("user profiles", () => {
  it("lazily ensures and resolves lowercased email aliases idempotently", () => {
    const options = stateOptions();
    expect(tableExists(openOpenClawStateDatabase(options).db, "user_profiles")).toBe(false);

    const first = ensureProfileForEmail("  Ada@Example.COM ", options);
    const second = ensureProfileForEmail("ada@example.com", options);

    expect(tableExists(openOpenClawStateDatabase(options).db, "user_profiles")).toBe(true);
    expect(second).toEqual(first);
    expect(ensureProfileForEmail("ADA@example.com", options)).toEqual(first);
    expect(listProfiles(options)).toEqual([
      expect.objectContaining({ id: first.id, emails: ["ada@example.com"] }),
    ]);
  });

  it("moves aliases and leaves an aliasless source profile as a one-hop tombstone", () => {
    const options = stateOptions();
    const source = ensureProfileForEmail("source@example.com", options);
    const target = ensureProfileForEmail("target@example.com", options);

    const linked = linkEmail("source@example.com", target.id, options);

    expect(ensureProfileForEmail("source@example.com", options).id).toBe(target.id);
    expect(linked).toMatchObject({
      id: target.id,
      emails: ["source@example.com", "target@example.com"],
      hasAvatar: false,
    });
    expect(listProfiles(options)).toContainEqual(
      expect.objectContaining({ id: source.id, mergedInto: target.id, emails: [] }),
    );
  });

  it("compresses tombstones so durable profile references resolve to the merge head", () => {
    const options = stateOptions();
    const a = ensureProfileForEmail("a@example.com", options);
    const b = ensureProfileForEmail("b@example.com", options);
    const c = ensureProfileForEmail("c@example.com", options);

    linkEmail("a@example.com", b.id, options);
    linkEmail("a@example.com", c.id, options);
    linkEmail("b@example.com", c.id, options);

    expect(setDisplayName(a.id, "Durable A", options)).toMatchObject({ id: c.id });
    expect(resolveUserProfileId(a.id, options)).toBe(c.id);
    expect(listProfiles(options)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: a.id, mergedInto: c.id }),
        expect.objectContaining({ id: b.id, mergedInto: c.id }),
      ]),
    );
  });

  it("resolves a tombstoned link target to its head without forming a cycle", () => {
    const options = stateOptions();
    const a = ensureProfileForEmail("a@example.com", options);
    const b = ensureProfileForEmail("b@example.com", options);

    linkEmail("a@example.com", b.id, options);
    linkEmail("a@example.com", a.id, options);

    expect(ensureProfileForEmail("a@example.com", options).id).toBe(b.id);
    expect(listProfiles(options)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: a.id, mergedInto: b.id }),
        expect.objectContaining({ id: b.id, mergedInto: null }),
      ]),
    );
  });

  it("updates display names", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("ada@example.com", options);

    expect(setDisplayName(profile.id, "Ada Lovelace", options)).toMatchObject({
      id: profile.id,
      displayName: "Ada Lovelace",
      emails: ["ada@example.com"],
      hasAvatar: false,
    });
  });

  it("updates all profiles whose aliases change", () => {
    const options = stateOptions();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(100);
    const source = ensureProfileForEmail("source@example.com", options);
    now.mockReturnValue(200);
    const target = ensureProfileForEmail("target@example.com", options);
    now.mockReturnValue(300);
    linkEmail("source-alias@example.com", source.id, options);

    now.mockReturnValue(400);
    const linked = linkEmail("source@example.com", target.id, options);

    expect(linked).toMatchObject({
      id: target.id,
      updatedAt: 400,
      emails: ["source@example.com", "target@example.com"],
    });
    expect(listProfiles(options)).toContainEqual(
      expect.objectContaining({
        id: source.id,
        updatedAt: 400,
        emails: ["source-alias@example.com"],
      }),
    );
  });

  it("bounds generated display names to the protocol limit", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail(`${"a".repeat(300)}@example.com`, options);

    expect(profile.displayName).toHaveLength(256);
  });

  it("rejects oversized and unsupported avatar uploads", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("ada@example.com", options);

    expect(setAvatar(profile.id, new Uint8Array(512 * 1024 + 1), "image/png", options)).toEqual({
      ok: false,
      error: { code: "avatar_too_large", maxBytes: 512 * 1024 },
    });
    expect(setAvatar(profile.id, new Uint8Array([1]), "image/gif", options)).toEqual({
      ok: false,
      error: { code: "unsupported_avatar_mime", mime: "image/gif" },
    });
  });

  it("stores an allowlisted avatar", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("ada@example.com", options);

    expect(setAvatar(profile.id, new Uint8Array([1, 2, 3]), "image/png", options)).toEqual({
      ok: true,
      value: expect.objectContaining({
        id: profile.id,
        avatarMime: "image/png",
        emails: ["ada@example.com"],
        hasAvatar: true,
      }),
    });
    expect(getProfileAvatar(profile.id, options)).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/png",
      sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      updatedAt: expect.any(Number),
    });
    expect(listProfiles(options)).toEqual([
      expect.objectContaining({ id: profile.id, hasAvatar: true }),
    ]);
  });

  it("keeps distinct avatar ETags when updates share a millisecond", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("ada@example.com", options);
    vi.spyOn(Date, "now").mockReturnValue(100);

    expect(setAvatar(profile.id, new Uint8Array([1]), "image/png", options).ok).toBe(true);
    const first = getProfileAvatar(profile.id, options);
    expect(setAvatar(profile.id, new Uint8Array([2]), "image/png", options).ok).toBe(true);
    const second = getProfileAvatar(profile.id, options);

    expect(first?.updatedAt).toBe(second?.updatedAt);
    expect(formatUserProfileAvatarEtag(first?.sha256 ?? "", first?.mime ?? "image/png")).not.toBe(
      formatUserProfileAvatarEtag(second?.sha256 ?? "", second?.mime ?? "image/png"),
    );
  });

  it("keeps distinct avatar ETags when MIME changes with identical bytes", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("ada@example.com", options);
    const bytes = new Uint8Array([1, 2, 3]);

    expect(setAvatar(profile.id, bytes, "image/png", options).ok).toBe(true);
    const png = getProfileAvatar(profile.id, options);
    expect(setAvatar(profile.id, bytes, "image/webp", options).ok).toBe(true);
    const webp = getProfileAvatar(profile.id, options);

    expect(formatUserProfileAvatarEtag(png?.sha256 ?? "", png?.mime ?? "image/png")).not.toBe(
      formatUserProfileAvatarEtag(webp?.sha256 ?? "", webp?.mime ?? "image/png"),
    );
  });
});
