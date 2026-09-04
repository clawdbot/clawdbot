import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { repairMergedGatewayOwnerProfile } from "./user-profiles-owner-migration.js";
import { mergeOwnerIntoPerson, profileState } from "./user-profiles-owner.test-support.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForTailscaleIdentity,
  listProfiles,
  readUserProfileAliases,
  syncGitHubIdentity,
} from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-owner-migration-"), "openclaw.sqlite") };
}

describe("Doctor gateway owner repair", () => {
  it.each(["tombstone", "person", "missing"])(
    "reports then repairs a merged owner with its identity targeting %s once",
    (identityTarget) => {
      const options = stateOptions();
      const owner = ensureGatewayOwnerProfile("Local Owner", options);
      const person = mergeOwnerIntoPerson(owner.id, options);
      syncGitHubIdentity(
        {
          identity: { accountId: 10, login: "person" },
          authenticationAlias: { kind: "email", email: "person@example.test" },
        },
        options,
      );
      const db = openOpenClawStateDatabase(options).db;
      if (identityTarget === "person") {
        db.prepare(
          "UPDATE user_profile_identities SET profile_id = ? WHERE provider = 'gateway.local'",
        ).run(person.id);
      } else if (identityTarget === "missing") {
        db.prepare("DELETE FROM user_profile_identities WHERE provider = 'gateway.local'").run();
      }
      const personBefore = listProfiles(options).find((profile) => profile.id === person.id);
      const before = profileState(options);
      expect(readUserProfileAliases(owner.id, options)).toEqual(new Set([owner.id, person.id]));
      expect(readUserProfileAliases(person.id, options)).toEqual(new Set([owner.id, person.id]));

      expect(repairMergedGatewayOwnerProfile({ ...options, shouldRepair: false })).toMatchObject({
        repaired: false,
        changes: [],
        warnings: [expect.stringContaining("openclaw doctor --fix")],
      });
      expect(profileState(options)).toEqual(before);
      expect(repairMergedGatewayOwnerProfile({ ...options, shouldRepair: true })).toMatchObject({
        repaired: true,
        changes: [expect.stringContaining("gateway-owner")],
        warnings: [],
      });
      expect(readUserProfileAliases(owner.id, options)).toEqual(new Set([owner.id]));
      expect(readUserProfileAliases(person.id, options)).toEqual(new Set([person.id]));
      const restored = ensureGatewayOwnerProfile("Host Renamed", options);
      expect(restored).toMatchObject({
        id: owner.id,
        mergedInto: null,
        displayName: "Local Owner",
      });
      expect(restored.updatedAt).toBeGreaterThan(1);
      expect(listProfiles(options).find((profile) => profile.id === person.id)).toEqual(
        personBefore,
      );
      expect(
        db
          .prepare(
            "SELECT profile_id FROM user_profile_identities WHERE provider = 'gateway.local' AND subject = 'owner'",
          )
          .get(),
      ).toEqual({ profile_id: owner.id });
      const repairedState = profileState(options);
      expect(repairMergedGatewayOwnerProfile({ ...options, shouldRepair: true })).toEqual({
        repaired: false,
        changes: [],
        warnings: [],
      });
      closeOpenClawStateDatabaseForTest();
      expect(profileState(options)).toEqual(repairedState);
    },
  );

  it.each([false, true])(
    "preserves an unmerged legacy owner and replaces a merged one (merged: %s)",
    (merged) => {
      const options = stateOptions();
      const legacy = ensureProfileForTailscaleIdentity({ login: "legacy@other" }, options);
      if (merged) {
        mergeOwnerIntoPerson(legacy.id, options);
      }
      const db = openOpenClawStateDatabase(options).db;
      db.prepare(
        "INSERT INTO user_profile_identities (provider, subject, profile_id, created_at) VALUES ('gateway.local', 'owner', ?, 1)",
      ).run(legacy.id);
      const before = profileState(options);
      expect(repairMergedGatewayOwnerProfile({ ...options, shouldRepair: true }).repaired).toBe(
        merged,
      );
      if (!merged) {
        expect(profileState(options)).toEqual(before);
      } else {
        expect(
          db.prepare("SELECT merged_into FROM user_profiles WHERE id = ?").get(legacy.id),
        ).toEqual({
          merged_into: before.profiles.find((profile) => profile.id === legacy.id)?.merged_into,
        });
      }
      expect(ensureGatewayOwnerProfile("Local Owner", options).id).toBe(
        merged ? "gateway-owner" : legacy.id,
      );
    },
  );

  it.each([false, true])(
    "does not create profile state on an unused Gateway (fix: %s)",
    (shouldRepair) => {
      const options = stateOptions();
      expect(repairMergedGatewayOwnerProfile({ ...options, shouldRepair })).toEqual({
        repaired: false,
        changes: [],
        warnings: [],
      });
      expect(existsSync(options.path)).toBe(false);
    },
  );
});
