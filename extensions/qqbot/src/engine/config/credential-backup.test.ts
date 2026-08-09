// Qqbot tests cover credential backup plugin behavior.
import fs from "node:fs";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installQQBotRuntimeForStateTests,
  resetQQBotStateTestRuntime,
} from "../../test-support/runtime.js";

type CredentialBackup = {
  accountId: string;
  appId: string;
  clientSecret: string;
  savedAt: string;
};

const tempWorkspaces: TempWorkspaceSync[] = [];

async function useMockHome(homeDir: string): Promise<void> {
  vi.doMock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:os")>();
    return {
      ...actual,
      default: { ...actual, homedir: () => homeDir },
      homedir: () => homeDir,
    };
  });
}

function useStateDir(stateDir: string): void {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  installQQBotRuntimeForStateTests(stateDir);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function legacyCredentialBackupFile(accountId: string): string {
  return path.join(
    process.env.OPENCLAW_STATE_DIR!,
    "qqbot",
    "data",
    `credential-backup-${accountId}.json`,
  );
}

function legacySingleCredentialBackupFile(): string {
  return path.join(process.env.OPENCLAW_STATE_DIR!, "qqbot", "data", "credential-backup.json");
}

function readCredentialRows(stateDir: string): CredentialBackup[] {
  const store = createPluginStateSyncKeyedStoreForTests<CredentialBackup>("qqbot", {
    namespace: "credential-backups",
    maxEntries: 1000,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  return store.entries().map((entry) => entry.value);
}

describe("engine/config/credential-backup", () => {
  beforeEach(async () => {
    vi.resetModules();
    const stateWorkspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "qqbot-state-",
    });
    const homeWorkspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "qqbot-home-",
    });
    tempWorkspaces.push(stateWorkspace, homeWorkspace);
    const stateDir = stateWorkspace.dir;
    const homeDir = homeWorkspace.dir;
    vi.stubEnv("HOME", homeDir);
    await useMockHome(homeDir);
    useStateDir(stateDir);
  });

  afterEach(() => {
    resetQQBotStateTestRuntime();
    resetPluginStateStoreForTests();
    vi.doUnmock("node:os");
    vi.resetModules();
    vi.unstubAllEnvs();
    for (const workspace of tempWorkspaces.splice(0)) {
      workspace.cleanup();
    }
  });

  it("round-trips a credential snapshot through SQLite without writing JSON", async () => {
    const { loadCredentialBackup, saveCredentialBackup } = await import("./credential-backup.js");
    const stateDir = process.env.OPENCLAW_STATE_DIR!;

    saveCredentialBackup("default", "app-1", "secret-1");

    const loaded = loadCredentialBackup("default");
    expect(loaded).toMatchObject({
      accountId: "default",
      appId: "app-1",
      clientSecret: "secret-1",
    });
    expect(fs.existsSync(legacyCredentialBackupFile("default"))).toBe(false);
    expect(readCredentialRows(stateDir)).toHaveLength(1);
  });

  it("keeps same account IDs isolated across state directories", async () => {
    const { loadCredentialBackup, saveCredentialBackup } = await import("./credential-backup.js");
    const stateDirA = process.env.OPENCLAW_STATE_DIR!;
    saveCredentialBackup("default", "app-a", "secret-a");

    const stateWorkspaceB = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "qqbot-state-b-",
    });
    tempWorkspaces.push(stateWorkspaceB);
    const stateDirB = stateWorkspaceB.dir;
    useStateDir(stateDirB);
    expect(loadCredentialBackup("default")).toBeNull();
    saveCredentialBackup("default", "app-b", "secret-b");

    useStateDir(stateDirA);
    expect(loadCredentialBackup("default")?.appId).toBe("app-a");

    useStateDir(stateDirB);
    expect(loadCredentialBackup("default")?.appId).toBe("app-b");
  });

  it("does not import state-dir legacy JSON backups during runtime reads", async () => {
    const { loadCredentialBackup } = await import("./credential-backup.js");
    const legacyFile = legacyCredentialBackupFile("default");
    writeJson(legacyFile, {
      accountId: "default",
      appId: "app-old",
      clientSecret: "secret-old",
      savedAt: new Date().toISOString(),
    });

    expect(loadCredentialBackup("default")).toBeNull();
    expect(fs.existsSync(legacyFile)).toBe(true);
  });

  it("does not import legacy single-file backups during runtime reads", async () => {
    const { loadCredentialBackup } = await import("./credential-backup.js");
    const legacyFile = legacySingleCredentialBackupFile();
    writeJson(legacyFile, {
      accountId: "other-acct",
      appId: "app-old",
      clientSecret: "secret-old",
      savedAt: new Date().toISOString(),
    });

    expect(loadCredentialBackup("default")).toBeNull();
    expect(fs.existsSync(legacyFile)).toBe(true);
  });

  it("ignores empty appId/clientSecret on save", async () => {
    const { loadCredentialBackup, saveCredentialBackup } = await import("./credential-backup.js");
    saveCredentialBackup("default", "", "secret");
    saveCredentialBackup("default", "app", "");

    expect(loadCredentialBackup("default")).toBeNull();
    expect(readCredentialRows(process.env.OPENCLAW_STATE_DIR!)).toHaveLength(0);
  });
});
