import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { saveSessionStore } from "../../config/sessions/store.js";
import type { MsgContext } from "../templating.js";
import { initSessionState } from "./session.js";

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

  const saveExistingSession = async (sessionId: string, updatedAt: number): Promise<void> => {
    await saveSessionStore(storePath, {
      "main:user123": {
        sessionId,
        updatedAt,
        systemSent: true,
      },
    });
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
