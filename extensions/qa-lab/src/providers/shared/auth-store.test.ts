// Qa Lab tests cover the SQLite-backed auth store plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirHarness } from "../../temp-dir.test-helper.js";
import { readQaAuthProfiles, writeQaAuthProfiles } from "./auth-store.js";

const tempDirs = createTempDirHarness();

async function createQaAuthState(prefix = "openclaw-qa-auth-store-") {
  const stateDir = await tempDirs.makeTempDir(prefix);
  const agentId = "main";
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return {
    agentDir: path.join(stateDir, "agents", agentId, "agent"),
    agentId,
    stateDir,
  };
}

describe("QA auth profile store", () => {
  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await tempDirs.cleanup();
  });

  it("keeps inherited host shared state unchanged while staging isolated profiles", async () => {
    const hostStateDir = await tempDirs.makeTempDir("openclaw-qa-auth-host-state-");
    const qaStateDir = await tempDirs.makeTempDir("openclaw-qa-auth-isolated-state-");
    const hostDatabase = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: hostStateDir },
    });
    const hostDatabasePath = hostDatabase.path;
    closeOpenClawStateDatabaseForTest();
    const legacyHostDatabase = new DatabaseSync(hostDatabasePath);
    legacyHostDatabase.exec(`
      PRAGMA user_version = 6;
      UPDATE schema_meta SET schema_version = 6 WHERE meta_key = 'primary';
    `);
    legacyHostDatabase.close();
    vi.stubEnv("OPENCLAW_STATE_DIR", hostStateDir);

    await writeQaAuthProfiles({
      agentId: "main",
      profiles: {
        "qa-mock-openai": {
          type: "api_key",
          provider: "openai",
          key: "qa-mock-not-a-real-key",
        },
      },
      stateDir: qaStateDir,
    });

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const preservedHostDatabase = new DatabaseSync(hostDatabasePath, { readOnly: true });
    expect(preservedHostDatabase.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 6,
    });
    expect(
      preservedHostDatabase
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: 6 });
    preservedHostDatabase.close();
    vi.stubEnv("OPENCLAW_STATE_DIR", qaStateDir);
    const qaAgentDir = path.join(qaStateDir, "agents", "main", "agent");
    expect(readQaAuthProfiles(qaAgentDir).profiles).toMatchObject({
      "qa-mock-openai": { provider: "openai" },
    });
  });

  it("writes new auth profiles to SQLite without creating legacy JSON", async () => {
    const { agentDir, agentId, stateDir } = await createQaAuthState();

    await writeQaAuthProfiles({
      agentId,
      profiles: {
        "qa-mock-openai": {
          type: "api_key",
          provider: "openai",
          key: "qa-mock-not-a-real-key",
        },
      },
      stateDir,
    });

    expect(readQaAuthProfiles(agentDir).profiles["qa-mock-openai"]).toMatchObject({
      provider: "openai",
    });
    await expect(fs.stat(path.join(agentDir, "auth-profiles.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to bypass a pending legacy auth source", async () => {
    const { agentDir, agentId, stateDir } = await createQaAuthState();
    const authPath = path.join(agentDir, "auth-profiles.json");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(authPath, "{not-json", "utf8");

    await expect(
      writeQaAuthProfiles({
        agentId,
        profiles: {
          "qa-mock-openai": {
            type: "api_key",
            provider: "openai",
            key: "qa-mock-not-a-real-key",
          },
        },
        stateDir,
      }),
    ).rejects.toThrow("requires legacy credential migration");
    await expect(fs.readFile(authPath, "utf8")).resolves.toBe("{not-json");
  });

  it("merges canonical API-key, token, and OAuth profile shapes", async () => {
    const { agentDir, agentId, stateDir } = await createQaAuthState();
    await writeQaAuthProfiles({
      agentId,
      profiles: {
        existing: {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
        tokenProfile: {
          type: "token",
          provider: "github",
          tokenRef: { source: "file", provider: "vault", id: "github/token" },
        },
        oauthProfile: {
          type: "oauth",
          provider: "chatgpt",
          access: "qa-access-token",
          refresh: "qa-refresh-token",
          expires: 1_900_000_000_000,
        },
      },
      stateDir,
    });

    await writeQaAuthProfiles({
      agentId,
      profiles: {
        "qa-mock-anthropic": {
          type: "api_key",
          provider: "anthropic",
          key: "qa-mock-not-a-real-key",
        },
      },
      stateDir,
    });

    expect(readQaAuthProfiles(agentDir).profiles).toMatchObject({
      existing: { type: "api_key", provider: "openai" },
      tokenProfile: { type: "token", provider: "github" },
      oauthProfile: { type: "oauth", provider: "chatgpt" },
      "qa-mock-anthropic": { type: "api_key", provider: "anthropic" },
    });
  });

  it("can replace an existing profile set for deterministic fixture seeding", async () => {
    const { agentDir, agentId, stateDir } = await createQaAuthState();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          stale: { type: "api_key", provider: "openai", key: "qa-stale-not-a-real-key" },
        },
        order: { openai: ["stale"] },
        lastGood: { openai: "stale" },
        usageStats: { stale: { cooldownUntil: Date.now() + 60_000 } },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );

    await writeQaAuthProfiles({
      agentId,
      profiles: {
        current: { type: "api_key", provider: "anthropic", key: "qa-current-not-a-real-key" },
      },
      replace: true,
      stateDir,
    });

    expect(Object.keys(readQaAuthProfiles(agentDir).profiles)).toEqual(["current"]);
    const replaced = loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
      inheritedAuthDir: agentDir,
    });
    expect(replaced.order).toBeUndefined();
    expect(replaced.lastGood).toBeUndefined();
    expect(replaced.usageStats).toBeUndefined();
  });
});
