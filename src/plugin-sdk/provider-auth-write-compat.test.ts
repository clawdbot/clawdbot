import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { upsertAuthProfileWithLock as upsertApiKeyProfileWithLock } from "./provider-auth-api-key.js";
import {
  removeProviderAuthProfilesWithLock,
  updateAuthProfileStoreWithLock,
} from "./provider-auth.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("provider auth write compatibility", () => {
  it("preserves nullable failures on both shipped Plugin SDK subpaths", async () => {
    const root = tempDirs.make("openclaw-provider-auth-sdk-");
    const agentDir = path.join(root, "agents", "work", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:existing": { type: "api_key", provider: "openai", key: "sk-existing" },
        },
      },
      agentDir,
    );
    openOpenClawAgentDatabase({
      agentId: "work",
      path: resolveAuthProfileDatabasePath(agentDir),
    }).db.exec("ALTER TABLE auth_profile_store DROP COLUMN updated_at");

    await expect(
      updateAuthProfileStoreWithLock({
        agentDir,
        updater: (store) => {
          store.profiles["openai:existing"] = {
            type: "api_key",
            provider: "openai",
            key: "sk-updated",
          };
          return true;
        },
      }),
    ).resolves.toBeNull();
    await expect(
      removeProviderAuthProfilesWithLock({
        agentDir,
        provider: "openai",
      }),
    ).resolves.toBeNull();
    await expect(
      upsertApiKeyProfileWithLock({
        agentDir,
        profileId: "openai:new",
        credential: { type: "api_key", provider: "openai", key: "sk-new" },
      }),
    ).resolves.toBeNull();
  });
});
