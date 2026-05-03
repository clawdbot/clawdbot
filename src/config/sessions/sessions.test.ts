import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import * as jsonFiles from "../../infra/json-files.js";
import { createSuiteTempRootTracker, withTempDirSync } from "../../test-helpers/temp-dir.js";
import type { OpenClawConfig } from "../config.js";
import type { SessionConfig } from "../types.base.js";
import { resolveSessionLifecycleTimestamps } from "./lifecycle.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPathInDir,
  validateSessionId,
} from "./paths.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy } from "./reset.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { clearSessionStoreCacheForTest, loadSessionStore, updateSessionStore } from "./store.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { mergeSessionEntry, mergeSessionEntryWithPolicy, type SessionEntry } from "./types.js";

describe("session path safety", () => {
  it("rejects unsafe session IDs", () => {
    const unsafeSessionIds = [
      "../etc/passwd",
      "a/b",
      "a\\b",
      "/abs",
      "sess.checkpoint.11111111-1111-4111-8111-111111111111",
    ];
    for (const sessionId of unsafeSessionIds) {
      expect(() => validateSessionId(sessionId), sessionId).toThrow(/Invalid session ID/);
    }
  });

  it("resolves transcript path inside an explicit sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";
    const resolved = resolveSessionTranscriptPathInDir("sess-1", sessionsDir, "topic/a+b");

    expect(resolved).toBe(path.resolve(sessionsDir, "sess-1-topic-topic%2Fa%2Bb.jsonl"));
  });

  it("falls back to derived path when sessionFile is outside known agent sessions dirs", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "/tmp/openclaw/agents/work/not-sessions/abc-123.jsonl" },
      { sessionsDir },
    );
    expect(resolved).toBe(path.resolve(sessionsDir, "sess-1.jsonl"));
  });

  it("ignores multi-store sentinel paths when deriving session file options", () => {
    expect(resolveSessionFilePathOptions({ agentId: "worker", storePath: "(multiple)" })).toEqual({
      agentId: "worker",
    });
    expect(resolveSessionFilePathOptions({ storePath: "(multiple)" })).toBeUndefined();
  });

  it("accepts symlink-alias session paths that resolve under the sessions dir", () => {
    if (process.platform === "win32") {
      return;
    }
    withTempDirSync({ prefix: "openclaw-symlink-session-" }, (tmpDir) => {
      const realRoot = path.join(tmpDir, "real-state");
      const aliasRoot = path.join(tmpDir, "alias-state");
      const sessionsDir = path.join(realRoot, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.symlinkSync(realRoot, aliasRoot, "dir");
      const viaAlias = path.join(aliasRoot, "agents", "main", "sessions", "sess-1.jsonl");
      fs.writeFileSync(path.join(sessionsDir, "sess-1.jsonl"), "");
      const resolved = resolveSessionFilePath("sess-1", { sessionFile: viaAlias }, { sessionsDir });
      expect(fs.realpathSync(resolved)).toBe(
        fs.realpathSync(path.join(sessionsDir, "sess-1.jsonl")),
      );
    });
  });

  it("falls back when sessionFile is a symlink that escapes sessions dir", () => {
    if (process.platform === "win32") {
      return;
    }
    withTempDirSync({ prefix: "openclaw-symlink-escape-" }, (tmpDir) => {
      const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
      const outsideDir = path.join(tmpDir, "outside");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, "escaped.jsonl");
      fs.writeFileSync(outsideFile, "");
      const symlinkPath = path.join(sessionsDir, "escaped.jsonl");
      fs.symlinkSync(outsideFile, symlinkPath, "file");

      const resolved = resolveSessionFilePath(
        "sess-1",
        { sessionFile: symlinkPath },
        { sessionsDir },
      );
      expect(fs.realpathSync(path.dirname(resolved))).toBe(fs.realpathSync(sessionsDir));
      expect(path.basename(resolved)).toBe("sess-1.jsonl");
    });
  });
});

describe("resolveSessionResetPolicy", () => {
  describe("backward compatibility: resetByType.dm -> direct", () => {
    it("does not use dm fallback for group/thread types", () => {
      const sessionCfg = {
        resetByType: {
          dm: { mode: "idle" as const, idleMinutes: 45 },
        },
      } as unknown as SessionConfig;

      const groupPolicy = resolveSessionResetPolicy({
        sessionCfg,
        resetType: "group",
      });

      expect(groupPolicy.mode).toBe("daily");
    });
  });

  it("defaults to daily resets at 4am local time", () => {
    const policy = resolveSessionResetPolicy({
      resetType: "direct",
    });

    expect(policy).toMatchObject({
      mode: "daily",
      atHour: 4,
    });
  });

  it("treats idleMinutes=0 as never expiring by inactivity", () => {
    const freshness = evaluateSessionFreshness({
      updatedAt: 1_000,
      now: 60 * 60 * 1_000,
      policy: {
        mode: "idle",
        atHour: 4,
        idleMinutes: 0,
      },
    });

    expect(freshness).toEqual({
      fresh: true,
      dailyResetAt: undefined,
      idleExpiresAt: undefined,
    });
  });

  it("uses sessionStartedAt, not updatedAt, for daily reset freshness", () => {
    const now = new Date(2026, 3, 25, 12, 0, 0, 0).getTime();
    const freshness = evaluateSessionFreshness({
      updatedAt: now,
      sessionStartedAt: now - 25 * 60 * 60_000,
      now,
      policy: {
        mode: "daily",
        atHour: 4,
      },
    });

    expect(freshness.fresh).toBe(false);
  });

  it("uses lastInteractionAt, not updatedAt, for idle reset freshness", () => {
    const now = 60 * 60_000;
    const freshness = evaluateSessionFreshness({
      updatedAt: now,
      lastInteractionAt: 0,
      now,
      policy: {
        mode: "idle",
        atHour: 4,
        idleMinutes: 5,
      },
    });

    expect(freshness).toMatchObject({
      fresh: false,
      idleExpiresAt: 5 * 60_000,
    });
  });

  it("falls back to sessionStartedAt, not updatedAt, for legacy idle freshness", () => {
    const now = 60 * 60_000;
    const freshness = evaluateSessionFreshness({
      updatedAt: now,
      sessionStartedAt: 0,
      now,
      policy: {
        mode: "idle",
        atHour: 4,
        idleMinutes: 5,
      },
    });

    expect(freshness).toMatchObject({
      fresh: false,
      idleExpiresAt: 5 * 60_000,
    });
  });

  it("does not let future legacy updatedAt values keep daily sessions fresh", () => {
    const now = new Date(2026, 3, 25, 12, 0, 0, 0).getTime();
    const freshness = evaluateSessionFreshness({
      updatedAt: now + 30 * 24 * 60 * 60_000,
      now,
      policy: {
        mode: "daily",
        atHour: 4,
      },
    });

    expect(freshness.fresh).toBe(false);
  });

  it("does not let future legacy updatedAt values keep idle sessions fresh", () => {
    const now = 60 * 60_000;
    const freshness = evaluateSessionFreshness({
      updatedAt: now + 30 * 24 * 60 * 60_000,
      now,
      policy: {
        mode: "idle",
        atHour: 4,
        idleMinutes: 5,
      },
    });

    expect(freshness).toMatchObject({
      fresh: false,
      idleExpiresAt: 5 * 60_000,
    });
  });
});

describe("session lifecycle timestamps", () => {
  it("falls back to the JSONL session header for legacy session start time", async () => {
    const dir = await fsPromises.mkdtemp("/tmp/openclaw-lifecycle-test-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const sessionFile = path.join(dir, "legacy-session.jsonl");
      const headerTimestamp = "2026-04-20T04:30:00.000Z";
      await fsPromises.writeFile(
        sessionFile,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "legacy-session",
          timestamp: headerTimestamp,
          cwd: dir,
        })}\n`,
        "utf8",
      );

      const timestamps = resolveSessionLifecycleTimestamps({
        storePath,
        entry: {
          sessionId: "legacy-session",
          sessionFile,
          updatedAt: Date.parse("2026-04-25T08:00:00.000Z"),
        },
      });

      expect(timestamps.sessionStartedAt).toBe(Date.parse(headerTimestamp));
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("session store writer queue", () => {
  const writerFixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-writer-test-" });

  async function makeTmpStore(
    initial: Record<string, unknown> = {},
  ): Promise<{ dir: string; storePath: string }> {
    const dir = await writerFixtureRootTracker.make("case");
    const storePath = path.join(dir, "sessions.json");
    if (Object.keys(initial).length > 0) {
      await fsPromises.writeFile(storePath, JSON.stringify(initial, null, 2), "utf-8");
    }
    return { dir, storePath };
  }

  beforeAll(async () => {
    await writerFixtureRootTracker.setup();
  });

  afterAll(async () => {
    await writerFixtureRootTracker.cleanup();
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
  });

  it("serializes concurrent updateSessionStore calls without data loss", async () => {
    const key = "agent:main:test";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: Date.now(), counter: 0 },
    });

    const N = 4;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateSessionStore(storePath, async (store) => {
          const entry = store[key] as Record<string, unknown>;
          await Promise.resolve();
          entry.counter = (entry.counter as number) + 1;
          entry.tag = `writer-${i}`;
        }),
      ),
    );

    const store = loadSessionStore(storePath);
    expect((store[key] as Record<string, unknown>).counter).toBe(N);
  });

  it("skips session store disk writes when payload is unchanged", async () => {
    const key = "agent:main:no-op-save";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s-noop", updatedAt: Date.now() },
    });

    const writeSpy = vi.spyOn(jsonFiles, "writeTextAtomic");
    await updateSessionStore(
      storePath,
      async () => {
        // Intentionally no-op mutation.
      },
      { skipMaintenance: true },
    );
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("multiple consecutive errors do not permanently poison the queue", async () => {
    const key = "agent:main:multi-err";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: Date.now() },
    });

    const errors = Array.from({ length: 3 }, (_, i) =>
      updateSessionStore(storePath, async () => {
        throw new Error(`fail-${i}`);
      }),
    );

    const success = updateSessionStore(storePath, async (store) => {
      store[key] = { ...store[key], modelOverride: "recovered" } as unknown as SessionEntry;
    });

    for (const p of errors) {
      await expect(p).rejects.toThrow();
    }
    await success;

    const store = loadSessionStore(storePath);
    expect(store[key]?.modelOverride).toBe("recovered");
  });

  it("clears stale runtime provider when model is patched without provider", () => {
    const merged = mergeSessionEntry(
      {
        sessionId: "sess-runtime",
        updatedAt: 100,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
      },
      {
        model: "gpt-5.4",
      },
    );
    expect(merged.model).toBe("gpt-5.4");
    expect(merged.modelProvider).toBeUndefined();
  });

  it("caps future updatedAt values at the session merge boundary", () => {
    const now = 1_000;
    const merged = mergeSessionEntryWithPolicy(
      {
        sessionId: "sess-future",
        updatedAt: now + 10_000,
      },
      {
        updatedAt: now + 20_000,
      },
      { now },
    );

    expect(merged.updatedAt).toBe(now);
  });

  it("caps future updatedAt values while preserving activity", () => {
    const now = 1_000;
    const merged = mergeSessionEntryWithPolicy(
      {
        sessionId: "sess-preserve-future",
        updatedAt: now + 10_000,
      },
      {},
      { now, policy: "preserve-activity" },
    );

    expect(merged.updatedAt).toBe(now);
  });

  it("normalizes orphan modelProvider fields at store write boundary", async () => {
    const key = "agent:main:orphan-provider";
    const { storePath } = await makeTmpStore({
      [key]: {
        sessionId: "sess-orphan",
        updatedAt: 100,
        modelProvider: "anthropic",
      },
    });

    await updateSessionStore(storePath, async (store) => {
      const entry = store[key];
      entry.updatedAt = Date.now();
    });

    const store = loadSessionStore(storePath);
    expect(store[key]?.modelProvider).toBeUndefined();
    expect(store[key]?.model).toBeUndefined();
  });

  it("preserves ACP metadata when replacing a session entry wholesale", async () => {
    const key = "agent:codex:acp:binding:discord:default:feedface";
    const acp = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "codex-discord",
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 100,
    };
    const { storePath } = await makeTmpStore({
      [key]: {
        sessionId: "sess-acp",
        updatedAt: Date.now(),
        acp,
      },
    });

    await updateSessionStore(storePath, (store) => {
      store[key] = {
        sessionId: "sess-acp",
        updatedAt: Date.now(),
        modelProvider: "openai-codex",
        model: "gpt-5.4",
      };
    });

    const store = loadSessionStore(storePath);
    expect(store[key]?.acp).toEqual(acp);
    expect(store[key]?.modelProvider).toBe("openai-codex");
    expect(store[key]?.model).toBe("gpt-5.4");
  });

  it("allows explicit ACP metadata removal through the ACP session helper", async () => {
    const key = "agent:codex:acp:binding:discord:default:deadbeef";
    const { storePath } = await makeTmpStore({
      [key]: {
        sessionId: "sess-acp-clear",
        updatedAt: 100,
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-discord",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 100,
        },
      },
    });
    const cfg = {
      session: {
        store: storePath,
      },
    } as OpenClawConfig;

    const result = await upsertAcpSessionMeta({
      cfg,
      sessionKey: key,
      mutate: () => null,
    });

    expect(result?.acp).toBeUndefined();
    const store = loadSessionStore(storePath);
    expect(store[key]?.acp).toBeUndefined();
  });
});

describe("resolveAndPersistSessionFile", () => {
  const fixture = useTempSessionsFixture("session-file-test-");

  it("persists fallback topic transcript paths for sessions without sessionFile", async () => {
    const sessionId = "topic-session-id";
    const sessionKey = "agent:main:telegram:group:123:topic:456";
    const store = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");
    const sessionStore = loadSessionStore(fixture.storePath(), { skipCache: true });
    const fallbackSessionFile = resolveSessionTranscriptPathInDir(
      sessionId,
      fixture.sessionsDir(),
      456,
    );

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      sessionEntry: sessionStore[sessionKey],
      fallbackSessionFile,
    });

    expect(result.sessionFile).toBe(fallbackSessionFile);

    const saved = loadSessionStore(fixture.storePath(), { skipCache: true });
    expect(saved[sessionKey]?.sessionFile).toBe(fallbackSessionFile);
  });

  it("creates and persists entry when session is not yet present", async () => {
    const sessionId = "new-session-id";
    const sessionKey = "agent:main:telegram:group:123";
    fs.writeFileSync(fixture.storePath(), JSON.stringify({}), "utf-8");
    const sessionStore = loadSessionStore(fixture.storePath(), { skipCache: true });
    const fallbackSessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      fallbackSessionFile,
    });

    expect(result.sessionFile).toBe(fallbackSessionFile);
    expect(result.sessionEntry.sessionId).toBe(sessionId);
    const saved = loadSessionStore(fixture.storePath(), { skipCache: true });
    expect(saved[sessionKey]?.sessionFile).toBe(fallbackSessionFile);
  });

  it("rotates to a new transcript path when sessionId changes on the same session key", async () => {
    const previousSessionId = "old-session-id";
    const nextSessionId = "new-session-id";
    const sessionKey = "agent:main:telegram:group:123";
    const previousSessionFile = resolveSessionTranscriptPathInDir(
      previousSessionId,
      fixture.sessionsDir(),
    );
    const expectedNextSessionFile = resolveSessionTranscriptPathInDir(
      nextSessionId,
      fixture.sessionsDir(),
    );
    const store = {
      [sessionKey]: {
        sessionId: previousSessionId,
        updatedAt: Date.now(),
        sessionFile: previousSessionFile,
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");
    const sessionStore = loadSessionStore(fixture.storePath(), { skipCache: true });

    const result = await resolveAndPersistSessionFile({
      sessionId: nextSessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      sessionEntry: sessionStore[sessionKey],
      sessionsDir: fixture.sessionsDir(),
    });

    expect(result.sessionFile).toBe(expectedNextSessionFile);
    expect(result.sessionFile).not.toBe(previousSessionFile);
    expect(result.sessionEntry.sessionFile).toBe(expectedNextSessionFile);

    const saved = loadSessionStore(fixture.storePath(), { skipCache: true });
    expect(saved[sessionKey]?.sessionFile).toBe(expectedNextSessionFile);
  });
});
