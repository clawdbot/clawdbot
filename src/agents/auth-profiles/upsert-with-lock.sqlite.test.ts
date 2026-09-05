import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { clearAuthProfileMigrationDiagnostics } from "./legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "./sqlite.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store.js";
import type { ApiKeyCredential } from "./types.js";
import {
  persistAuthProfileBatch,
  upsertAuthProfileAfterLoginWithLockOrThrow,
  upsertAuthProfileWithLockOrThrow,
} from "./upsert-with-lock.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearAuthProfileMigrationDiagnostics();
});

function apiKey(key: string): ApiKeyCredential {
  return { type: "api_key", provider: "openai", key };
}

function profile(profileId: string, key: string) {
  return { profileId, credential: apiKey(key) };
}

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const root = tempDirs.make("openclaw-auth-batch-");
  const agentDir = path.join(root, "agents", "work", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => await run(agentDir));
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  }
}

describe("auth profile batch persistence", () => {
  it("conditionally rolls a portable profile batch and its order back to absence", async () => {
    await withAgentDir(async (agentDir) => {
      const noOp = await persistAuthProfileBatch({ agentDir, profiles: [] });
      noOp.rollback();
      expect(fs.existsSync(resolveAuthProfileDatabasePath(agentDir))).toBe(false);

      const receipt = await persistAuthProfileBatch({
        agentDir,
        profiles: [
          profile("openai:primary", " sk-primary "),
          {
            profileId: "openai:backup",
            credential: { type: "token", provider: "openai", token: " backup-token " },
          },
        ],
        order: { openai: ["openai:primary", "openai:backup"] },
      });

      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
        profiles: {
          "openai:primary": { key: "sk-primary" },
          "openai:backup": { token: "backup-token" },
        },
        order: { openai: ["openai:primary", "openai:backup"] },
      });

      receipt.rollback();
      receipt.rollback();

      expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
      expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("missing");
      expect(inspectPersistedAuthProfileStateRaw(agentDir).status).toBe("missing");
    });
  });

  it("removes only owned profiles and introduced order ids", async () => {
    await withAgentDir(async (agentDir) => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:existing": apiKey("sk-existing"),
          },
          order: { openai: ["openai:existing"] },
        },
        agentDir,
      );
      const receipt = await persistAuthProfileBatch({
        agentDir,
        profiles: [profile("openai:primary", "sk-attempt"), profile("openai:backup", "sk-backup")],
        order: { openai: ["openai:primary", "openai:backup"] },
      });
      await updateAuthProfileStoreWithLock({
        agentDir,
        saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
        updater: (store) => {
          store.profiles["openai:primary"] = apiKey("sk-newer");
          store.profiles["openai:concurrent"] = apiKey("sk-unrelated");
          store.order = {
            openai: ["openai:primary", "openai:backup", "openai:concurrent", "openai:existing"],
          };
          return true;
        },
      });

      receipt.rollback();

      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
        profiles: {
          "openai:primary": { key: "sk-newer" },
          "openai:existing": { key: "sk-existing" },
          "openai:concurrent": { key: "sk-unrelated" },
        },
        order: {
          openai: ["openai:primary", "openai:concurrent", "openai:existing"],
        },
      });
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:backup"]).toBeUndefined();
    });
  });

  it("does not claim skipped non-replacing profiles or their order entries", async () => {
    await withAgentDir(async (agentDir) => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:existing": apiKey("sk-existing"),
            "openai:conflict": apiKey("sk-concurrent"),
          },
          order: { openai: ["openai:existing"] },
        },
        agentDir,
      );
      const receipt = await persistAuthProfileBatch({
        agentDir,
        profiles: [
          { ...profile("openai:conflict", "sk-portable"), replaceExisting: false },
          { ...profile("openai:portable", "sk-portable"), replaceExisting: false },
        ],
        order: { openai: ["openai:conflict", "openai:portable"] },
      });

      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
        profiles: {
          "openai:conflict": { key: "sk-concurrent" },
          "openai:portable": { key: "sk-portable" },
        },
        order: { openai: ["openai:existing", "openai:portable"] },
      });

      receipt.rollback();

      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
        profiles: {
          "openai:existing": { key: "sk-existing" },
          "openai:conflict": { key: "sk-concurrent" },
        },
        order: { openai: ["openai:existing"] },
      });
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:portable"]).toBeUndefined();
    });
  });

  it("replaces one completed login and resets only its existing failure state", async () => {
    await withAgentDir(async (agentDir) => {
      const targetId = "openai:target";
      const siblingId = "openai:sibling";
      const targetLastUsed = Date.now() - 10_000;
      const targetLastFailureAt = Date.now() - 5_000;
      const targetLastProbeAt = Date.now() - 2_000;
      const siblingBlockedUntil = Date.now() + 120_000;
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [targetId]: apiKey("sk-stale"),
            [siblingId]: apiKey("sk-sibling"),
          },
          order: { openai: [siblingId, targetId] },
          lastGood: { openai: siblingId },
          usageStats: {
            [targetId]: {
              errorCount: 4,
              failureCounts: { auth_permanent: 4 },
              blockedUntil: Date.now() + 60_000,
              blockedReason: "subscription_limit",
              blockedSource: "wham",
              blockedModel: "gpt-5.6",
              blockedScope: "model",
              cooldownUntil: Date.now() + 60_000,
              cooldownReason: "auth_permanent",
              cooldownModel: "gpt-5.6",
              disabledUntil: Date.now() + 60_000,
              disabledReason: "auth_permanent",
              lastUsed: targetLastUsed,
              lastFailureAt: targetLastFailureAt,
              lastProbeAt: targetLastProbeAt,
            },
            [siblingId]: {
              errorCount: 2,
              blockedUntil: siblingBlockedUntil,
              blockedReason: "subscription_limit",
            },
          },
        },
        agentDir,
      );

      await upsertAuthProfileAfterLoginWithLockOrThrow({
        agentDir,
        profileId: targetId,
        credential: apiKey("sk-fresh"),
      });

      expect(loadPersistedAuthProfileStore(agentDir)).toEqual({
        version: 1,
        profiles: {
          [targetId]: apiKey("sk-fresh"),
          [siblingId]: apiKey("sk-sibling"),
        },
        order: { openai: [siblingId, targetId] },
        lastGood: { openai: siblingId },
        usageStats: {
          [targetId]: {
            errorCount: 0,
            lastUsed: targetLastUsed,
            lastFailureAt: targetLastFailureAt,
            lastProbeAt: targetLastProbeAt,
          },
          [siblingId]: {
            errorCount: 2,
            blockedUntil: siblingBlockedUntil,
            blockedReason: "subscription_limit",
          },
        },
      });
    });
  });

  it("rolls the completed-login credential and state back together on write failure", async () => {
    await withAgentDir(async (agentDir) => {
      const profileId = "openai:existing";
      const disabledUntil = Date.now() + 60_000;
      saveAuthProfileStore(
        {
          version: 1,
          profiles: { [profileId]: apiKey("sk-stale") },
          usageStats: {
            [profileId]: {
              errorCount: 3,
              disabledUntil,
              disabledReason: "auth_permanent",
            },
          },
        },
        agentDir,
      );
      const database = openOpenClawAgentDatabase({
        agentId: "work",
        path: resolveAuthProfileDatabasePath(agentDir),
      });
      database.db.exec(`
        CREATE TRIGGER reject_completed_login_state
        BEFORE UPDATE ON auth_profile_state
        BEGIN
          SELECT RAISE(ABORT, 'injected completed login state failure');
        END;
      `);

      await expect(
        upsertAuthProfileAfterLoginWithLockOrThrow({
          agentDir,
          profileId,
          credential: apiKey("sk-fresh"),
        }),
      ).rejects.toThrow("injected completed login state failure");

      expect(loadPersistedAuthProfileStore(agentDir)).toEqual({
        version: 1,
        profiles: { [profileId]: apiKey("sk-stale") },
        usageStats: {
          [profileId]: {
            errorCount: 3,
            disabledUntil,
            disabledReason: "auth_permanent",
          },
        },
      });
    });
  });

  it("reports the migration remediation instead of lock-contention retry advice", async () => {
    await withAgentDir(async (agentDir) => {
      // Credentials still living in the retired JSON store: the write can never
      // succeed, so retry advice would loop the operator forever.
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: { "openai:legacy": apiKey("sk-json-era") },
        }),
      );

      const failure = await upsertAuthProfileWithLockOrThrow({
        agentDir,
        profileId: "openai:new",
        credential: apiKey("sk-new"),
      }).catch((error: unknown) => error);

      expect(String(failure)).toContain("requires legacy credential migration");
      expect(String(failure)).toContain("openclaw doctor --fix");
      expect(String(failure)).not.toContain("lock may be busy");
    });
  });

  it("reports a schema write failure instead of lock-contention retry advice", async () => {
    await withAgentDir(async (agentDir) => {
      await upsertAuthProfileWithLockOrThrow({
        agentDir,
        profileId: "openai:existing",
        credential: apiKey("sk-existing"),
      });
      openOpenClawAgentDatabase({
        agentId: "work",
        path: resolveAuthProfileDatabasePath(agentDir),
      }).db.exec("ALTER TABLE auth_profile_store DROP COLUMN updated_at");

      const failure = await upsertAuthProfileWithLockOrThrow({
        agentDir,
        profileId: "openai:new",
        credential: apiKey("sk-new"),
      }).catch((error: unknown) => error);

      expect(String(failure)).toContain("no column named updated_at");
      expect(String(failure)).not.toContain("lock may be busy");
    });
  });

  it("leaves no partial profile batch when the SQLite state write fails", async () => {
    await withAgentDir(async (agentDir) => {
      const database = openOpenClawAgentDatabase({
        agentId: "work",
        path: resolveAuthProfileDatabasePath(agentDir),
      });
      database.db.exec(`
        CREATE TRIGGER reject_auth_profile_batch_state
        BEFORE INSERT ON auth_profile_state
        BEGIN
          SELECT RAISE(ABORT, 'injected auth batch state failure');
        END;
      `);

      await expect(
        persistAuthProfileBatch({
          agentDir,
          profiles: [profile("openai:first", "sk-first"), profile("openai:second", "sk-second")],
          order: { openai: ["openai:first", "openai:second"] },
        }),
      ).rejects.toThrow("injected auth batch state failure");

      expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
    });
  });
});
