// Session config tests cover session creation, updates, and persistence.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDirSync } from "../../test-helpers/temp-dir.js";
import type { SessionConfig } from "../types.base.js";
import { resolveSessionWorkStartError } from "./lifecycle.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPathInDir,
  validateSessionId,
} from "./paths.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy } from "./reset.js";
import { mergeRestartRecoveryTerminalRunIds } from "./restart-recovery-state.js";

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
