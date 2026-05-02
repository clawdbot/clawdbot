import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { HookRunner } from "../../plugins/hooks.js";
import { initSessionState } from "./session.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runSessionStart: vi.fn<HookRunner["runSessionStart"]>(),
  runSessionEnd: vi.fn<HookRunner["runSessionEnd"]>(),
}));
const sessionCleanupMocks = vi.hoisted(() => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
  resetRegisteredAgentHarnessSessions: vi.fn(async () => undefined),
  retireSessionMcpRuntime: vi.fn(async () => false),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: hookRunnerMocks.hasHooks,
      runSessionStart: hookRunnerMocks.runSessionStart,
      runSessionEnd: hookRunnerMocks.runSessionEnd,
    }) as unknown as HookRunner,
}));

vi.mock("../../agents/harness/registry.js", () => ({
  resetRegisteredAgentHarnessSessions: sessionCleanupMocks.resetRegisteredAgentHarnessSessions,
}));

vi.mock("../../agents/pi-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: sessionCleanupMocks.retireSessionMcpRuntime,
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: sessionCleanupMocks.closeTrackedBrowserTabsForSessions,
}));

vi.mock("../../agents/session-write-lock.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/session-write-lock.js")>(
    "../../agents/session-write-lock.js",
  );
  return {
    ...actual,
    acquireSessionWriteLock: vi.fn(async () => ({ release: async () => {} })),
    resolveSessionLockMaxHoldFromTimeout: vi.fn(
      ({
        timeoutMs,
        graceMs = 2 * 60 * 1000,
        minMs = 5 * 60 * 1000,
      }: {
        timeoutMs: number;
        graceMs?: number;
        minMs?: number;
      }) => Math.max(minMs, timeoutMs + graceMs),
    ),
  };
});

async function createStorePath(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(root, "sessions.json");
}

async function writeStore(
  storePath: string,
  store: Record<string, SessionEntry | Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
}

async function writeTranscript(
  storePath: string,
  sessionId: string,
  text = "hello",
): Promise<string> {
  const transcriptPath = path.join(path.dirname(storePath), `${sessionId}.jsonl`);
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "message",
      id: `${sessionId}-m1`,
      message: { role: "user", content: text },
    })}\n`,
    "utf-8",
  );
  return transcriptPath;
}

async function createStoredSession(params: {
  prefix: string;
  sessionKey: string;
  sessionId: string;
  text?: string;
  updatedAt?: number;
}): Promise<{ storePath: string; transcriptPath: string }> {
  const storePath = await createStorePath(params.prefix);
  const transcriptPath = await writeTranscript(storePath, params.sessionId, params.text);
  await writeStore(storePath, {
    [params.sessionKey]: {
      sessionId: params.sessionId,
      sessionFile: transcriptPath,
      updatedAt: params.updatedAt ?? Date.now(),
    },
  });
  return { storePath, transcriptPath };
}

type SessionResetConfig = NonNullable<NonNullable<OpenClawConfig["session"]>["reset"]>;

async function initStoredSessionState(params: {
  prefix: string;
  sessionKey: string;
  sessionId: string;
  text: string;
  updatedAt: number;
  reset?: SessionResetConfig;
}): Promise<void> {
  const { storePath } = await createStoredSession(params);
  const cfg = {
    session: {
      store: storePath,
      ...(params.reset ? { reset: params.reset } : {}),
    },
  } as OpenClawConfig;

  await initSessionState({
    ctx: { Body: "hello", SessionKey: params.sessionKey },
    cfg,
    commandAuthorized: true,
  });
}

describe("session hook context wiring", () => {
  beforeEach(() => {
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runSessionStart.mockReset();
    hookRunnerMocks.runSessionEnd.mockReset();
    sessionCleanupMocks.closeTrackedBrowserTabsForSessions.mockClear();
    sessionCleanupMocks.resetRegisteredAgentHarnessSessions.mockClear();
    sessionCleanupMocks.retireSessionMcpRuntime.mockClear();
    hookRunnerMocks.runSessionStart.mockResolvedValue(undefined);
    hookRunnerMocks.runSessionEnd.mockResolvedValue(undefined);
    hookRunnerMocks.hasHooks.mockImplementation(
      (hookName) => hookName === "session_start" || hookName === "session_end",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes sessionKey to session_start hook context", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const storePath = await createStorePath("openclaw-session-hook-start");
    await writeStore(storePath, {});
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);
    const [event, context] = hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];
    expect(event).toMatchObject({ sessionKey });
    expect(context).toMatchObject({ sessionKey, agentId: "main" });
    expect(context).toMatchObject({ sessionId: event?.sessionId });
  });

  it("passes sessionKey to session_end hook context on reset", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const { storePath } = await createStoredSession({
      prefix: "openclaw-session-hook-end",
      sessionKey,
      sessionId: "old-session",
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "/new", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(hookRunnerMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);
    const [event, context] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      sessionKey,
      reason: "new",
      transcriptArchived: true,
    });
    expect(context).toMatchObject({ sessionKey, agentId: "main" });
    expect(context).toMatchObject({ sessionId: event?.sessionId });
    expect(event?.sessionFile).toContain(".jsonl.reset.");

    const [startEvent, startContext] = hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];
    expect(startEvent).toMatchObject({ resumedFrom: "old-session" });
    expect(event?.nextSessionId).toBe(startEvent?.sessionId);
    expect(startContext).toMatchObject({ sessionId: startEvent?.sessionId });
  });

  it("marks explicit /reset rollovers with reason reset", async () => {
    const sessionKey = "agent:main:telegram:direct:456";
    const { storePath } = await createStoredSession({
      prefix: "openclaw-session-hook-explicit-reset",
      sessionKey,
      sessionId: "reset-session",
      text: "reset me",
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "/reset", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({ reason: "reset" });
  });

  it("maps custom reset trigger aliases to the new-session reason", async () => {
    const sessionKey = "agent:main:telegram:direct:alias";
    const { storePath } = await createStoredSession({
      prefix: "openclaw-session-hook-reset-alias",
      sessionKey,
      sessionId: "alias-session",
      text: "alias me",
    });
    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/fresh"],
      },
    } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "/fresh", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({ reason: "new" });
  });

  it("marks daily stale rollovers and exposes the archived transcript path", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const sessionKey = "agent:main:telegram:direct:daily";
      await initStoredSessionState({
        prefix: "openclaw-session-hook-daily",
        sessionKey,
        sessionId: "daily-session",
        text: "daily",
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      });

      const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
      const [startEvent] = hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];
      expect(event).toMatchObject({
        reason: "daily",
        transcriptArchived: true,
      });
      expect(event?.sessionFile).toContain(".jsonl.reset.");
      expect(event?.nextSessionId).toBe(startEvent?.sessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks idle stale rollovers with reason idle", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const sessionKey = "agent:main:telegram:direct:idle";
      await initStoredSessionState({
        prefix: "openclaw-session-hook-idle",
        sessionKey,
        sessionId: "idle-session",
        text: "idle",
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        reset: {
          mode: "idle",
          idleMinutes: 30,
        },
      });

      const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
      expect(event).toMatchObject({ reason: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers idle over daily when both rollover conditions are true", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
      const sessionKey = "agent:main:telegram:direct:overlap";
      await initStoredSessionState({
        prefix: "openclaw-session-hook-overlap",
        sessionKey,
        sessionId: "overlap-session",
        text: "overlap",
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
        reset: {
          mode: "daily",
          atHour: 4,
          idleMinutes: 30,
        },
      });

      const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
      expect(event).toMatchObject({ reason: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });
});
