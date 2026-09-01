// Session config tests cover session creation, updates, and persistence.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDirSync } from "../../test-helpers/temp-dir.js";
import type { SessionConfig } from "../types.base.js";
import { resolveSessionWorkStartError } from "./lifecycle.js";
import {
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPathInDir,
  validateSessionId,
} from "./paths.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy } from "./reset.js";
import { mergeRestartRecoveryTerminalRunIds } from "./restart-recovery-state.js";
import { normalizePersistedSessionEntryShape } from "./store-entry-shape.js";

it("merges bounded restart tombstones without evicting fresh-only ids", () => {
  const existing = Array.from({ length: 64 }, (_, index) => `run-${index}`);

  expect(mergeRestartRecoveryTerminalRunIds(existing, [...existing.slice(1), "run-new"])).toEqual([
    ...existing.slice(1),
    "run-new",
  ]);
  expect(mergeRestartRecoveryTerminalRunIds(existing, ["run-0"])).toEqual(existing);
});

it("filters legacy row metadata with a noncanonical transcript id", () => {
  expect(
    normalizePersistedSessionEntryShape({
      sessionId: "legacy:session",
      updatedAt: 42,
      pluginExtensions: { memory: { mode: "legacy" } },
    }),
  ).toBeUndefined();
});

it("preserves shipped pending key-as-session-id rows without a transcript id", () => {
  expect(
    normalizePersistedSessionEntryShape(
      {
        sessionId: "agent:child:main",
        updatedAt: 42,
      },
      { sessionKey: "agent:child:main" },
    ),
  ).toMatchObject({ initializationPending: true, updatedAt: 42 });
  expect(
    normalizePersistedSessionEntryShape(
      {
        sessionId: "agent:child:main",
        updatedAt: 42,
      },
      { sessionKey: "agent:child:main" },
    ),
  ).not.toHaveProperty("sessionId");
});

it("rejects locked key-as-session-id rows instead of treating them as pending", () => {
  expect(
    normalizePersistedSessionEntryShape(
      {
        modelSelectionLocked: true,
        sessionId: "agent:child:main",
        updatedAt: 42,
      },
      { sessionKey: "agent:child:main" },
    ),
  ).toBeUndefined();
});

it("normalizes boolean-only pending delivery as transport-only", () => {
  expect(
    normalizePersistedSessionEntryShape({
      sessionId: "session-1",
      updatedAt: 42,
      pendingFinalDelivery: true,
    }),
  ).toMatchObject({
    pendingFinalDelivery: { kind: "transport-only", createdAt: 42 },
  });
});

it("normalizes exact pending-final delivery owners", () => {
  expect(
    normalizePersistedSessionEntryShape({
      sessionId: "session-1",
      updatedAt: 42,
      pendingFinalDelivery: {
        kind: "replayable",
        text: "durable reply",
        createdAt: 41,
        intentId: "intent-1",
        deliveries: [
          { id: "delivery-prepared", state: "prepared" },
          { id: "delivery-delivered", state: "delivered" },
          { id: "", state: "queued" },
          { id: "delivery-invalid", state: "invalid" },
        ],
      },
    }),
  ).toMatchObject({
    pendingFinalDelivery: {
      intentId: "intent-1",
      deliveries: [
        { id: "delivery-prepared", state: "prepared" },
        { id: "delivery-delivered", state: "delivered" },
      ],
    },
  });
});

it("normalizes and preserves the durable assistant transcript repair backlog", () => {
  expect(
    normalizePersistedSessionEntryShape({
      sessionId: "session-1",
      updatedAt: 42,
      pendingTranscriptRepair: [
        {
          id: "repair-1",
          text: "recoverable assistant final",
          provider: "openai",
          model: "gpt-5.5",
          createdAt: 42,
        },
        {
          id: "repair-2",
          text: "second recoverable assistant final",
          createdAt: 43,
        },
      ],
    }),
  ).toMatchObject({
    pendingTranscriptRepair: [
      {
        id: "repair-1",
        text: "recoverable assistant final",
        provider: "openai",
        model: "gpt-5.5",
        createdAt: 42,
      },
      {
        id: "repair-2",
        text: "second recoverable assistant final",
        createdAt: 43,
      },
    ],
  });
});

it("drops a non-array assistant transcript repair value", () => {
  expect(
    normalizePersistedSessionEntryShape({
      sessionId: "session-1",
      updatedAt: 42,
      pendingTranscriptRepair: {
        id: "repair-1",
        text: "recoverable assistant final",
        createdAt: 42,
      },
    }),
  ).not.toHaveProperty("pendingTranscriptRepair");
});

it("drops malformed assistant transcript repair records", () => {
  expect(
    normalizePersistedSessionEntryShape({
      sessionId: "session-1",
      updatedAt: 42,
      pendingTranscriptRepair: [{ kind: "transport-only" }],
    }),
  ).not.toHaveProperty("pendingTranscriptRepair");
});

describe("session path safety", () => {
  it("preserves path-safe Unicode session IDs", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    for (const sessionId of ["volume-main-会議-000000", "volume-main-हिन्दी-000001"]) {
      expect(validateSessionId(sessionId)).toBe(sessionId);
      expect(normalizePersistedSessionEntryShape({ sessionId, updatedAt: 42 })).toMatchObject({
        sessionId,
        updatedAt: 42,
      });
      expect(resolveSessionTranscriptPathInDir(sessionId, sessionsDir)).toBe(
        path.resolve(sessionsDir, `${sessionId}.jsonl`),
      );
    }
  });

  it("rejects noncanonical Unicode session IDs", () => {
    for (const sessionId of ["session-Å", "session-A\u030A", "session-e\u0301"]) {
      expect(() => validateSessionId(sessionId), sessionId).toThrow(/Invalid session ID/);
      expect(normalizePersistedSessionEntryShape({ sessionId, updatedAt: 42 })).toBeUndefined();
    }
  });

  it("rejects unsafe session IDs", () => {
    const unsafeSessionIds = [
      "../etc/passwd",
      "a/b",
      "a\\b",
      "/abs",
      "session:legacy",
      "session-🙂",
      "sess.checkpoint.11111111-1111-4111-8111-111111111111",
      `session-${"会".repeat(82)}`,
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

  it("rejects topic-qualified transcript filenames over 255 bytes", () => {
    const sessionId = "会".repeat(82);

    expect(validateSessionId(sessionId)).toBe(sessionId);
    expect(() => resolveSessionTranscriptPathInDir(sessionId, "/tmp/sessions", 1)).toThrow(
      /Invalid session transcript filename/,
    );
  });

  it("falls back to derived path when sessionFile is outside known agent sessions dirs", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePathCore(
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
      const resolved = resolveSessionFilePathCore(
        "sess-1",
        { sessionFile: viaAlias },
        { sessionsDir },
      );
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

      const resolved = resolveSessionFilePathCore(
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

  it("keeps restart-recovery tombstones terminal when archive metadata is missing", () => {
    const entry = {
      sessionId: "failed-session",
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 4,
        chargedAttempts: 3,
        tombstone: {
          reason: "automatic recovery exhausted",
          recoveredSessionId: "dashboard-successor",
          recoveredSessionKey: "agent:main:dashboard:successor",
        },
      },
    };

    expect(resolveSessionWorkStartError("agent:main:matrix:channel:room-a", entry)).toContain(
      "ended during restart recovery",
    );
    expect(
      resolveSessionWorkStartError("agent:main:matrix:channel:room-a", {
        ...entry,
        modelSelectionLocked: true,
      }),
    ).toContain("Open it in WebChat and use Resume in new session");
    expect(
      resolveSessionWorkStartError("agent:main:matrix:channel:room-a", entry, {
        allowRestartTombstoneReplacement: true,
      }),
    ).toBeUndefined();
  });
});
