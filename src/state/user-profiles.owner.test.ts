import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
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

function profileState(options: ReturnType<typeof stateOptions>) {
  return {
    profiles: listProfiles(options),
    identities: openOpenClawStateDatabase(options)
      .db.prepare(
        "SELECT provider, subject, profile_id, canonical_login FROM user_profile_identities ORDER BY provider, subject",
      )
      .all(),
  };
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
  it.each(["new email", "existing email", "tombstoned target"])(
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
  ])("rejects role $role on the $target without changing state", ({ target, role }) => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile("Local Owner", options);
    const profileId = target === "tombstone" ? seedOwnerTombstone(owner.id, options) : owner.id;
    const before = profileState(options);

    expect(() => setUserProfileRole(profileId, role, options)).toThrow(
      "the shared owner profile is not governed by operator roles",
    );
    expect(profileState(options)).toEqual(before);
  });

  it.each([false, true])(
    "rejects GitHub sync through an old owner email (existing account: %s)",
    (existingAccount) => {
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

  it("rejects merging a personal login into an old owner GitHub identity", () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile("Local Owner", options);
    ensureProfileForEmail("person@example.test", options);
    openOpenClawStateDatabase(options)
      .db.prepare(
        "INSERT INTO user_profile_identities (provider, subject, profile_id, canonical_login, created_at) VALUES ('github', '10', ?, 'person', 1)",
      )
      .run(owner.id);
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
  });

  it("keeps one email-less gateway owner and its edits across database reopen", () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile("  Ada Lovelace  ", options);
    expect(owner.id).toBe("gateway-owner");
    expect(owner.displayName).toBe("Ada Lovelace");
    expect(ensureGatewayOwnerProfile("Host Renamed", options)).toEqual(owner);
    setDisplayName(owner.id, "User Chosen", options);
    closeOpenClawStateDatabaseForTest();

    expect(ensureGatewayOwnerProfile("Host Renamed", options)).toMatchObject({
      id: owner.id,
      displayName: "User Chosen",
    });
    expect(listProfiles(options)).toEqual([
      expect.objectContaining({ id: owner.id, emails: [], displayName: "User Chosen" }),
    ]);
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare("SELECT provider, subject, profile_id FROM user_profile_identities")
        .all(),
    ).toEqual([{ provider: "gateway.local", subject: "owner", profile_id: owner.id }]);
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

    expect(ensureGatewayOwnerProfile("  Ada Lovelace  ", options)).toMatchObject({
      id: owner.id,
      displayName: "Ada Lovelace",
    });
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
