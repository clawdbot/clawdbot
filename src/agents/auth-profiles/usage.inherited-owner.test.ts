import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { resolveAuthProfileOrder } from "./order.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { markAuthProfileSuccess } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store.js";
import type { AuthProfileStore } from "./types.js";
import {
  clearAuthProfileCooldown,
  markAuthProfileBlockedUntil,
  markAuthProfileFailure,
} from "./usage.js";

const PRIMARY_ID = "openai:primary";
const BACKUP_ID = "openai:backup";
const LOCAL_ID = "openai:local";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createMainStore(): AuthProfileStore {
  const expires = Date.now() + 30 * 60 * 1000;
  return {
    version: 1,
    profiles: {
      [PRIMARY_ID]: {
        type: "oauth",
        provider: "openai",
        access: "primary-access",
        refresh: "primary-refresh",
        expires,
      },
      [BACKUP_ID]: {
        type: "oauth",
        provider: "openai",
        access: "backup-access",
        refresh: "backup-refresh",
        expires,
      },
    },
    order: { openai: [PRIMARY_ID, BACKUP_ID] },
  };
}

describe("inherited auth-profile usage persistence", () => {
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_AGENT_DIR"]);
  let rootDir: string;
  let mainAgentDir: string;
  let childAgentDir: string;

  beforeEach(() => {
    resetFileLockStateForTest();
    rootDir = tempDirs.make("inherited-auth-owner-");
    mainAgentDir = path.join(rootDir, "agents", "main", "agent");
    childAgentDir = path.join(rootDir, "agents", "child", "agent");
    fs.mkdirSync(mainAgentDir, { recursive: true });
    fs.mkdirSync(childAgentDir, { recursive: true });
    setTestEnvValue("OPENCLAW_STATE_DIR", rootDir);
    setTestEnvValue("OPENCLAW_AGENT_DIR", mainAgentDir);
    clearRuntimeAuthProfileStoreSnapshots();
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    resetFileLockStateForTest();
    env.restore();
  });

  function writeMainStore(): void {
    saveAuthProfileStore(createMainStore(), mainAgentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
  }

  it("keeps an inherited primary blocked for the next child run", async () => {
    writeMainStore();
    const localCooldownUntil = Date.now() + 30 * 60 * 1000;
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [LOCAL_ID]: { type: "api_key", provider: "openai", key: "local-key" },
        },
        usageStats: { [LOCAL_ID]: { cooldownUntil: localCooldownUntil } },
      },
      childAgentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    const childStore = ensureAuthProfileStore(childAgentDir);
    const blockedUntil = Date.now() + 60 * 60 * 1000;

    await markAuthProfileBlockedUntil({
      store: childStore,
      profileId: PRIMARY_ID,
      blockedUntil,
      source: "codex_rate_limits",
      agentDir: childAgentDir,
      modelId: "gpt-5.6-sol",
    });

    expect(childStore.usageStats?.[LOCAL_ID]?.cooldownUntil).toBe(localCooldownUntil);
    const persistedChild = loadPersistedAuthProfileStore(childAgentDir);
    expect(persistedChild?.profiles[PRIMARY_ID]).toBeUndefined();
    expect(persistedChild?.usageStats?.[LOCAL_ID]?.cooldownUntil).toBe(localCooldownUntil);

    clearRuntimeAuthProfileStoreSnapshots();
    const nextRunStore = ensureAuthProfileStore(childAgentDir);
    expect({
      ownerBlockedUntil:
        loadPersistedAuthProfileStore(mainAgentDir)?.usageStats?.[PRIMARY_ID]?.blockedUntil,
      nextRunOrder: resolveAuthProfileOrder({ store: nextRunStore, provider: "openai" }),
    }).toEqual({
      ownerBlockedUntil: blockedUntil,
      nextRunOrder: [BACKUP_ID, LOCAL_ID, PRIMARY_ID],
    });
  });

  it("writes and clears inherited failure state in the owner store", async () => {
    writeMainStore();
    const childStore = ensureAuthProfileStore(childAgentDir);

    await markAuthProfileFailure({
      store: childStore,
      profileId: PRIMARY_ID,
      reason: "timeout",
      agentDir: childAgentDir,
    });
    expect(
      loadPersistedAuthProfileStore(mainAgentDir)?.usageStats?.[PRIMARY_ID]?.cooldownUntil,
    ).toBeTypeOf("number");

    await clearAuthProfileCooldown({
      store: childStore,
      profileId: PRIMARY_ID,
      agentDir: childAgentDir,
    });
    const ownerStats = loadPersistedAuthProfileStore(mainAgentDir)?.usageStats?.[PRIMARY_ID];
    expect(ownerStats?.cooldownUntil).toBeUndefined();
    expect(ownerStats?.errorCount).toBe(0);
  });

  it("clears inherited health without changing selection ownership", async () => {
    const lastUsed = Date.now() - 60_000;
    const mainStore = createMainStore();
    mainStore.lastGood = { openai: BACKUP_ID };
    mainStore.usageStats = {
      [PRIMARY_ID]: {
        lastUsed,
        errorCount: 2,
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
        cooldownClassification: "wham_token_expired",
      },
    };
    saveAuthProfileStore(mainStore, mainAgentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    const localCooldownUntil = Date.now() + 30_000;
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [LOCAL_ID]: { type: "api_key", provider: "openai", key: "local-key" },
        },
        usageStats: { [LOCAL_ID]: { cooldownUntil: localCooldownUntil } },
      },
      childAgentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    const childStore = ensureAuthProfileStore(childAgentDir);

    await markAuthProfileSuccess({
      store: childStore,
      provider: "openai",
      profileId: PRIMARY_ID,
      agentDir: childAgentDir,
    });

    const persistedMain = loadPersistedAuthProfileStore(mainAgentDir);
    expect(persistedMain?.lastGood?.openai).toBe(BACKUP_ID);
    expect(persistedMain?.usageStats?.[PRIMARY_ID]).toMatchObject({
      lastUsed,
      errorCount: 0,
    });
    expect(persistedMain?.usageStats?.[PRIMARY_ID]?.cooldownUntil).toBeUndefined();
    expect(persistedMain?.usageStats?.[PRIMARY_ID]?.cooldownClassification).toBeUndefined();
    expect(childStore.usageStats?.[LOCAL_ID]?.cooldownUntil).toBe(localCooldownUntil);
    expect(childStore.usageStats?.[PRIMARY_ID]?.cooldownUntil).toBeUndefined();
    const persistedChild = loadPersistedAuthProfileStore(childAgentDir);
    expect(persistedChild?.profiles[PRIMARY_ID]).toBeUndefined();
    expect(persistedChild?.usageStats?.[PRIMARY_ID]).toBeUndefined();
    expect(persistedChild?.lastGood?.openai).toBeUndefined();
  });
});
