// Tests heartbeat messages do not reset active session routing.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { MsgContext } from "../templating.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState as initSessionStateRaw } from "./session.js";

const initSessionState = (
  params: Omit<Parameters<typeof initSessionStateRaw>[0], "ctx"> & {
    ctx: MsgContext;
  },
) => initSessionStateRaw({ ...params, ctx: finalizeInboundContext(params.ctx) });

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

describe("initSessionState - heartbeat should not trigger session reset", () => {
  const sessionKey = "agent:main:main:user123";
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
    SessionKey: sessionKey,
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
    await replaceSessionEntry(
      {
        storePath,
        sessionKey,
      },
      {
        sessionId,
        updatedAt,
        systemSent: true,
        ...overrides,
      },
    );
  };

  const expectPersistedSession = (): SessionEntry => {
    const entry = loadSessionEntry({ storePath, sessionKey });
    if (!entry) {
      throw new Error(`Expected persisted session for ${sessionKey}`);
    }
    return entry;
  };

  it.each(["heartbeat", "cron", "exec"] as const)(
    "does not reset a stale session for an internal %s turn",
    async (source) => {
      // Setup: Create a session entry that is "stale" (older than idle timeout)
      const now = Date.now();
      const staleTime = now - 10 * 60 * 1000; // 10 minutes ago (exceeds 5min idle timeout)

      await saveExistingSession("original-session-id-12345", staleTime);

      const cfg = createBaseConfig();
      const ctx = createBaseCtx({
        InternalTurnSource: source,
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
    },
  );

  it("resets a stale session for a user turn", async () => {
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

    // Assert: Session SHOULD reset in place because it's stale.
    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false); // Not a manual reset, but idle reset
    expect(result.sessionId).toBe("original-session-id-12345");
  });

  it("preserves the session for an internal heartbeat with daily reset mode", async () => {
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
      InternalTurnSource: "heartbeat",
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
        InternalTurnSource: "heartbeat",
        Body: "HEARTBEAT_OK",
      }),
      cfg,
      commandAuthorized: true,
    });

    expect(heartbeatResult.isNewSession).toBe(false);
    expect(heartbeatResult.sessionId).toBe("daily-session-id");
    expect(heartbeatResult.sessionEntry.lastInteractionAt).toBe(staleTime);

    expect(expectPersistedSession().lastInteractionAt).toBe(staleTime);

    const userResult = await initSessionState({
      ctx: createBaseCtx({
        Provider: "quietchat",
        Body: "real user message",
      }),
      cfg,
      commandAuthorized: true,
    });

    expect(userResult.isNewSession).toBe(true);
    expect(userResult.sessionId).toBe("daily-session-id");
  });
});
