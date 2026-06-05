// Qqbot tests cover session store plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installQQBotRuntimeForStateTests,
  resetQQBotStateTestRuntime,
} from "../../test-support/runtime.js";
import type { SessionState } from "./session-store.js";

const createdDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
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

async function useStateAndHome(): Promise<{ stateDir: string; homeDir: string }> {
  const stateDir = createTempDir("qqbot-state-");
  const homeDir = createTempDir("qqbot-home-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("HOME", homeDir);
  await useMockHome(homeDir);
  installQQBotRuntimeForStateTests(stateDir);
  return { stateDir, homeDir };
}

function sessionPath(homeDir: string, accountId: string): string {
  const encodedId = Buffer.from(accountId, "utf8").toString("base64url");
  return path.join(homeDir, ".openclaw", "qqbot", "sessions", `session-${encodedId}.json`);
}

function writeLegacySession(homeDir: string, state: SessionState): string {
  const filePath = sessionPath(homeDir, state.accountId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
  return filePath;
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "session-1",
    lastSeq: 42,
    lastConnectedAt: Date.now(),
    intentLevelIndex: 0,
    accountId: "acct-1",
    savedAt: Date.now(),
    appId: "app-1",
    ...overrides,
  };
}

describe("engine/session/session-store", () => {
  beforeEach(async () => {
    vi.resetModules();
    await useStateAndHome();
  });

  afterEach(async () => {
    const { clearSession } = await import("./session-store.js");
    clearSession("acct-1");
    resetQQBotStateTestRuntime();
    vi.doUnmock("node:os");
    vi.resetModules();
    vi.unstubAllEnvs();
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips gateway sessions through SQLite without creating JSON files", async () => {
    const { loadSession, saveSession } = await import("./session-store.js");
    const homeDir = process.env.HOME!;

    saveSession(makeSession());

    expect(loadSession("acct-1", "app-1")?.sessionId).toBe("session-1");
    expect(fs.existsSync(sessionPath(homeDir, "acct-1"))).toBe(false);
  });

  it("imports legacy JSON sessions and removes the old file", async () => {
    const { loadSession } = await import("./session-store.js");
    const homeDir = process.env.HOME!;
    const legacyPath = writeLegacySession(homeDir, makeSession({ sessionId: "legacy-session" }));

    expect(loadSession("acct-1", "app-1")?.sessionId).toBe("legacy-session");
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(loadSession("acct-1", "app-1")?.sessionId).toBe("legacy-session");
  });

  it("deletes mismatched appId sessions from SQLite", async () => {
    const { loadSession, saveSession } = await import("./session-store.js");
    saveSession(makeSession({ appId: "app-a" }));

    expect(loadSession("acct-1", "app-b")).toBeNull();
    expect(loadSession("acct-1", "app-a")).toBeNull();
  });

  it("drops expired legacy JSON sessions during import", async () => {
    const { loadSession } = await import("./session-store.js");
    const homeDir = process.env.HOME!;
    const legacyPath = writeLegacySession(
      homeDir,
      makeSession({ savedAt: Date.now() - 10 * 60 * 1000 }),
    );

    expect(loadSession("acct-1", "app-1")).toBeNull();
    expect(fs.existsSync(legacyPath)).toBe(false);
  });
});
