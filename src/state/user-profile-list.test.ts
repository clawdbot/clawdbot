import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import { hasMultipleSessionSharingIdentities } from "./user-profile-list.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail, linkEmail } from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

describe("session sharing identity count", () => {
  it("counts durable people without the shared owner or merged profiles", () => {
    const options = {
      path: join(tempDirs.make("openclaw-user-profile-list-"), "openclaw.sqlite"),
    };
    ensureGatewayOwnerProfile("Local Owner", options);
    expect(hasMultipleSessionSharingIdentities(options)).toBe(false);

    const first = ensureProfileForEmail("first@example.test", options);
    expect(hasMultipleSessionSharingIdentities(options)).toBe(false);

    ensureProfileForEmail("second@example.test", options);
    expect(hasMultipleSessionSharingIdentities(options)).toBe(true);

    linkEmail("second@example.test", first.id, options);
    expect(hasMultipleSessionSharingIdentities(options)).toBe(false);
  });
});
