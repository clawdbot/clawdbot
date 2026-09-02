import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveSessionEntryResetFreshness } from "./entry-freshness.js";
import {
  appendTranscriptEvent,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("resolveSessionEntryResetFreshness", () => {
  let tempDirs: string[] = [];
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDirs = [];
    tempDir = makeTempDir(tempDirs, "openclaw-session-entry-freshness-");
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("returns missing state with a resolved reset policy for absent entries", () => {
    const result = resolveSessionEntryResetFreshness({
      sessionKey: "agent:main:missing:thread:100.000",
      storePath,
      sessionCfg: {},
      resetType: "thread",
      now: new Date("2026-01-02T12:00:00Z").getTime(),
    });

    expect(result).toMatchObject({
      state: "missing",
      entry: undefined,
      freshness: undefined,
      resetType: "thread",
      resetPolicy: {
        mode: "none",
        atHour: 4,
      },
    });
  });

  it("uses the configured default agent for an unqualified session key", async () => {
    const sessionKey = "global";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    await upsertSessionEntryCore(
      { agentId: "ops", defaultAgentId: "ops", sessionKey, storePath },
      {
        sessionId: "session-global-ops",
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
      },
    );

    const result = resolveSessionEntryResetFreshness({
      defaultAgentId: "ops",
      sessionKey,
      storePath,
      sessionCfg: {},
      resetType: "direct",
      now,
    });

    expect(result.state).toBe("fresh");
    expect(result.entry?.sessionId).toBe("session-global-ops");
  });

  it("resolves stale daily freshness from lifecycle timestamps instead of activity", async () => {
    const sessionKey = "agent:main:main:thread:100.000";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: "session-stale-thread",
        updatedAt: now,
        sessionStartedAt: now - 2 * DAY_MS,
        lastInteractionAt: now - 2 * DAY_MS,
      },
    );

    const result = resolveSessionEntryResetFreshness({
      sessionKey,
      storePath,
      sessionCfg: { reset: { mode: "daily" } },
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("stale");
    expect(result.entry?.sessionId).toBe("session-stale-thread");
    expect(result.resetType).toBe("thread");
    expect(result.freshness).toMatchObject({
      fresh: false,
      staleReason: "daily",
    });
  });

  it("keeps provider-owned sessions fresh when reset policy is implicit", async () => {
    const sessionKey = "agent:main:main:thread:provider-owned";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: "session-provider-owned",
        updatedAt: now,
        sessionStartedAt: now - 2 * DAY_MS,
        lastInteractionAt: now - 2 * DAY_MS,
        providerOverride: "claude-cli",
        cliSessionBindings: {
          "claude-cli": { sessionId: "cli-session-provider-owned" },
        },
      },
    );

    const result = resolveSessionEntryResetFreshness({
      sessionKey,
      storePath,
      sessionCfg: {},
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("fresh");
    expect(result.freshness).toMatchObject({ fresh: true });
  });

  it("applies configured reset policies to provider-owned sessions", async () => {
    const sessionKey = "agent:main:main:thread:provider-owned-configured";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: "session-provider-owned-configured",
        updatedAt: now,
        sessionStartedAt: now - 2 * DAY_MS,
        lastInteractionAt: now - 2 * DAY_MS,
        providerOverride: "claude-cli",
        cliSessionBindings: {
          "claude-cli": { sessionId: "cli-session-provider-owned-configured" },
        },
      },
    );

    const result = resolveSessionEntryResetFreshness({
      sessionKey,
      storePath,
      sessionCfg: { reset: { mode: "daily" } },
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("stale");
    expect(result.freshness).toMatchObject({
      fresh: false,
      staleReason: "daily",
    });
  });

  it("resolves fresh daily freshness for active lifecycle timestamps", async () => {
    const sessionKey = "agent:main:main";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: "session-fresh",
        updatedAt: now,
        sessionStartedAt: now - 60_000,
        lastInteractionAt: now - 60_000,
      },
    );

    const result = resolveSessionEntryResetFreshness({
      sessionKey,
      storePath,
      sessionCfg: {},
      resetType: "direct",
      now,
    });

    expect(result.state).toBe("fresh");
    expect(result.entry?.sessionId).toBe("session-fresh");
    expect(result.resetType).toBe("direct");
    expect(result.freshness).toMatchObject({ fresh: true });
  });

  it("honors reset overrides when resolving entry freshness", async () => {
    const sessionKey = "agent:main:main:thread:idle";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: "session-idle-stale",
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now - 60 * 60 * 1000,
      },
    );

    const result = resolveSessionEntryResetFreshness({
      sessionKey,
      storePath,
      sessionCfg: { reset: { mode: "daily" } },
      resetOverride: { mode: "idle", idleMinutes: 30 },
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("stale");
    expect(result.resetPolicy).toMatchObject({
      mode: "idle",
      idleMinutes: 30,
    });
    expect(result.freshness).toMatchObject({
      fresh: false,
      staleReason: "idle",
    });
  });

  it("resolves the store path from session config", async () => {
    const sessionKey = "agent:main:main:thread:configured-store";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    const configuredStorePath = path.join(tempDir, "configured-sessions.json");
    await upsertSessionEntryCore(
      { sessionKey, storePath: configuredStorePath },
      {
        sessionId: "session-configured-store",
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now - 60 * 60 * 1000,
      },
    );

    const result = resolveSessionEntryResetFreshness({
      sessionKey,
      sessionCfg: { store: configuredStorePath, reset: { mode: "idle", idleMinutes: 30 } },
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("stale");
    expect(result.entry?.sessionId).toBe("session-configured-store");
    expect(result.resetPolicy).toMatchObject({
      mode: "idle",
      idleMinutes: 30,
    });
    expect(result.freshness).toMatchObject({
      fresh: false,
      staleReason: "idle",
    });
  });

  it("uses the SQLite transcript header when lifecycle metadata is missing", async () => {
    const sessionKey = "agent:main:main:thread:header";
    const sessionId = "session-header-fallback";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    const headerTimestamp = new Date(now - 2 * DAY_MS).toISOString();
    const target = { agentId: "main", sessionId, sessionKey, storePath };
    const entry = await replaceSessionEntry(target, { sessionId, updatedAt: now });
    expect(entry?.sessionStartedAt).toBeUndefined();
    await appendTranscriptEvent(target, {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: headerTimestamp,
      cwd: tempDir,
    });

    const result = resolveSessionEntryResetFreshness({
      sessionKey,
      storePath,
      sessionCfg: { reset: { mode: "daily" } },
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("stale");
    expect(result.lifecycleTimestamps.sessionStartedAt).toBe(Date.parse(headerTimestamp));
    expect(result.freshness).toMatchObject({ fresh: false, staleReason: "daily" });
  });
});
