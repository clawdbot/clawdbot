import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  assertAuthProfileMigrationReady,
  clearAuthProfileMigrationDiagnostics,
  listAuthProfileStoresRequiringMigration,
} from "./legacy-source-diagnostic.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";

afterEach(() => {
  clearAuthProfileMigrationDiagnostics();
});

describe("listAuthProfileStoresRequiringMigration", () => {
  it("reports only credential sources without marking runtime migration state", async () => {
    await withTempDir({ prefix: "openclaw-auth-migration-diagnostic-" }, async (root) => {
      const credentialAgentDir = path.join(root, "credential-agent");
      const authStateAgentDir = path.join(root, "auth-state-agent");
      const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
      await fs.mkdir(credentialAgentDir, { recursive: true });
      await fs.mkdir(authStateAgentDir, { recursive: true });
      const credentialPath = path.join(credentialAgentDir, "auth-profiles.json");
      await fs.writeFile(credentialPath, "{}\n");
      await fs.writeFile(path.join(authStateAgentDir, "auth-state.json"), "{}\n");

      expect(
        listAuthProfileStoresRequiringMigration({
          agentDirs: [authStateAgentDir, credentialAgentDir, credentialAgentDir],
          env,
        }),
      ).toEqual([resolveAuthProfileDatabasePath(credentialAgentDir)]);

      await fs.rm(credentialPath);
      expect(() => assertAuthProfileMigrationReady(credentialAgentDir)).not.toThrow();
    });
  });
});
