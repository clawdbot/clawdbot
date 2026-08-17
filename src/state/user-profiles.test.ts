import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { migrateLegacyTailscaleProfileIdentities } from "./user-profiles-tailscale-migration.js";
import {
  adoptTailscaleProfileAvatar,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  formatUserProfileAvatarEtag,
  getProfileAvatar,
  getUserProfileDisplay,
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

function fixtureImage(path: string): Buffer {
  return readFileSync(join(process.cwd(), path));
}

function imageFetch(bytes: Uint8Array, mime: string) {
  return vi.fn(
    async () => new Response(Uint8Array.from(bytes).buffer, { headers: { "content-type": mime } }),
  );
}

async function ensureTailscaleProfileWithAvatar(
  identity: Parameters<typeof ensureProfileForTailscaleIdentity>[0],
  options: Parameters<typeof ensureProfileForTailscaleIdentity>[1],
  fetchOptions: Parameters<typeof adoptTailscaleProfileAvatar>[3],
) {
  const profile = ensureProfileForTailscaleIdentity(identity, options);
  return await adoptTailscaleProfileAvatar(profile.id, identity.profilePic, options, fetchOptions);
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("user profiles", () => {
  it("lazily ensures and resolves lowercased email aliases idempotently", () => {
    const options = stateOptions();
    const database = openOpenClawStateDatabase(options).db;
    const versionBefore = database.prepare("PRAGMA user_version").get()?.user_version;
    expect(tableExists(database, "user_profiles")).toBe(false);
    expect(tableExists(database, "user_profile_identities")).toBe(false);

    const first = ensureProfileForEmail("  Ada@Example.COM ", options);
    const second = ensureProfileForEmail("ada@example.com", options);

    expect(tableExists(openOpenClawStateDatabase(options).db, "user_profiles")).toBe(true);
    expect(tableExists(openOpenClawStateDatabase(options).db, "user_profile_identities")).toBe(
      true,
    );
    expect(
      openOpenClawStateDatabase(options).db.prepare("PRAGMA user_version").get()?.user_version,
    ).toBe(versionBefore);
    expect(OPENCLAW_STATE_SCHEMA_VERSION).toBe(9);
    expect(second).toEqual(first);
    expect(ensureProfileForEmail("ADA@example.com", options)).toEqual(first);
    expect(listProfiles(options)).toEqual([
      expect.objectContaining({ id: first.id, emails: ["ada@example.com"] }),
    ]);
  });

  it("resolves provider identities without storing them as emails", () => {
    const options = stateOptions();

    const first = ensureProfileForTailscaleIdentity(
      { login: "Ada@GitHub", name: "Ada Lovelace" },
      options,
    );
    const second = ensureProfileForTailscaleIdentity(
      { login: "ada@github", name: "Different Provider Name" },
      options,
    );

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe("Ada Lovelace");
    expect(listProfiles(options)).toEqual([
      expect.objectContaining({ id: first.id, emails: [], displayName: "Ada Lovelace" }),
    ]);
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT provider, subject, profile_id FROM user_profile_identities ORDER BY provider, subject",
        )
        .all(),
    ).toEqual([{ provider: "github", subject: "ada", profile_id: first.id }]);
  });

  it("keeps dotted Tailscale logins on the email alias path", () => {
    const options = stateOptions();

    const profile = ensureProfileForTailscaleIdentity(
      { login: "Person@Gmail.COM", name: "Person Example" },
      options,
    );

    expect(ensureProfileForEmail("person@gmail.com", options).id).toBe(profile.id);
    expect(profile.displayName).toBe("Person Example");
    expect(listProfiles(options)).toEqual([
      expect.objectContaining({ id: profile.id, emails: ["person@gmail.com"] }),
    ]);
  });

  it("adopts a Tailscale name only while the display-name slot is empty", () => {
    const options = stateOptions();
    const profile = ensureProfileForTailscaleIdentity(
      { login: "ada@github", name: "Ada Provider" },
      options,
    );

    setDisplayName(profile.id, null, options);
    expect(
      ensureProfileForTailscaleIdentity({ login: "ada@github", name: "Ada Adopted" }, options),
    ).toMatchObject({ displayName: "Ada Adopted" });

    setDisplayName(profile.id, "User Chosen", options);
    expect(
      ensureProfileForTailscaleIdentity({ login: "ada@github", name: "Provider Changed" }, options),
    ).toMatchObject({ displayName: "User Chosen" });
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

  it.each([
    ["image/png", "ui/public/favicon-32.png"],
    ["image/jpeg", "docs/whatsapp-openclaw.jpg"],
    ["image/webp", "ui/public/app-art/android.webp"],
  ])("adopts a bounded %s Tailscale avatar", async (mime, path) => {
    const options = stateOptions();
    const bytes = fixtureImage(path);

    const profile = await ensureTailscaleProfileWithAvatar(
      {
        login: `avatar-${mime.slice("image/".length)}@github`,
        name: "Avatar User",
        profilePic: "https://avatars.example.test/profile",
      },
      options,
      { fetchImpl: imageFetch(bytes, mime) },
    );

    expect(profile.avatarMime).toBe(mime);
    const stored = getProfileAvatar(profile.id, options);
    expect(stored).toMatchObject({
      mime,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(Buffer.from(stored?.bytes ?? []).equals(bytes)).toBe(true);
  });

  it.each([
    {
      name: "oversized",
      fetchImpl: vi.fn(
        async () =>
          new Response("x", {
            headers: {
              "content-length": String(512 * 1024 + 1),
              "content-type": "image/png",
            },
          }),
      ),
    },
    {
      name: "wrong-type",
      fetchImpl: vi.fn(
        async () => new Response("not an image", { headers: { "content-type": "text/plain" } }),
      ),
    },
    {
      name: "failed-fetch",
      fetchImpl: vi.fn(async () => {
        throw new Error("network unavailable");
      }),
    },
  ])("keeps the avatar empty after a $name fetch", async ({ fetchImpl }) => {
    const options = stateOptions();

    const profile = await ensureTailscaleProfileWithAvatar(
      {
        login: "avatar-failure@github",
        name: "Still Authenticated",
        profilePic: "https://avatars.example.test/profile",
      },
      options,
      { fetchImpl },
    );

    expect(profile).toMatchObject({ displayName: "Still Authenticated", avatarMime: null });
    expect(getProfileAvatar(profile.id, options)).toBeUndefined();
  });

  it("times out avatar adoption without failing profile resolution", async () => {
    const options = stateOptions();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                init.signal?.reason instanceof Error
                  ? init.signal.reason
                  : new Error("avatar fetch aborted"),
              ),
            { once: true },
          );
        }),
    );

    const profile = await ensureTailscaleProfileWithAvatar(
      {
        login: "avatar-timeout@github",
        name: "Timeout User",
        profilePic: "https://avatars.example.test/profile",
      },
      options,
      { fetchImpl, timeoutMs: 10 },
    );

    expect(profile).toMatchObject({ displayName: "Timeout User", avatarMime: null });
    expect(getProfileAvatar(profile.id, options)).toBeUndefined();
  });

  it("preserves a user avatar written while provider avatar bytes are in flight", async () => {
    const options = stateOptions();
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const pending = ensureTailscaleProfileWithAvatar(
      {
        login: "avatar-race@github",
        name: "Race User",
        profilePic: "https://avatars.example.test/profile",
      },
      options,
      { fetchImpl },
    );
    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"));
    const profileId = listProfiles(options)[0]?.id;
    expect(profileId).toBeTruthy();
    expect(setAvatar(profileId!, new Uint8Array([9, 8, 7]), "image/png", options).ok).toBe(true);

    resolveFetch?.(
      new Response(Uint8Array.from(fixtureImage("ui/public/favicon-32.png")).buffer, {
        headers: { "content-type": "image/png" },
      }),
    );
    await pending;

    expect(getProfileAvatar(profileId!, options)?.bytes).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("migrates legacy provider logins while preserving profiles and real emails", () => {
    const options = stateOptions();
    const provider = ensureProfileForEmail("user@github", options);
    const email = ensureProfileForEmail("person@gmail.com", options);
    setDisplayName(provider.id, "User Chosen", options);
    expect(setAvatar(provider.id, new Uint8Array([9, 8, 7]), "image/png", options).ok).toBe(true);

    expect(migrateLegacyTailscaleProfileIdentities(options)).toEqual({
      changes: ["Moved 1 legacy Tailscale provider identity out of user profile email aliases."],
      warnings: [],
    });
    expect(migrateLegacyTailscaleProfileIdentities(options)).toEqual({ changes: [], warnings: [] });

    const database = openOpenClawStateDatabase(options).db;
    expect(
      database.prepare("SELECT provider, subject, profile_id FROM user_profile_identities").all(),
    ).toEqual([{ provider: "github", subject: "user", profile_id: provider.id }]);
    expect(database.prepare("SELECT email, profile_id FROM user_profile_emails").all()).toEqual([
      { email: "person@gmail.com", profile_id: email.id },
    ]);
    expect(listProfiles(options)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: provider.id,
          displayName: "User Chosen",
          emails: [],
          hasAvatar: true,
        }),
        expect.objectContaining({ id: email.id, emails: ["person@gmail.com"] }),
      ]),
    );
    expect(getProfileAvatar(provider.id, options)?.bytes).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("does not activate user-profile tables when Doctor has no legacy aliases", () => {
    const options = stateOptions();
    const database = openOpenClawStateDatabase(options).db;

    expect(migrateLegacyTailscaleProfileIdentities(options)).toEqual({ changes: [], warnings: [] });
    expect(tableExists(database, "user_profiles")).toBe(false);
    expect(tableExists(database, "user_profile_identities")).toBe(false);
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
    const firstDisplay = getUserProfileDisplay(profile.id, options);
    expect(setAvatar(profile.id, new Uint8Array([2]), "image/png", options).ok).toBe(true);
    const second = getProfileAvatar(profile.id, options);
    const secondDisplay = getUserProfileDisplay(profile.id, options);

    expect(first?.updatedAt).toBe(second?.updatedAt);
    expect(firstDisplay.avatarRevision).not.toBe(secondDisplay.avatarRevision);
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
    const pngDisplay = getUserProfileDisplay(profile.id, options);
    expect(setAvatar(profile.id, bytes, "image/webp", options).ok).toBe(true);
    const webp = getProfileAvatar(profile.id, options);
    const webpDisplay = getUserProfileDisplay(profile.id, options);

    expect(pngDisplay.avatarRevision).not.toBe(webpDisplay.avatarRevision);
    expect(formatUserProfileAvatarEtag(png?.sha256 ?? "", png?.mime ?? "image/png")).not.toBe(
      formatUserProfileAvatarEtag(webp?.sha256 ?? "", webp?.mime ?? "image/png"),
    );
  });
});
