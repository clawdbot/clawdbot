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
  listProfiles,
  setDisplayName,
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

describe("gateway owner profiles", () => {
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
