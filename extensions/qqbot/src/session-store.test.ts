import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "./session-store.js";

type SessionStoreModule = typeof import("./session-store.js");

async function loadSessionStore(testRoot: string): Promise<SessionStoreModule> {
  vi.resetModules();
  vi.doMock("./utils/platform.js", () => ({
    getQQBotDataDir: (...subPaths: string[]) => {
      const dir = path.join(testRoot, ...subPaths);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
  }));
  return import("./session-store.js");
}

function buildSession(accountId: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    accountId,
    intentLevelIndex: 0,
    lastConnectedAt: 1_700_000_000_000,
    lastSeq: 42,
    savedAt: 1_700_000_000_000,
    sessionId: `session-${accountId}`,
    ...overrides,
  };
}

describe("qqbot session store", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("./utils/platform.js");
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps distinct sessions when account ids collide under the legacy filename sanitizer", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-session-store-"));
    tempRoots.push(testRoot);
    const store = await loadSessionStore(testRoot);

    const colonAccount = "acct:one";
    const slashAccount = "acct/one";
    store.saveSession(buildSession(colonAccount, { lastSeq: 11, sessionId: "colon-session" }));
    store.saveSession(buildSession(slashAccount, { lastSeq: 22, sessionId: "slash-session" }));

    expect(store.loadSession(colonAccount)).toMatchObject({
      accountId: colonAccount,
      lastSeq: 11,
      sessionId: "colon-session",
    });
    expect(store.loadSession(slashAccount)).toMatchObject({
      accountId: slashAccount,
      lastSeq: 22,
      sessionId: "slash-session",
    });

    const sessionFiles = fs
      .readdirSync(path.join(testRoot, "sessions"))
      .filter((file) => file.startsWith("session-") && file.endsWith(".json"));
    expect(sessionFiles).toHaveLength(2);
  });

  it("loads a legacy sanitized session file for backward compatibility", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-session-store-"));
    tempRoots.push(testRoot);
    const store = await loadSessionStore(testRoot);

    const accountId = "legacy/account:id";
    const legacyPath = path.join(
      testRoot,
      "sessions",
      `session-${accountId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
    );
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify(buildSession(accountId, { savedAt: Date.now(), sessionId: "legacy" })),
    );

    expect(store.loadSession(accountId)).toMatchObject({
      accountId,
      sessionId: "legacy",
    });
  });
});
