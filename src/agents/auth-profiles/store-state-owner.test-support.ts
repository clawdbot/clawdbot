import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnv } from "../../test-utils/env.js";
import { clearAuthProfileMigrationDiagnostics } from "./legacy-source-diagnostic.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

export function createAuthOwnerTestFixtures() {
  const tempDirs = createTempDirTracker();
  const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
  const apiKey = (key: string): AuthProfileCredential => ({
    type: "api_key",
    provider: "openai",
    key,
  });
  const store = (key: string): AuthProfileStore => ({
    version: 1,
    profiles: { shared: apiKey(key) },
  });

  function snapshotAt(databasePath: string) {
    return getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(databasePath)?.store;
  }

  afterEach(() => {
    clearSecretsRuntimeSnapshotState();
    clearRuntimeAuthProfileStoreSnapshots();
    clearAuthProfileMigrationDiagnostics();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    tempDirs.cleanup();
  });

  function unreadableOuter(kind: "future" | "invalid") {
    const stateDir = tempDirs.make("openclaw-auth-owner-outer-");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    if (kind === "future") {
      const database = new DatabaseSync(databasePath);
      database.exec("PRAGMA user_version = 999");
      database.close();
    } else {
      fs.writeFileSync(databasePath, "invalid SQLite fixture");
    }
    const original = fs.readFileSync(databasePath);
    const relocated = path.join(stateDir, "unrelated-relocated-agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", relocated);
    return () => {
      expect(fs.readFileSync(databasePath)).toEqual(original);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
      expect(process.env.OPENCLAW_AGENT_DIR).toBe(relocated);
      expect(fs.existsSync(relocated)).toBe(false);
    };
  }

  async function seedRoot(key: string) {
    const stateDir = tempDirs.make("openclaw-auth-owner-root-");
    // Deliberately outside the state root: directory ancestry cannot identify inheritance.
    const agentDir = tempDirs.make("openclaw-auth-owner-custom-agent-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
    await persistAuthProfileBatch({
      stateDir,
      profiles: [{ profileId: "shared", credential: apiKey(key) }],
    });
    await persistAuthProfileBatch({
      stateDir,
      agentDir,
      profiles: [{ profileId: "local", credential: apiKey(`${key}-local`) }],
    });
    const sharedPath = resolveSharedAuthStorePath(env);
    const agentPath = resolveAuthProfileDatabasePath(agentDir);
    withEnv(env, () => {
      setRuntimeAuthProfileStoreSnapshot(loadAuthProfileStoreWithoutExternalProfiles());
      setRuntimeAuthProfileStoreSnapshot(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir),
        agentDir,
      );
    });
    return { stateDir, agentDir, sharedPath, agentPath, env };
  }
  return { tempDirs, saveOptions, apiKey, store, snapshotAt, unreadableOuter, seedRoot };
}
