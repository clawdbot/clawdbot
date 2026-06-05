// Qqbot tests cover known users plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installQQBotRuntimeForStateTests,
  resetQQBotStateTestRuntime,
} from "../../test-support/runtime.js";

type KnownUser = {
  openid: string;
  type: "c2c" | "group";
  nickname?: string;
  groupOpenid?: string;
  accountId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  interactionCount: number;
};

const createdDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function knownUsersFile(homeDir: string): string {
  return path.join(homeDir, ".openclaw", "qqbot", "data", "known-users.json");
}

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

function knownUserRows(stateDir: string): KnownUser[] {
  const store = createPluginStateSyncKeyedStoreForTests<KnownUser>("qqbot", {
    namespace: "known-users",
    maxEntries: 100_000,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  return store.entries().map((entry) => entry.value);
}

describe("engine/session/known-users", () => {
  beforeEach(async () => {
    vi.resetModules();
    const stateDir = createTempDir("qqbot-state-");
    const homeDir = createTempDir("qqbot-home-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("HOME", homeDir);
    await useMockHome(homeDir);
    installQQBotRuntimeForStateTests(stateDir);
  });

  afterEach(() => {
    resetQQBotStateTestRuntime();
    vi.doUnmock("node:os");
    vi.resetModules();
    vi.unstubAllEnvs();
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records known users in SQLite and flushes synchronously", async () => {
    const { flushKnownUsers, recordKnownUser } = await import("./known-users.js");
    const stateDir = process.env.OPENCLAW_STATE_DIR!;

    recordKnownUser({
      openid: "user-1",
      type: "c2c",
      nickname: "First",
      accountId: "acct-1",
    });
    recordKnownUser({
      openid: "user-1",
      type: "c2c",
      nickname: "Second",
      accountId: "acct-1",
    });
    flushKnownUsers();

    expect(knownUserRows(stateDir)).toMatchObject([
      {
        openid: "user-1",
        nickname: "Second",
        interactionCount: 2,
      },
    ]);
    expect(fs.existsSync(knownUsersFile(process.env.HOME!))).toBe(false);
  });

  it("imports legacy known-users.json once", async () => {
    const { recordKnownUser } = await import("./known-users.js");
    const stateDir = process.env.OPENCLAW_STATE_DIR!;
    const legacyPath = knownUsersFile(process.env.HOME!);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify([
        {
          openid: "legacy-user",
          type: "group",
          groupOpenid: "group-1",
          accountId: "acct-1",
          firstSeenAt: 1,
          lastSeenAt: 2,
          interactionCount: 3,
        },
      ]),
    );

    recordKnownUser({
      openid: "new-user",
      type: "c2c",
      accountId: "acct-1",
    });

    const rows = knownUserRows(stateDir);
    expect(rows.map((row) => row.openid).toSorted()).toEqual(["legacy-user", "new-user"]);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("keeps known-user tracking best-effort when SQLite is unavailable", async () => {
    resetQQBotStateTestRuntime();
    const { recordKnownUser } = await import("./known-users.js");

    expect(() =>
      recordKnownUser({
        openid: "user-1",
        type: "c2c",
        accountId: "acct-1",
      }),
    ).not.toThrow();
  });
});
