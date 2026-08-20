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
import { loadPersistedAuthProfileStore } from "./persisted.js";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "./sqlite.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store.js";
import type { ApiKeyCredential } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
