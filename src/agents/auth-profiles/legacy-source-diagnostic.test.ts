import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  assertAuthProfileMigrationReady,
  clearAuthProfileMigrationDiagnostics,
} from "./legacy-source-diagnostic.js";
import { writePersistedAuthProfileStoreRaw } from "./sqlite.js";

afterEach(() => {
  clearAuthProfileMigrationDiagnostics();
});

describe("assertAuthProfileMigrationReady", () => {
  it("reports only credential sources without marking runtime migration state", async () => {
    await withTestDir({ prefix: "openclaw-auth-migration-diagnostic-" }, async (root) => {
      const credentialAgentDir = path.join(root, "credential-agent");
      const authStateAgentDir = path.join(root, "auth-state-agent");
      await fs.mkdir(credentialAgentDir, { recursive: true });
      await fs.mkdir(authStateAgentDir, { recursive: true });
      const credentialPath = path.join(credentialAgentDir, "auth-profiles.json");
      await fs.writeFile(credentialPath, "{}\n");
      await fs.writeFile(path.join(authStateAgentDir, "auth-state.json"), "{}\n");

      // An auth-state file carries no credentials, so it never blocks its owner.
      expect(() => assertAuthProfileMigrationReady(authStateAgentDir)).not.toThrow();
      expect(() => assertAuthProfileMigrationReady(credentialAgentDir)).toThrow(
        "requires legacy credential migration",
      );
      clearAuthProfileMigrationDiagnostics();

      await fs.rm(credentialPath);
      expect(() => assertAuthProfileMigrationReady(credentialAgentDir)).not.toThrow();
    });
  });

  it("clears the requirement once the canonical store holds credentials", async () => {
    await withTestDir({ prefix: "openclaw-auth-migration-migrated-" }, async (root) => {
      const agentDir = path.join(root, "migrated-agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, "auth.json"), '{"openai":{"key":"not-a-real"}}\n');

      // Unmigrated: the credentials exist only in the retired file.
      expect(() => assertAuthProfileMigrationReady(agentDir)).toThrow(
        "requires legacy credential migration",
      );
      clearAuthProfileMigrationDiagnostics();

      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", key: "not-a-real" },
          },
        },
        agentDir,
      );

      // Migrated: the same leftover file must not strand a working store.
      expect(() => assertAuthProfileMigrationReady(agentDir)).not.toThrow();
    });
  });
});
