import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { readUserProfileVersion } from "./user-profile-events.js";
import { mergeOwnerIntoPerson, profileState } from "./user-profiles-owner.test-support.js";
import { UserProfileOwnerError } from "./user-profiles-schema.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  linkEmail,
  listProfiles,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function stateOptions() {
  const directory = tempDirs.make("openclaw-user-profiles-owner-");
  return { path: join(directory, "openclaw.sqlite") };
}

function seedOwnerTombstone(ownerId: string, options: ReturnType<typeof stateOptions>) {
  openOpenClawStateDatabase(options)
    .db.prepare(
      "INSERT INTO user_profiles (id, merged_into, created_at, updated_at) VALUES (?, ?, 1, 1)",
    )
    .run("retired-owner-alias", ownerId);
  return "retired-owner-alias";
}

describe("gateway owner profiles", () => {
  it.each(["new email", "existing email", "tombstoned target", "merged owner"])(
    "rejects linking a %s to the owner without changing profile state",
    (scenario) => {
      const options = stateOptions();
      const owner = ensureGatewayOwnerProfile("Local Owner", options);
      const email = "person@example.test";
      if (scenario !== "new email") {
        ensureProfileForEmail(email, options);
      }
      const target =
        scenario === "tombstoned target" ? seedOwnerTombstone(owner.id, options) : owner.id;
      if (scenario === "merged owner") {
        mergeOwnerIntoPerson(owner.id, options);
      }
      const before = profileState(options);

      expect(() => linkEmail(email, target, options)).toThrow(
        "the shared owner profile cannot be merged; sign in with a personal identity instead",
      );
      expect(profileState(options)).toEqual(before);
    },
  );

  it.each([1, 2])("rejects moving an owner's email when it has %s aliases", (aliasCount) => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile("Local Owner", options);
    const person = ensureProfileForEmail("person@example.test", options);
    const insertAlias = openOpenClawStateDatabase(options).db.prepare(
      "INSERT INTO user_profile_emails (email, profile_id, created_at) VALUES (?, ?, 1)",
    );
    for (let index = 0; index < aliasCount; index++) {
      insertAlias.run(`old-owner-${index}@example.test`, owner.id);
    }
    const before = profileState(options);

    expect(() => linkEmail("old-owner-0@example.test", person.id, options)).toThrow(
      "the shared owner profile cannot be merged; sign in with a personal identity instead",
    );
    expect(profileState(options)).toEqual(before);
  });

  it.each([
    { target: "owner", role: "guest" },
    { target: "owner", role: null },
    { target: "tombstone", role: "guest" },
    { target: "tombstone", role: null },
    { target: "merged owner", role: "guest" },
    { target: "merged owner", role: null },
  ])("rejects role $role on the $target without changing state", ({ target, role }) => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile("Local Owner", options);
    const profileId = target === "tombstone" ? seedOwnerTombstone(owner.id, options) : owner.id;
    if (target === "merged owner") {
      mergeOwnerIntoPerson(owner.id, options);
    }
    const before = profileState(options);

    expect(() => setUserProfileRole(profileId, role, options)).toThrow(
      "the shared owner profile is not governed by operator roles",
    );
    expect(profileState(options)).toEqual(before);
  });

  it.each([
    { existingAccount: false, merged: false },
    { existingAccount: true, merged: false },
    { existingAccount: false, merged: true },
    { existingAccount: true, merged: true },
  ])(
    "rejects GitHub sync through an old owner email (existing: $existingAccount, merged: $merged)",
    ({ existingAccount, merged }) => {
      const options = stateOptions();
      const owner = ensureGatewayOwnerProfile("Local Owner", options);
      const identity = { accountId: 10, login: "person" };
      if (existingAccount) {
        syncGitHubIdentity(
          { identity, authenticationAlias: { kind: "github-login", login: identity.login } },
          options,
        );
      }
      openOpenClawStateDatabase(options)
        .db.prepare(
          "INSERT INTO user_profile_emails (email, profile_id, created_at) VALUES (?, ?, 1)",
        )
        .run("old-owner@example.test", owner.id);
      if (merged) {
        mergeOwnerIntoPerson(owner.id, options);
      }
      const before = profileState(options);

      expect(() =>
        syncGitHubIdentity(
          {
            identity,
            authenticationAlias: { kind: "email", email: "old-owner@example.test" },
          },
          options,
        ),
      ).toThrow(
        "the shared owner profile cannot be merged; sign in with a personal identity instead",
      );
      expect(profileState(options)).toEqual(before);
    },
  );

  it.each([false, true])(
    "rejects a personal login into an old owner GitHub identity (merged: %s)",
    (merged) => {
      const options = stateOptions();
      const owner = ensureGatewayOwnerProfile("Local Owner", options);
      ensureProfileForEmail("person@example.test", options);
      openOpenClawStateDatabase(options)
        .db.prepare(
          "INSERT INTO user_profile_identities (provider, subject, profile_id, canonical_login, created_at) VALUES ('github', '10', ?, 'person', 1)",
        )
        .run(owner.id);
      if (merged) {
        mergeOwnerIntoPerson(owner.id, options);
      }
      const before = profileState(options);

      expect(() =>
        syncGitHubIdentity(
          {
            identity: { accountId: 10, login: "person" },
            authenticationAlias: { kind: "email", email: "person@example.test" },
          },
          options,
        ),
      ).toThrow(
        "the shared owner profile cannot be merged; sign in with a personal identity instead",
      );
      expect(profileState(options)).toEqual(before);
    },
  );

  it.each(["tombstone", "person", "missing", "legacy", "merged identity", "misdirected"])(
    "requires Doctor without mutating a merged owner whose identity targets %s",
    (identityTarget) => {
      const options = stateOptions();
      const owner =
        identityTarget === "legacy"
          ? ensureProfileForTailscaleIdentity({ login: "legacy@other" }, options)
          : ensureGatewayOwnerProfile("Local Owner", options);
      const identityOnly = identityTarget === "merged identity" || identityTarget === "misdirected";
      const legacy = identityOnly
        ? ensureProfileForTailscaleIdentity({ login: "legacy@other" }, options)
        : undefined;
      const person =
        identityTarget === "misdirected"
          ? ensureProfileForEmail("person@example.test", options)
          : mergeOwnerIntoPerson(legacy?.id ?? owner.id, options);
      const db = openOpenClawStateDatabase(options).db;
      if (identityTarget === "legacy") {
        db.prepare(
          "INSERT INTO user_profile_identities (provider, subject, profile_id, created_at) VALUES ('gateway.local', 'owner', ?, 1)",
        ).run(owner.id);
      } else if (identityOnly) {
        db.prepare(
          "UPDATE user_profile_identities SET profile_id = ? WHERE provider = 'gateway.local'",
        ).run(legacy!.id);
      } else if (identityTarget === "person") {
        db.prepare(
          "UPDATE user_profile_identities SET profile_id = ? WHERE provider = 'gateway.local'",
        ).run(person.id);
      } else if (identityTarget === "missing") {
        db.prepare("DELETE FROM user_profile_identities WHERE provider = 'gateway.local'").run();
      }
      const before = profileState(options);

      expect(() => ensureGatewayOwnerProfile("Host Renamed", options)).toThrow(
        UserProfileOwnerError,
      );
      expect(() => ensureGatewayOwnerProfile("Host Renamed", options)).toThrow(
        expect.objectContaining({
          code: "repair-required",
          message: expect.stringContaining("openclaw doctor --fix"),
        }),
      );
      expect(profileState(options)).toEqual(before);
    },
  );

  it("keeps one email-less gateway owner and its edits across database reopen", () => {
    const options = stateOptions();
    const version = readUserProfileVersion();
    const owner = ensureGatewayOwnerProfile("  Ada Lovelace  ", options);
    expect(readUserProfileVersion()).toBe(version + 1);
    expect(owner.id).toBe("gateway-owner");
    expect(owner.displayName).toBe("Ada Lovelace");
    expect(ensureGatewayOwnerProfile("Host Renamed", options)).toEqual(owner);
    expect(readUserProfileVersion()).toBe(version + 1);
    setDisplayName(owner.id, "User Chosen", options);
    closeOpenClawStateDatabaseForTest();

    expect(ensureGatewayOwnerProfile("Host Renamed", options)).toMatchObject({
      id: owner.id,
      displayName: "User Chosen",
    });
    expect(listProfiles(options)).toEqual([
      expect.objectContaining({ id: owner.id, emails: [], displayName: "User Chosen" }),
    ]);
    expect(readUserProfileVersion()).toBe(version + 2);
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare("SELECT provider, subject, profile_id FROM user_profile_identities")
        .all(),
    ).toEqual([{ provider: "gateway.local", subject: "owner", profile_id: owner.id }]);
    openOpenClawStateDatabase(options)
      .db.prepare("DELETE FROM user_profile_identities WHERE provider = 'gateway.local'")
      .run();
    expect(ensureGatewayOwnerProfile(null, options).id).toBe(owner.id);
    expect(readUserProfileVersion()).toBe(version + 3);
  });

  it("publishes a new owner only after the outer transaction commits", () => {
    const options = stateOptions();
    ensureProfileForEmail("person@example.test", options);
    const version = readUserProfileVersion();
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        ensureGatewayOwnerProfile("Local Owner", options);
        expect(readUserProfileVersion()).toBe(version);
        throw new Error("rollback owner");
      }, options),
    ).toThrow("rollback owner");
    expect(readUserProfileVersion()).toBe(version);
    expect(listProfiles(options).some((profile) => profile.id === "gateway-owner")).toBe(false);

    runOpenClawStateWriteTransaction(() => {
      ensureGatewayOwnerProfile("Local Owner", options);
      expect(readUserProfileVersion()).toBe(version);
    }, options);
    expect(readUserProfileVersion()).toBe(version + 1);
  });

  it("reuses the existing provider identity without creating another owner", () => {
    const options = stateOptions();
    const existing = ensureProfileForEmail("existing-owner@example.test", options);
    openOpenClawStateDatabase(options)
      .db.prepare(
        "INSERT INTO user_profile_identities (provider, subject, profile_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("gateway.local", "owner", existing.id, existing.createdAt);

    expect(ensureGatewayOwnerProfile("Host Name", options)).toEqual(existing);
    expect(listProfiles(options)).toHaveLength(1);
  });

  it.each(["owner@gateway", "owner@gateway.local"])(
    "keeps the gateway owner separate from a Tailscale login: %s",
    (login) => {
      const options = stateOptions();
      const owner = ensureGatewayOwnerProfile("Local Owner", options);
      const external = ensureProfileForTailscaleIdentity({ login, name: "External User" }, options);

      expect(external.id).not.toBe(owner.id);
      expect(ensureGatewayOwnerProfile(null, options)).toEqual(owner);
    },
  );

  it.each([null, "", " \t "])("seeds an unset gateway owner name: %s", (emptyName) => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile(null, options);
    setDisplayName(owner.id, emptyName, options);
    const version = readUserProfileVersion();

    expect(ensureGatewayOwnerProfile("  Ada Lovelace  ", options)).toMatchObject({
      id: owner.id,
      displayName: "Ada Lovelace",
    });
    expect(readUserProfileVersion()).toBe(version + 1);
  });

  it("leaves an unavailable owner name unset and bounds a later seed", () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile(null, options);
    expect(owner.displayName).toBeNull();
    expect(ensureGatewayOwnerProfile(" \t ", options)).toEqual(owner);
    expect(ensureGatewayOwnerProfile("a".repeat(300), options)).toMatchObject({
      id: owner.id,
      displayName: "a".repeat(256),
    });
  });
});
