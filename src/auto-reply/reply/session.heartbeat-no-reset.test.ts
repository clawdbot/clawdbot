import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, saveSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { MsgContext } from "../templating.js";
import { initSessionState } from "./session.js";

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

describe("initSessionState - heartbeat should not trigger session reset", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp("/tmp/openclaw-test-");
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const createBaseConfig = (): OpenClawConfig => ({
    agents: {
      defaults: {
        workspace: tempDir,
      },
      list: [
        {
          id: "main",
          workspace: tempDir,
        },
      ],
    },
    session: {
      store: storePath,
      reset: {
        mode: "idle",
        idleMinutes: 5, // 5 minutes idle timeout
      },
    },
    channels: {},
    gateway: {
      port: 18789,
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: "test" },
    },
    plugins: {
      entries: {},
    },
  });

  const createBaseCtx = (overrides?: Partial<MsgContext>): MsgContext => ({
    Body: "test message",
    From: "user123",
    To: "bot123",
    SessionKey: "main:user123",
    Provider: "quietchat",
    Surface: "quietchat",
    ChatType: "direct",
    CommandAuthorized: true,
    ...overrides,
  });

  const saveExistingSession = async (
    sessionId: string,
    updatedAt: number,
    overrides: Partial<SessionEntry> = {},
  ): Promise<void> => {
    await saveSessionStore(storePath, {
      "main:user123": {
        sessionId,
        updatedAt,
        systemSent: true,
        ...overrides,
      },
    });
  };

  const expectPersistedSession = (sessionStore: Record<string, SessionEntry>): SessionEntry => {
    const entry = sessionStore["main:user123"];
    if (!entry) {
      throw new Error("Expected persisted session for main:user123");
    }
    return entry;
  };

  it("should NOT reset session when Provider is 'heartbeat'", async () => {
    // Setup: Create a session entry that is "stale" (older than idle timeout)
    const now = Date.now();
    const staleTime = now - 10 * 60 * 1000; // 10 minutes ago (exceeds 5min idle timeout)

    await saveExistingSession("original-session-id-12345", staleTime);

    const cfg = createBaseConfig();
    const ctx = createBaseCtx({
      Provider: "heartbeat", // Heartbeat provider should NOT trigger reset
      Body: "HEARTBEAT_OK",
    });

    const result = await initSessionState({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    // Assert: Session should NOT be reset (same sessionId)
    expect(result.isNewSession).toBe(false);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionId).toBe("original-session-id-12345");
    expect(result.sessionEntry.sessionId).toBe("original-session-id-12345");
  });

  it("should reset session when Provider is NOT 'heartbeat' and session is stale", async () => {
    // Setup: Create a session entry that is "stale" (older than idle timeout)
    const now = Date.now();
    const staleTime = now - 10 * 60 * 1000; // 10 minutes ago (exceeds 5min idle timeout)

    await saveExistingSession("original-session-id-12345", staleTime);

    const cfg = createBaseConfig();
    const ctx = createBaseCtx({
      Provider: "quietchat", // Regular provider - SHOULD trigger reset if stale
      Body: "test message",
    });

    const result = await initSessionState({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    // Assert: Session SHOULD be reset (new sessionId) because it's stale
    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false); // Not a manual reset, but idle reset
    expect(result.sessionId).not.toBe("original-session-id-12345");
  });

  it("should preserve session when Provider is 'heartbeat' even with daily reset mode", async () => {
    // Setup: Create a session entry from yesterday (would trigger daily reset)
    const now = Date.now();
    const yesterday = now - 25 * 60 * 60 * 1000; // 25 hours ago

    await saveExistingSession("original-session-id-67890", yesterday);

    const cfg = createBaseConfig();
    cfg.session!.reset = {
      mode: "daily",
      atHour: 4, // 4 AM daily reset
    };

    const ctx = createBaseCtx({
      Provider: "heartbeat",
      Body: "HEARTBEAT_OK",
    });

    const result = await initSessionState({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    // Assert: Session should NOT be reset even though it's past daily reset time
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("original-session-id-67890");
  });

  it("does not let heartbeat keep an expired daily session fresh for the next user message", async () => {
    const now = Date.now();
    const staleTime = now - 25 * 60 * 60 * 1000;

    await saveExistingSession("daily-session-id", now, {
      sessionStartedAt: staleTime,
      lastInteractionAt: staleTime,
    });

    const cfg = createBaseConfig();
    cfg.session!.reset = {
      mode: "daily",
      atHour: 4,
    };

    const heartbeatResult = await initSessionState({
      ctx: createBaseCtx({
        Provider: "heartbeat",
        Body: "HEARTBEAT_OK",
      }),
      cfg,
      commandAuthorized: true,
    });

    expect(heartbeatResult.isNewSession).toBe(false);
    expect(heartbeatResult.sessionId).toBe("daily-session-id");
    expect(heartbeatResult.sessionEntry.lastInteractionAt).toBe(staleTime);

    const persistedAfterHeartbeat = loadSessionStore(storePath);
    expect(expectPersistedSession(persistedAfterHeartbeat).lastInteractionAt).toBe(staleTime);

    const userResult = await initSessionState({
      ctx: createBaseCtx({
        Provider: "quietchat",
        Body: "real user message",
      }),
      cfg,
      commandAuthorized: true,
    });

    expect(userResult.isNewSession).toBe(true);
    expect(userResult.sessionId).not.toBe("daily-session-id");
  });

  it("resets legacy daily sessions using the JSONL header even when updatedAt is fresh", async () => {
    const now = Date.now();
    const staleTime = now - 25 * 60 * 60 * 1000;
    const sessionFile = path.join(tempDir, "legacy-daily-session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "legacy-daily-session",
        timestamp: new Date(staleTime).toISOString(),
        cwd: tempDir,
      })}\n`,
      "utf8",
    );
    await saveExistingSession("legacy-daily-session", now, {
      sessionFile,
      lastInteractionAt: staleTime,
    });

    const cfg = createBaseConfig();
    cfg.session!.reset = {
      mode: "daily",
      atHour: 4,
    };

    const result = await initSessionState({
      ctx: createBaseCtx({
        Provider: "quietchat",
        Body: "real user message",
      }),
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe("legacy-daily-session");
  });

  it("does not let heartbeat keep a legacy idle session fresh without lastInteractionAt", async () => {
    const now = Date.now();
    const staleTime = now - 10 * 60 * 1000;
    const sessionFile = path.join(tempDir, "legacy-idle-session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "legacy-idle-session",
        timestamp: new Date(staleTime).toISOString(),
        cwd: tempDir,
      })}\n`,
      "utf8",
    );
    await saveExistingSession("legacy-idle-session", now, {
      sessionFile,
    });

    const cfg = createBaseConfig();
    const heartbeatResult = await initSessionState({
      ctx: createBaseCtx({
        Provider: "heartbeat",
        Body: "HEARTBEAT_OK",
      }),
      cfg,
      commandAuthorized: true,
    });

    expect(heartbeatResult.isNewSession).toBe(false);
    expect(heartbeatResult.sessionId).toBe("legacy-idle-session");

    const persistedAfterHeartbeat = loadSessionStore(storePath);
    expect(expectPersistedSession(persistedAfterHeartbeat).lastInteractionAt).toBeUndefined();

    const userResult = await initSessionState({
      ctx: createBaseCtx({
        Provider: "quietchat",
        Body: "real user message",
      }),
      cfg,
      commandAuthorized: true,
    });

    expect(userResult.isNewSession).toBe(true);
    expect(userResult.sessionId).not.toBe("legacy-idle-session");
  });

  it("should handle cron-event provider same as heartbeat (no reset)", async () => {
    // Setup: Create a stale session
    const now = Date.now();
    const staleTime = now - 10 * 60 * 1000;

    await saveExistingSession("cron-session-id-abcde", staleTime);

    const cfg = createBaseConfig();
    const ctx = createBaseCtx({
      Provider: "cron-event", // Cron events should also NOT trigger reset
      Body: "cron job output",
    });

    const result = await initSessionState({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    // Assert: Session should NOT be reset for cron events either
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("cron-session-id-abcde");
  });

  it("should handle exec-event provider same as heartbeat (no reset)", async () => {
    // Setup: Create a stale session
    const now = Date.now();
    const staleTime = now - 10 * 60 * 1000;

    await saveExistingSession("exec-session-id-fghij", staleTime);

    const cfg = createBaseConfig();
    const ctx = createBaseCtx({
      Provider: "exec-event", // Exec events should also NOT trigger reset
      Body: "exec completion",
    });

    const result = await initSessionState({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    // Assert: Session should NOT be reset for exec events either
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("exec-session-id-fghij");
  });
});
