// Qqbot tests cover known users plugin behavior.
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
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
    for (const workspace of tempWorkspaces.splice(0)) {
      workspace.cleanup();
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
