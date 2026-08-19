import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/index.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { getUserPreferences, setUserPreferences } from "./user-preferences.js";
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
  syncGitHubIdentity,
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
    ).toEqual([{ provider: "github", subject: "login:ada", profile_id: first.id }]);
  });

  it("lazily adds canonical GitHub login storage without changing the schema version", () => {
    const options = stateOptions();
    const database = openOpenClawStateDatabase(options).db;
    database.exec(`
      CREATE TABLE user_profile_identities (
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (provider, subject)
      ) STRICT;
    `);
    const versionBefore = database.prepare("PRAGMA user_version").get()?.user_version;

    ensureProfileForEmail("ada@example.com", options);

    expect(tableHasColumn(database, "user_profile_identities", "canonical_login")).toBe(true);
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(versionBefore);
  });

  it("stores and refreshes verified GitHub identity beside the authenticated login alias", () => {
    const options = stateOptions();
    const profile = ensureProfileForTailscaleIdentity(
      { login: "583231@github", name: "Numeric Login" },
      options,
    );

    expect(
      syncGitHubIdentity(profile.id, { accountId: 583231, login: "octocat" }, options),
    ).toMatchObject({
      id: profile.id,
      githubIdentity: {
        login: "octocat",
        profileUrl: "https://github.com/octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
      },
    });
    expect(
      syncGitHubIdentity(profile.id, { accountId: 583231, login: "Octo-Renamed" }, options)
        .githubIdentity,
    ).toMatchObject({ login: "Octo-Renamed" });
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT provider, subject, canonical_login, profile_id FROM user_profile_identities ORDER BY subject",
        )
        .all(),
    ).toEqual([
      {
        provider: "github",
        subject: "583231",
        canonical_login: "Octo-Renamed",
        profile_id: profile.id,
      },
      {
        provider: "github",
        subject: "login:583231",
        canonical_login: null,
        profile_id: profile.id,
      },
    ]);
  });

  it("reconciles a GitHub rename to the established profile and its preferences", () => {
    const options = stateOptions();
    const established = ensureProfileForTailscaleIdentity(
      { login: "ada@github", name: "Established Ada" },
      options,
    );
    syncGitHubIdentity(established.id, { accountId: 583231, login: "ada" }, options);
    setDisplayName(established.id, "User Chosen", options);
    expect(setUserPreferences(established.id, { theme: "claw" }, options)).toMatchObject({
      ok: true,
    });

    const renamed = ensureProfileForTailscaleIdentity(
      { login: "octocat@github", name: "Provider Renamed" },
      options,
    );
    const reconciled = syncGitHubIdentity(
      renamed.id,
      { accountId: 583231, login: "octocat" },
      options,
    );

    expect(reconciled).toMatchObject({
      id: established.id,
      displayName: "User Chosen",
      githubIdentity: { login: "octocat" },
    });
    expect(resolveUserProfileId(renamed.id, options)).toBe(established.id);
    expect(getUserPreferences(established.id, undefined, options)).toMatchObject({ theme: "claw" });
  });

  it("migrates matching legacy consent but discards mismatched legacy attribution", () => {
    const options = stateOptions();
    const matching = ensureProfileForTailscaleIdentity({ login: "ada@github" }, options);
    const mismatched = ensureProfileForTailscaleIdentity({ login: "grace@github" }, options);
    const database = openOpenClawStateDatabase(options).db;
    const insertLegacy = database.prepare(
      "INSERT INTO user_profile_identities (provider, subject, profile_id, canonical_login, created_at) VALUES ('github-attribution', ?, ?, ?, 1)",
    );
    insertLegacy.run("10", matching.id, "ada");
    insertLegacy.run("99", mismatched.id, "wrong-account");

    expect(syncGitHubIdentity(matching.id, { accountId: 10, login: "ada" }, options)).toMatchObject(
      { githubIdentity: { login: "ada" } },
    );
    syncGitHubIdentity(mismatched.id, { accountId: 11, login: "grace" }, options);

    expect(getUserPreferences(matching.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({
      [GIT_COAUTHOR_PREFERENCE_KEY]: true,
    });
    expect(getUserPreferences(mismatched.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({});
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM user_profile_identities WHERE provider = ?")
        .get("github-attribution"),
    ).toEqual({ count: 0 });
  });

  it("does not carry co-author consent to a different immutable GitHub account", () => {
    const options = stateOptions();
    const profile = ensureProfileForTailscaleIdentity({ login: "shared@github" }, options);
    syncGitHubIdentity(profile.id, { accountId: 10, login: "first-owner" }, options);
    expect(
      setUserPreferences(profile.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }, options),
    ).toMatchObject({ ok: true });

    syncGitHubIdentity(profile.id, { accountId: 11, login: "next-owner" }, options);

    expect(getUserPreferences(profile.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({});
  });

  it("keeps co-author consent with the verified account that survives an email merge", () => {
    const options = stateOptions();
    const discarded = ensureProfileForEmail("discarded@example.com", options);
    const established = ensureProfileForEmail("established@example.com", options);
    syncGitHubIdentity(discarded.id, { accountId: 10, login: "discarded" }, options);
    syncGitHubIdentity(established.id, { accountId: 11, login: "established" }, options);
    setUserPreferences(discarded.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }, options);

    const merged = linkEmail("discarded@example.com", established.id, options);

    expect(merged.githubIdentity).toMatchObject({ login: "established" });
    expect(getUserPreferences(established.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({});

    const carrying = ensureProfileForEmail("carrying@example.com", options);
    const unverified = ensureProfileForEmail("unverified@example.com", options);
    syncGitHubIdentity(carrying.id, { accountId: 12, login: "carrying" }, options);
    setUserPreferences(carrying.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }, options);

    const carried = linkEmail("carrying@example.com", unverified.id, options);

    expect(carried.githubIdentity).toMatchObject({ login: "carrying" });
    expect(getUserPreferences(unverified.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({
      [GIT_COAUTHOR_PREFERENCE_KEY]: true,
    });
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
    ).toEqual([{ provider: "github", subject: "login:user", profile_id: provider.id }]);
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
