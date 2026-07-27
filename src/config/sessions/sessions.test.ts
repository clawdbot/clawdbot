// Session config tests cover session creation, updates, and persistence.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDirSync } from "../../test-helpers/temp-dir.js";
import type { SessionConfig } from "../types.base.js";
import { resolveSessionLifecycleTimestamps, resolveSessionWorkStartError } from "./lifecycle.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPathInDir,
  validateSessionId,
} from "./paths.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy } from "./reset.js";
import { mergeRestartRecoveryTerminalRunIds } from "./restart-recovery-state.js";
import { loadSessionEntry } from "./session-accessor.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { formatSqliteSessionFileMarker } from "./sqlite-marker.js";
import { useTempSessionsFixture } from "./test-helpers.js";

it("merges bounded restart tombstones without evicting fresh-only ids", () => {
  const existing = Array.from({ length: 64 }, (_, index) => `run-${index}`);

  expect(mergeRestartRecoveryTerminalRunIds(existing, [...existing.slice(1), "run-new"])).toEqual([
    ...existing.slice(1),
    "run-new",
  ]);
  expect(mergeRestartRecoveryTerminalRunIds(existing, ["run-0"])).toEqual(existing);
});

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

      expect(groupPolicy.mode).toBe("none");
    });
  });

  it("defaults to no automatic reset", () => {
    const policy = resolveSessionResetPolicy({
      resetType: "direct",
    });

    expect(policy.mode).toBe("none");
    expect(policy.atHour).toBe(4);
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
    expect(freshness.staleReason).toBe("daily");
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

    expect(freshness.fresh).toBe(false);
    expect(freshness.idleExpiresAt).toBe(5 * 60_000);
    expect(freshness.staleReason).toBe("idle");
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

    expect(freshness.fresh).toBe(false);
    expect(freshness.idleExpiresAt).toBe(5 * 60_000);
    expect(freshness.staleReason).toBe("idle");
  });

  it("reports the first expired reset deadline when daily and idle are both stale", () => {
    const now = new Date(2026, 3, 25, 12, 0, 0, 0).getTime();
    const freshness = evaluateSessionFreshness({
      updatedAt: now,
      sessionStartedAt: new Date(2026, 3, 24, 23, 0, 0, 0).getTime(),
      lastInteractionAt: new Date(2026, 3, 25, 11, 0, 0, 0).getTime(),
      now,
      policy: {
        mode: "daily",
        atHour: 4,
        idleMinutes: 30,
      },
    });

    expect(freshness.fresh).toBe(false);
    expect(freshness.staleReason).toBe("daily");
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

    expect(freshness.fresh).toBe(false);
    expect(freshness.idleExpiresAt).toBe(5 * 60_000);
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

      const realReadSync = fs.readSync.bind(fs);
      let shortReadCalls = 0;
      const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: fs.ReadPosition | null,
      ) => {
        shortReadCalls += 1;
        return realReadSync(fd, buffer, offset, Math.min(length, 16), position);
      }) as typeof fs.readSync);

      try {
        const timestamps = resolveSessionLifecycleTimestamps({
          storePath,
          entry: {
            sessionId: "legacy-session",
            sessionFile,
            updatedAt: Date.parse("2026-04-25T08:00:00.000Z"),
          },
        });

        expect(timestamps.sessionStartedAt).toBe(Date.parse(headerTimestamp));
        expect(shortReadCalls).toBeGreaterThan(1);
      } finally {
        readSpy.mockRestore();
      }
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores out-of-range lifecycle timestamps before header fallback", async () => {
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
          sessionStartedAt: Number.MAX_SAFE_INTEGER,
          lastInteractionAt: Number.MAX_SAFE_INTEGER,
          updatedAt: Date.parse("2026-04-25T08:00:00.000Z"),
        },
      });

      expect(timestamps.sessionStartedAt).toBe(Date.parse(headerTimestamp));
      expect(timestamps.lastInteractionAt).toBeUndefined();
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("session work admission", () => {
  it("fails closed while trusted session initialization is pending", () => {
    expect(
      resolveSessionWorkStartError("agent:main:pending", {
        sessionId: "pending-session",
        initializationPending: true,
      }),
    ).toContain("still initializing");
    expect(
      resolveSessionWorkStartError("agent:main:pending", {
        sessionId: "pending-session",
      }),
    ).toBeUndefined();
  });
});

describe("resolveAndPersistSessionFile", () => {
  const fixture = useTempSessionsFixture("session-file-test-");

  it("persists SQLite transcript markers for sessions without sessionFile", async () => {
    const sessionId = "topic-session-id";
    const sessionKey = "agent:main:telegram:group:123:topic:456";
    const store = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    const sessionStore = store;
    const expectedSessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath: fixture.storePath(),
    });

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      sessionEntry: sessionStore[sessionKey],
      agentId: "main",
    });

    expect(result.sessionFile).toBe(expectedSessionFile);

    expect(loadSessionEntry({ storePath: fixture.storePath(), sessionKey })?.sessionFile).toBe(
      expectedSessionFile,
    );
  });

  it("creates and persists entry when session is not yet present", async () => {
    const sessionId = "new-session-id";
    const sessionKey = "agent:main:telegram:group:123";
    const sessionStore = {};
    const expectedSessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath: fixture.storePath(),
    });

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      agentId: "main",
    });

    expect(result.sessionFile).toBe(expectedSessionFile);
    expect(result.sessionEntry.sessionId).toBe(sessionId);
    expect(loadSessionEntry({ storePath: fixture.storePath(), sessionKey })?.sessionFile).toBe(
      expectedSessionFile,
    );
  });

  it("rotates to a new SQLite transcript marker when sessionId changes on the same session key", async () => {
    const previousSessionId = "old-session-id";
    const nextSessionId = "new-session-id";
    const sessionKey = "agent:main:telegram:group:123";
    const previousSessionFile = resolveSessionTranscriptPathInDir(
      previousSessionId,
      fixture.sessionsDir(),
    );
    const expectedNextSessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: nextSessionId,
      storePath: fixture.storePath(),
    });
    const store = {
      [sessionKey]: {
        sessionId: previousSessionId,
        updatedAt: Date.now(),
        sessionFile: previousSessionFile,
      },
    };
    const sessionStore = store;

    const result = await resolveAndPersistSessionFile({
      sessionId: nextSessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      sessionEntry: sessionStore[sessionKey],
      agentId: "main",
    });

    expect(result.sessionFile).toBe(expectedNextSessionFile);
    expect(result.sessionFile).not.toBe(previousSessionFile);
    expect(result.sessionEntry.sessionFile).toBe(expectedNextSessionFile);

    expect(loadSessionEntry({ storePath: fixture.storePath(), sessionKey })?.sessionFile).toBe(
      expectedNextSessionFile,
    );
  });
});
