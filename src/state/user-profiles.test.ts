import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { getUserPreferences, setUserPreferences } from "./user-preferences.js";
import { onUserProfilesChanged, readUserProfileVersion } from "./user-profile-events.js";
import { migrateLegacyTailscaleProfileIdentities } from "./user-profiles-tailscale-migration.js";
import {
  adoptTailscaleProfileAvatar,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  formatUserProfileAvatarEtag,
  getProfileAvatar,
  getUserProfileDisplay,
  getUserProfileListItem,
  getUserProfileRole,
  linkEmail,
  listProfiles,
  setAvatar,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

it("publishes profile changes only after the owning transaction commits", () => {
  const options = stateOptions();
  const profile = ensureProfileForEmail("publication@example.test", options);
  const changed = vi.fn();
  const stop = onUserProfilesChanged(changed);
  const before = readUserProfileVersion();
  try {
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        setDisplayName(profile.id, "Rolled back", options);
        expect(changed).not.toHaveBeenCalled();
        throw new Error("rollback");
      }, options),
    ).toThrow("rollback");
    expect(readUserProfileVersion()).toBe(before);
    expect(getUserProfileDisplay(profile.id, options).displayName).not.toBe("Rolled back");
    runOpenClawStateWriteTransaction(() => {
      setDisplayName(profile.id, "Committed", options);
      expect(changed).not.toHaveBeenCalled();
    }, options);
    expect(changed).toHaveBeenCalledOnce();
    expect(readUserProfileVersion()).toBe(before + 1);
  } finally {
    stop();
  }
});

function stateOptions() {
  const directory = tempDirs.make("openclaw-user-profiles-");
  return { path: join(directory, "openclaw.sqlite") };
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

function syncTailscaleGitHubProfile(
  params: {
    accountId: number;
    canonicalLogin: string;
    login: string;
    name?: string;
    githubName?: string;
  },
  options: Parameters<typeof ensureProfileForTailscaleIdentity>[1],
) {
  return syncGitHubIdentity(
    {
      identity: {
        accountId: params.accountId,
        login: params.canonicalLogin,
        name: params.githubName,
      },
      authenticationAlias: { kind: "github-login", login: params.login },
      initialDisplayName: params.name,
    },
    options,
  );
}

function syncEmailGitHubProfile(
  params: { accountId: number; canonicalLogin: string; email: string; name?: string },
  options: Parameters<typeof ensureProfileForEmail>[1],
) {
  return syncGitHubIdentity(
    {
      identity: { accountId: params.accountId, login: params.canonicalLogin },
      authenticationAlias: { kind: "email", email: params.email },
      initialDisplayName: params.name,
    },
    options,
  );
}

describe("user profiles", () => {
  it.each([false, true])(
    "display lookup leaves absent profile storage absent (database exists: %s)",
    (databaseExists) => {
      const options = stateOptions();
      const database = databaseExists ? openOpenClawStateDatabase(options).db : undefined;
      expect(() => getUserProfileDisplay("missing-profile", options)).toThrow(
        "user profile not found",
      );
      if (database) {
        expect(tableExists(database, "user_profiles")).toBe(false);
      } else {
        expect(existsSync(options.path)).toBe(false);
      }
    },
  );

  it("lazily ensures and resolves lowercased email aliases idempotently", () => {
    const options = stateOptions();
    const database = openOpenClawStateDatabase(options).db;
    const versionBefore = database.prepare("PRAGMA user_version").get()?.user_version;
    expect(tableExists(database, "user_profiles")).toBe(false);
    expect(tableExists(database, "user_profile_identities")).toBe(false);

    const first = ensureProfileForEmail("  Ada@Example.COM ", options);
    const version = readUserProfileVersion();
    const second = ensureProfileForEmail("ada@example.com", options);

    expect(tableExists(openOpenClawStateDatabase(options).db, "user_profiles")).toBe(true);
    expect(tableExists(openOpenClawStateDatabase(options).db, "user_profile_identities")).toBe(
      true,
    );
    expect(
      openOpenClawStateDatabase(options).db.prepare("PRAGMA user_version").get()?.user_version,
    ).toBe(versionBefore);
    expect(versionBefore).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(second).toEqual(first);
    expect(ensureProfileForEmail("ADA@example.com", options)).toEqual(first);
    expect(readUserProfileVersion()).toBe(version);
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
    const version = readUserProfileVersion();
    const second = ensureProfileForTailscaleIdentity(
      { login: "ada@github", name: "Different Provider Name" },
      options,
    );

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe("Ada Lovelace");
    expect(readUserProfileVersion()).toBe(version);
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

  it("publishes a normalized provider subject without repeating an unchanged identity", () => {
    const options = stateOptions();
    const identity = { login: "ada@github" };
    const profile = ensureProfileForTailscaleIdentity(identity, options);
    const database = openOpenClawStateDatabase(options).db;
    database
      .prepare("UPDATE user_profile_identities SET subject = ? WHERE provider = ?")
      .run("ada", "github");
    const version = readUserProfileVersion();

    expect(ensureProfileForTailscaleIdentity(identity, options)).toEqual(profile);
    expect(readUserProfileVersion()).toBe(version + 1);
    expect(database.prepare("SELECT subject FROM user_profile_identities").all()).toEqual([
      { subject: "login:ada" },
    ]);
    expect(ensureProfileForTailscaleIdentity(identity, options)).toEqual(profile);
    expect(readUserProfileVersion()).toBe(version + 1);
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

  it("lazily adds a downgrade-safe nullable role without changing the schema version", () => {
    const options = stateOptions();
    const database = openOpenClawStateDatabase(options).db;
    database.exec(`
      CREATE TABLE user_profiles (
        id TEXT NOT NULL PRIMARY KEY,
        display_name TEXT,
        avatar BLOB,
        avatar_mime TEXT,
        avatar_sha256 TEXT,
        merged_into TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    const versionBefore = database.prepare("PRAGMA user_version").get()?.user_version;
    const profile = ensureProfileForEmail("ada@example.com", options);

    expect(tableHasColumn(database, "user_profiles", "role")).toBe(false);
    expect(getUserProfileListItem(profile.id, options)).not.toHaveProperty("role");
    expect(getUserProfileDisplay(profile.id, options)).toMatchObject({
      id: profile.id,
      hasAvatar: false,
    });
    expect(listProfiles(options)[0]).not.toHaveProperty("role");
    expect(tableHasColumn(database, "user_profiles", "role")).toBe(false);
    expect(getUserProfileRole(profile.id, options)).toBeNull();
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(versionBefore);
    expect(database.prepare("PRAGMA table_info(user_profiles)").all()).toContainEqual(
      expect.objectContaining({
        name: "role",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      }),
    );

    setUserProfileRole(profile.id, "maintainer", options);
    database
      .prepare("UPDATE user_profiles SET display_name = ? WHERE id = ?")
      .run("Older Reader", profile.id);
    database
      .prepare("INSERT INTO user_profiles (id, created_at, updated_at) VALUES (?, ?, ?)")
      .run("older-profile", 1, 1);
    closeOpenClawStateDatabaseForTest();

    expect(getUserProfileRole(profile.id, options)).toBe("maintainer");
    expect(getUserProfileRole("older-profile", options)).toBeNull();
    expect(getUserProfileListItem(profile.id, options)).toMatchObject({
      displayName: "Older Reader",
      role: "maintainer",
    });
  });

  it("assigns and clears roles on canonical profile heads without changing unassigned shapes", () => {
    const options = stateOptions();
    const source = ensureProfileForEmail("source@example.com", options);
    const target = ensureProfileForEmail("target@example.com", options);

    expect(getUserProfileListItem(target.id, options)).not.toHaveProperty("role");
    expect(listProfiles(options).every((profile) => !("role" in profile))).toBe(true);

    linkEmail("source@example.com", target.id, options);
    const version = readUserProfileVersion();
    expect(setUserProfileRole(source.id, "maintainer", options)).toMatchObject({
      id: target.id,
      role: "maintainer",
    });
    expect(readUserProfileVersion()).toBe(version + 1);
    expect(getUserProfileRole(source.id, options)).toBe("maintainer");
    expect(getUserProfileRole(target.id, options)).toBe("maintainer");
    expect(listProfiles(options)).toContainEqual(
      expect.objectContaining({ id: target.id, role: "maintainer" }),
    );

    const cleared = setUserProfileRole(source.id, null, options);
    expect(readUserProfileVersion()).toBe(version + 2);
    expect(cleared).toMatchObject({ id: target.id });
    expect(cleared).not.toHaveProperty("role");
    expect(getUserProfileRole(target.id, options)).toBeNull();
    expect(listProfiles(options).every((profile) => !("role" in profile))).toBe(true);
  });

  it("rejects role access for a missing durable profile", () => {
    const options = stateOptions();

    expect(() => getUserProfileRole("missing-profile", options)).toThrow(
      "user profile not found: missing-profile",
    );
    expect(() => setUserProfileRole("missing-profile", "guest", options)).toThrow(
      "user profile not found: missing-profile",
    );
  });

  it("stores and refreshes verified GitHub identity beside the authenticated login alias", () => {
    const options = stateOptions();
    const profile = syncTailscaleGitHubProfile(
      {
        accountId: 583231,
        canonicalLogin: "octocat",
        login: "583231",
        name: "Numeric Login",
      },
      options,
    );

    expect(profile).toMatchObject({
      id: profile.id,
      githubIdentity: {
        login: "octocat",
        profileUrl: "https://github.com/octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
      },
    });
    const version = readUserProfileVersion();
    expect(
      syncTailscaleGitHubProfile(
        { accountId: 583231, canonicalLogin: "Octo-Renamed", login: "583231" },
        options,
      ).githubIdentity,
    ).toMatchObject({ login: "Octo-Renamed" });
    expect(readUserProfileVersion()).toBe(version + 1);
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
    const established = syncTailscaleGitHubProfile(
      {
        accountId: 583231,
        canonicalLogin: "ada",
        login: "ada",
        name: "Established Ada",
      },
      options,
    );
    setDisplayName(established.id, "User Chosen", options);
    expect(setUserPreferences(established.id, { theme: "claw" }, options)).toMatchObject({
      ok: true,
    });

    const reconciled = syncTailscaleGitHubProfile(
      {
        accountId: 583231,
        canonicalLogin: "octocat",
        login: "octocat",
        name: "Provider Renamed",
        githubName: "GitHub Renamed",
      },
      options,
    );

    expect(reconciled).toMatchObject({
      id: established.id,
      displayName: "User Chosen",
      githubIdentity: { login: "octocat" },
    });
    expect(getUserPreferences(established.id, undefined, options)).toMatchObject({ theme: "claw" });
  });

  it("keeps immutable owners isolated when a released GitHub login is reused", () => {
    const options = stateOptions();
    const accountA = syncTailscaleGitHubProfile(
      {
        accountId: 10,
        canonicalLogin: "old-login",
        login: "old-login",
        name: "Account A",
      },
      options,
    );
    setDisplayName(accountA.id, "Account A Custom", options);
    expect(setAvatar(accountA.id, new Uint8Array([1, 2, 3]), "image/png", options).ok).toBe(true);
    expect(
      setUserPreferences(
        accountA.id,
        { theme: "claw", [GIT_COAUTHOR_PREFERENCE_KEY]: true },
        options,
      ),
    ).toMatchObject({ ok: true });

    const renamedA = syncTailscaleGitHubProfile(
      {
        accountId: 10,
        canonicalLogin: "new-login",
        login: "new-login",
        name: "Provider Renamed A",
      },
      options,
    );
    const accountB = syncTailscaleGitHubProfile(
      {
        accountId: 20,
        canonicalLogin: "old-login",
        login: "old-login",
        name: "Account B",
      },
      options,
    );

    expect(renamedA.id).toBe(accountA.id);
    expect(accountB).toMatchObject({
      displayName: "Account B",
      githubIdentity: { login: "old-login" },
      hasAvatar: false,
    });
    expect(accountB.id).not.toBe(accountA.id);
    expect(getUserPreferences(accountB.id, undefined, options)).toEqual({});
    expect(ensureProfileForTailscaleIdentity({ login: "old-login@github" }, options).id).toBe(
      accountB.id,
    );

    expect(getUserProfileListItem(accountA.id, options)).toMatchObject({
      displayName: "Account A Custom",
      githubIdentity: { login: "new-login" },
      hasAvatar: true,
    });
    expect(getProfileAvatar(accountA.id, options)?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(getUserPreferences(accountA.id, undefined, options)).toEqual({
      theme: "claw",
      [GIT_COAUTHOR_PREFERENCE_KEY]: true,
    });
    expect(listProfiles(options)).toEqual([
      expect.objectContaining({ id: accountA.id, mergedInto: null }),
      expect.objectContaining({ id: accountB.id, mergedInto: null }),
    ]);
  });

  it("preserves an adopted name and later custom edits across repeated GitHub sync", () => {
    const options = stateOptions();
    const first = syncTailscaleGitHubProfile(
      { accountId: 10, canonicalLogin: "ada", login: "ada", githubName: "Ada Lovelace" },
      options,
    );
    const second = syncTailscaleGitHubProfile(
      { accountId: 10, canonicalLogin: "ada", login: "ada", githubName: "Changed GitHub Name" },
      options,
    );

    expect(second.id).toBe(first.id);
    expect(listProfiles(options)).toEqual([
      expect.objectContaining({ id: first.id, displayName: "Ada Lovelace", mergedInto: null }),
    ]);
    setDisplayName(first.id, "User Chosen", options);
    expect(
      syncTailscaleGitHubProfile(
        { accountId: 10, canonicalLogin: "ada", login: "ada", githubName: "Another GitHub Name" },
        options,
      ).displayName,
    ).toBe("User Chosen");
  });

  it.each([
    { saved: null, expected: "Ada Lovelace" },
    { saved: "Ada", expected: "Ada Lovelace" },
    { saved: "ada", expected: "ada" },
    { saved: " Ada ", expected: " Ada " },
    { saved: "Custom Ada", expected: "Custom Ada" },
    { saved: "", expected: "" },
    { saved: "old-login", expected: "old-login" },
  ])(
    "adopts GitHub names only for null or exact canonical login: $saved",
    ({ saved, expected }) => {
      const options = stateOptions();
      const profile = syncTailscaleGitHubProfile(
        { accountId: 10, canonicalLogin: "old-login", login: "old-login" },
        options,
      );
      setDisplayName(profile.id, saved, options);
      const updated = syncTailscaleGitHubProfile(
        {
          accountId: 10,
          canonicalLogin: " Ada ",
          login: "old-login",
          githubName: "  Ada Lovelace  ",
          name: "Provider Ada",
        },
        options,
      );
      expect(updated).toMatchObject({
        id: profile.id,
        displayName: expected,
        githubIdentity: { login: "Ada" },
      });
      closeOpenClawStateDatabaseForTest();
      expect(getUserProfileDisplay(profile.id, options).displayName).toBe(expected);
    },
  );

  it.each([undefined, "", " \t "])(
    "keeps null-only provider adoption without a GitHub name: %s",
    (githubName) => {
      const options = stateOptions();
      const profile = syncTailscaleGitHubProfile(
        { accountId: 10, canonicalLogin: "Ada", login: "ada" },
        options,
      );
      const params = {
        accountId: 10,
        canonicalLogin: "Ada",
        login: "ada",
        githubName,
        name: "Provider Ada",
      };
      expect(syncTailscaleGitHubProfile(params, options).displayName).toBe("Provider Ada");
      setDisplayName(profile.id, "Ada", options);
      expect(syncTailscaleGitHubProfile(params, options).displayName).toBe("Ada");
    },
  );

  it.each([null, "Ada", "Target Custom"])(
    "applies GitHub name adoption to the surviving merge head: %s",
    (saved) => {
      const options = stateOptions();
      const target = syncTailscaleGitHubProfile(
        { accountId: 10, canonicalLogin: "Ada", login: "ada" },
        options,
      );
      setDisplayName(target.id, saved, options);
      const source = ensureProfileForEmail("alias@example.com", options);
      setDisplayName(source.id, "Source Custom", options);
      const updated = syncGitHubIdentity(
        {
          identity: { accountId: 10, login: "Ada", name: "Ada Lovelace" },
          authenticationAlias: { kind: "email", email: "alias@example.com" },
        },
        options,
      );
      expect(updated).toMatchObject({
        id: target.id,
        displayName: saved === "Target Custom" ? saved : "Ada Lovelace",
      });
      expect(getUserProfileDisplay(source.id, options)).toMatchObject({
        id: target.id,
        displayName: updated.displayName,
      });
      expect(ensureProfileForEmail("alias@example.com", options).id).toBe(target.id);
    },
  );

  it("bounds GitHub display names to the existing profile limit", () => {
    const options = stateOptions();
    const profile = syncTailscaleGitHubProfile(
      {
        accountId: 10,
        canonicalLogin: "Ada",
        login: "ada",
        githubName: `  ${"x".repeat(300)}  `,
      },
      options,
    );
    expect(profile.displayName).toBe("x".repeat(256));
  });

  it("moves a reused Cloudflare email without exposing the prior verified owner", () => {
    const options = stateOptions();
    const accountA = syncEmailGitHubProfile(
      {
        accountId: 10,
        canonicalLogin: "account-a",
        email: "shared@example.test",
        name: "Account A",
      },
      options,
    );
    setDisplayName(accountA.id, "Account A Custom", options);
    expect(setUserPreferences(accountA.id, { theme: "claw" }, options)).toMatchObject({ ok: true });

    const accountB = syncEmailGitHubProfile(
      {
        accountId: 20,
        canonicalLogin: "account-b",
        email: "shared@example.test",
        name: "Account B",
      },
      options,
    );

    expect(accountB).toMatchObject({
      displayName: "Account B",
      emails: ["shared@example.test"],
      githubIdentity: { login: "account-b" },
    });
    expect(accountB.id).not.toBe(accountA.id);
    expect(ensureProfileForEmail("shared@example.test", options).id).toBe(accountB.id);
    expect(getUserProfileListItem(accountA.id, options)).toMatchObject({
      displayName: "Account A Custom",
      emails: [],
      githubIdentity: { login: "account-a" },
    });
    expect(getUserPreferences(accountA.id, undefined, options)).toEqual({ theme: "claw" });
    expect(getUserPreferences(accountB.id, undefined, options)).toEqual({});
  });

  it("keeps retired GitHub attribution rows inert during verified sync", () => {
    const options = stateOptions();
    const matching = ensureProfileForTailscaleIdentity({ login: "ada@github" }, options);
    const mismatched = ensureProfileForTailscaleIdentity({ login: "grace@github" }, options);
    const database = openOpenClawStateDatabase(options).db;
    const insertLegacy = database.prepare(
      "INSERT INTO user_profile_identities (provider, subject, profile_id, canonical_login, created_at) VALUES ('github-attribution', ?, ?, ?, 1)",
    );
    insertLegacy.run("10", matching.id, "ada");
    insertLegacy.run("99", mismatched.id, "wrong-account");

    expect(
      syncTailscaleGitHubProfile({ accountId: 10, canonicalLogin: "ada", login: "ada" }, options),
    ).toMatchObject({ githubIdentity: { login: "ada" } });
    syncTailscaleGitHubProfile({ accountId: 11, canonicalLogin: "grace", login: "grace" }, options);

    expect(getUserPreferences(matching.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({});
    expect(getUserPreferences(mismatched.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({});
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM user_profile_identities WHERE provider = ?")
        .get("github-attribution"),
    ).toEqual({ count: 2 });
  });

  it("does not carry co-author consent to a different immutable GitHub account", () => {
    const options = stateOptions();
    const profile = syncTailscaleGitHubProfile(
      { accountId: 10, canonicalLogin: "first-owner", login: "shared" },
      options,
    );
    expect(
      setUserPreferences(profile.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }, options),
    ).toMatchObject({ ok: true });

    const nextOwner = syncTailscaleGitHubProfile(
      { accountId: 11, canonicalLogin: "next-owner", login: "shared" },
      options,
    );

    expect(nextOwner.id).not.toBe(profile.id);
    expect(getUserPreferences(nextOwner.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({});
    expect(getUserPreferences(profile.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({
      [GIT_COAUTHOR_PREFERENCE_KEY]: true,
    });
  });

  it("keeps co-author consent with the verified account that survives an email merge", () => {
    const options = stateOptions();
    const discarded = ensureProfileForEmail("discarded@example.com", options);
    const established = ensureProfileForEmail("established@example.com", options);
    syncEmailGitHubProfile(
      { accountId: 10, canonicalLogin: "discarded", email: "discarded@example.com" },
      options,
    );
    syncEmailGitHubProfile(
      { accountId: 11, canonicalLogin: "established", email: "established@example.com" },
      options,
    );
    setUserPreferences(discarded.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }, options);

    const merged = linkEmail("discarded@example.com", established.id, options);

    expect(merged.githubIdentity).toMatchObject({ login: "established" });
    expect(getUserPreferences(established.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({});

    const carrying = ensureProfileForEmail("carrying@example.com", options);
    const unverified = ensureProfileForEmail("unverified@example.com", options);
    syncEmailGitHubProfile(
      { accountId: 12, canonicalLogin: "carrying", email: "carrying@example.com" },
      options,
    );
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

    const version = readUserProfileVersion();
    expect(ensureProfileForEmail("person@gmail.com", options).id).toBe(profile.id);
    expect(
      ensureProfileForTailscaleIdentity(
        { login: "Person@Gmail.COM", name: "Person Example" },
        options,
      ),
    ).toEqual(profile);
    expect(readUserProfileVersion()).toBe(version);
    expect(profile.displayName).toBe("Person Example");
    expect(listProfiles(options)).toEqual([
      expect.objectContaining({ id: profile.id, emails: ["person@gmail.com"] }),
    ]);
  });

  it.each([null, "", " \t "])(
    "adopts a Tailscale name only into an empty slot: %s",
    (emptyName) => {
      const options = stateOptions();
      const profile = ensureProfileForTailscaleIdentity(
        { login: "ada@github", name: "Ada Provider" },
        options,
      );

      setDisplayName(profile.id, emptyName, options);
      const version = readUserProfileVersion();
      expect(
        ensureProfileForTailscaleIdentity({ login: "ada@github", name: "Ada Adopted" }, options),
      ).toMatchObject({ displayName: "Ada Adopted" });
      expect(readUserProfileVersion()).toBe(version + 1);

      setDisplayName(profile.id, "User Chosen", options);
      expect(
        ensureProfileForTailscaleIdentity(
          { login: "ada@github", name: "Provider Changed" },
          options,
        ),
      ).toMatchObject({ displayName: "User Chosen" });
      expect(readUserProfileVersion()).toBe(version + 2);
    },
  );

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

    const initialProfile = ensureProfileForTailscaleIdentity(
      { login: `avatar-${mime.slice("image/".length)}@github`, name: "Avatar User" },
      options,
    );
    const version = readUserProfileVersion();
    const profile = await adoptTailscaleProfileAvatar(
      initialProfile.id,
      "https://avatars.example.test/profile",
      options,
      { fetchImpl: imageFetch(bytes, mime) },
    );

    expect(profile.avatarMime).toBe(mime);
    expect(readUserProfileVersion()).toBe(version + 1);
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
    const version = readUserProfileVersion();

    resolveFetch?.(
      new Response(Uint8Array.from(fixtureImage("ui/public/favicon-32.png")).buffer, {
        headers: { "content-type": "image/png" },
      }),
    );
    await pending;

    expect(readUserProfileVersion()).toBe(version);
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

  it.each([
    {
      name: "empty",
      bytes: [],
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
      name: "nonempty",
      bytes: [1, 2, 3],
      sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    },
  ])("stores an allowlisted avatar with $name content", ({ bytes, sha256 }) => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("ada@example.com", options);
    const version = readUserProfileVersion();

    expect(setAvatar(profile.id, new Uint8Array(bytes), "image/png", options)).toEqual({
      ok: true,
      value: expect.objectContaining({
        id: profile.id,
        avatarMime: "image/png",
        emails: ["ada@example.com"],
        hasAvatar: true,
      }),
    });
    expect(readUserProfileVersion()).toBe(version + 1);
    expect(getProfileAvatar(profile.id, options)).toEqual({
      bytes: new Uint8Array(bytes),
      mime: "image/png",
      sha256,
      updatedAt: expect.any(Number),
    });
    expect(listProfiles(options)).toEqual([
      expect.objectContaining({ id: profile.id, hasAvatar: true }),
    ]);
    expect(getUserProfileDisplay(profile.id, options)).toEqual({
      id: profile.id,
      displayName: profile.displayName,
      hasAvatar: true,
      avatarRevision: `${sha256}-png`,
    });
  });

  it.each([
    { change: "bytes", bytes: [2], mime: "image/png" },
    { change: "MIME", bytes: [1], mime: "image/webp" },
  ])("keeps distinct avatar ETags when $change changes within a millisecond", ({ bytes, mime }) => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("ada@example.com", options);
    vi.spyOn(Date, "now").mockReturnValue(100);

    expect(setAvatar(profile.id, new Uint8Array([1]), "image/png", options).ok).toBe(true);
    const first = getProfileAvatar(profile.id, options);
    const firstDisplay = getUserProfileDisplay(profile.id, options);
    expect(setAvatar(profile.id, new Uint8Array(bytes), mime, options).ok).toBe(true);
    const second = getProfileAvatar(profile.id, options);
    const secondDisplay = getUserProfileDisplay(profile.id, options);

    expect(first?.updatedAt).toBe(second?.updatedAt);
    expect(firstDisplay.avatarRevision).not.toBe(secondDisplay.avatarRevision);
    expect(formatUserProfileAvatarEtag(first?.sha256 ?? "", first?.mime ?? "image/png")).not.toBe(
      formatUserProfileAvatarEtag(second?.sha256 ?? "", second?.mime ?? "image/png"),
    );
  });
});
