// Tests context passed to session lifecycle hooks.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import saveSessionMemory, {
  flushSessionMemoryWritesForTest,
} from "../../hooks/bundled/session-memory/handler.js";
import { clearInternalHooks, registerInternalHook } from "../../hooks/internal-hooks.js";
import type { HookRunner } from "../../plugins/hooks.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { emitResetCommandHooks } from "./commands-reset-hooks.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState as initSessionStateRaw } from "./session.js";

const initSessionState = (
  params: Omit<Parameters<typeof initSessionStateRaw>[0], "ctx"> & {
    ctx: Record<string, unknown>;
  },
) => initSessionStateRaw({ ...params, ctx: finalizeInboundContext(params.ctx) });

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runSessionStart: vi.fn<HookRunner["runSessionStart"]>(),
  runSessionEnd: vi.fn<HookRunner["runSessionEnd"]>(),
  runBeforeReset: vi.fn<HookRunner["runBeforeReset"]>(),
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
      runBeforeReset: hookRunnerMocks.runBeforeReset,
    }) as unknown as HookRunner,
}));

vi.mock("../../agents/harness/registry.js", () => ({
  resetRegisteredAgentHarnessSessions: sessionCleanupMocks.resetRegisteredAgentHarnessSessions,
}));

vi.mock("../../agents/agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: sessionCleanupMocks.retireSessionMcpRuntime,
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: sessionCleanupMocks.closeTrackedBrowserTabsForSessions,
}));

const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-session-hooks-" });

async function createStorePath(prefix: string): Promise<string> {
  const root = await suiteTempDirs.make(prefix);
  return path.join(root, "sessions.json");
}

async function writeStore(
  storePath: string,
  store: Record<string, SessionEntry | Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(store)) {
    const sessionEntry = entry as Partial<SessionEntry>;
    if (typeof sessionEntry.sessionId === "string" && sessionEntry.sessionId.trim()) {
      await replaceSessionEntry({ storePath, sessionKey }, sessionEntry as SessionEntry);
    }
  }
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

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function requireHookCall(
  mock: ReturnType<typeof vi.fn>,
  label: string,
): readonly [Record<string, unknown>, Record<string, unknown> | undefined] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} hook call`);
  }
  const [event, context] = call;
  if (!event || typeof event !== "object") {
    throw new Error(`expected ${label} hook event`);
  }
  if (context !== undefined && (!context || typeof context !== "object")) {
    throw new Error(`expected ${label} hook context`);
  }
  return [event as Record<string, unknown>, context as Record<string, unknown> | undefined];
}

describe("session hook context wiring", () => {
  beforeAll(async () => {
    await suiteTempDirs.setup();
  });

  afterAll(async () => {
    await suiteTempDirs.cleanup();
  });

  beforeEach(() => {
    resetGatewayWorkAdmission();
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runSessionStart.mockReset();
    hookRunnerMocks.runSessionEnd.mockReset();
    hookRunnerMocks.runBeforeReset.mockReset();
    sessionCleanupMocks.closeTrackedBrowserTabsForSessions.mockClear();
    sessionCleanupMocks.closeTrackedBrowserTabsForSessions.mockResolvedValue(0);
    sessionCleanupMocks.resetRegisteredAgentHarnessSessions.mockClear();
    sessionCleanupMocks.retireSessionMcpRuntime.mockClear();
    hookRunnerMocks.runSessionStart.mockResolvedValue(undefined);
    hookRunnerMocks.runSessionEnd.mockResolvedValue(undefined);
    hookRunnerMocks.runBeforeReset.mockResolvedValue(undefined);
    hookRunnerMocks.hasHooks.mockImplementation(
      (hookName) => hookName === "session_start" || hookName === "session_end",
    );
  });

  afterEach(() => {
    clearInternalHooks();
    resetGatewayWorkAdmission();
    vi.restoreAllMocks();
  });

  it.each(
    (["new", "reset", "daily", "idle"] as const).flatMap((reason) =>
      [false, true].map((projectionRepair) => ({ reason, projectionRepair })),
    ),
  )(
    "captures the retiring memory window before $reason (projection repair: $projectionRepair)",
    async ({ reason, projectionRepair }) => {
      const sessionKey = "agent:main:memory-reset";
      const sessionId = "memory-reset-session";
      const storePath = await createStorePath(`memory-${reason}`);
      const workspaceDir = path.join(path.dirname(storePath), "workspace");
      const automatic = reason === "daily" || reason === "idle";
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: workspaceDir } },
        hooks: { internal: { enabled: true, entries: { "session-memory": { enabled: true } } } },
        session: {
          store: storePath,
          ...(automatic
            ? { reset: reason === "daily" ? { mode: "daily" } : { mode: "idle", idleMinutes: 30 } }
            : {}),
        },
      };
      await writeStore(storePath, {
        [sessionKey]: { sessionId, updatedAt: Date.now() - (automatic ? 86_400_000 : 0) },
      });
      await replaceTranscriptEvents(
        { agentId: "main", sessionId, sessionKey, storePath },
        Array.from({ length: 20 }, (_, index) => ({
          type: "message",
          id: `message-${index}`,
          parentId: index === 0 ? null : `message-${index - 1}`,
          timestamp: new Date().toISOString(),
          message: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: `retiring-memory-${index}`,
          },
        })),
      );
      registerInternalHook(
        automatic ? "session:auto-reset" : `command:${reason}`,
        saveSessionMemory,
      );
      if (projectionRepair) {
        vi.spyOn(sessionAccessor, "readSessionTranscriptBoundedMessageTailPage").mockImplementation(
          () => {
            throw new sessionAccessor.SessionTranscriptProjectionUnavailableError(sessionId);
          },
        );
      }
      hookRunnerMocks.hasHooks.mockImplementation(
        (hookName) => !automatic && hookName === "before_reset",
      );

      try {
        const body = automatic ? "Start the next turn" : `/${reason}`;
        const ctx = { Body: body, SessionKey: sessionKey };
        const initialized = await initSessionState({ ctx, cfg, commandAuthorized: true });
        if (!automatic) {
          await emitResetCommandHooks({
            ...initialized,
            action: reason,
            agentId: "main",
            cfg,
            ctx,
            command: { surface: "webchat", channel: "webchat" },
            workspaceDir,
          });
        }
        await flushSessionMemoryWritesForTest();
        const memoryDir = path.join(workspaceDir, "memory");
        const files = await fs.readdir(memoryDir);
        expect(files).toHaveLength(1);
        const content = await fs.readFile(path.join(memoryDir, files[0]!), "utf8");
        expect(content).toContain('assistant: "retiring-memory-5"');
        expect(content).toContain('assistant: "retiring-memory-19"');
        expect(content).not.toContain('"retiring-memory-4"');
        if (!automatic) {
          expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledOnce();
          expect(hookRunnerMocks.runBeforeReset.mock.calls[0]?.[0].messages).toHaveLength(20);
          expect(hookRunnerMocks.runBeforeReset.mock.calls[0]?.[0].messages?.[0]).toMatchObject({
            content: "retiring-memory-0",
          });
        }
      } finally {
        await flushSessionMemoryWritesForTest();
      }
    },
  );

  it.each(["stale", "failed"] as const)(
    "does not publish a memory snapshot from a %s lifecycle commit",
    async (outcome) => {
      const sessionKey = "agent:main:memory-conflict";
      const storePath = await createStorePath("memory-conflict");
      const scope = { agentId: "main", sessionId: "retiring", sessionKey, storePath };
      await writeStore(storePath, {
        [sessionKey]: { sessionId: scope.sessionId, updatedAt: Date.now() - 86_400_000 },
      });
      await replaceTranscriptEvents(scope, [
        { type: "message", id: "old", parentId: null, message: { role: "user", content: "old" } },
      ]);
      const onReset = vi.fn();
      registerInternalHook("session:auto-reset", onReset);
      const read = vi.spyOn(sessionAccessor, "readSessionTranscriptBoundedMessageTailPage");
      const commit = sessionAccessor.commitReplySessionInitialization;
      vi.spyOn(sessionAccessor, "commitReplySessionInitialization").mockImplementationOnce(
        (params) =>
          commit({
            ...params,
            beforeEntryMutation: async (context) => {
              await params.beforeEntryMutation?.(context);
              if (outcome === "failed") {
                throw new Error("lifecycle commit failed");
              }
              sessionAccessor.replaceSessionEntrySync(scope, {
                sessionId: "replacement",
                updatedAt: Date.now(),
              });
            },
          }),
      );
      const initialized = initSessionState({
        ctx: { Body: "Continue", SessionKey: sessionKey },
        cfg: { session: { store: storePath, reset: { mode: "idle", idleMinutes: 30 } } },
        commandAuthorized: true,
      });
      if (outcome === "failed") {
        await expect(initialized).rejects.toThrow("lifecycle commit failed");
      } else {
        const result = await initialized;
        expect(result.sessionId).toBe("replacement");
        expect(result.previousSessionMemory).toBeUndefined();
      }
      expect(read).toHaveBeenCalledOnce();
      expect(onReset).not.toHaveBeenCalled();
    },
  );

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
    const [event, context] = requireHookCall(hookRunnerMocks.runSessionStart, "session_start");
    expectFields(event, { sessionKey });
    expectFields(context, { sessionKey, agentId: "main", sessionId: event?.sessionId });
  });

  it("starts the first reply lifecycle for a session created by admission without resetting it", async () => {
    const sessionKey = "agent:main:dashboard:admitted-goal";
    const sessionId = "admitted-session";
    const storePath = await createStorePath("openclaw-session-hook-admission");
    const now = Date.now();
    const seed: SessionEntry = {
      sessionId,
      lifecycleRevision: "admitted-generation",
      updatedAt: now,
      sessionStartedAt: now,
      ...buildSessionCreationStamp({
        via: "operator",
        actor: { type: "human", source: "profile", id: "profile-ada" },
        sandbox: "required",
        now,
      }),
      goal: {
        schemaVersion: 1,
        id: "admitted-goal",
        objective: "Start the first task",
        status: "active",
        createdAt: now,
        updatedAt: now,
        tokenStart: 0,
        tokensUsed: 0,
        continuationTurns: 0,
      },
    };
    await writeStore(storePath, { [sessionKey]: seed });
    const params = {
      ctx: { Body: seed.goal?.objective, SessionKey: sessionKey },
      cfg: { session: { store: storePath } } as OpenClawConfig,
      commandAuthorized: true,
      expectedExistingSessionId: sessionId,
      pinExpectedExistingSession: true,
    };
    const result = await initSessionState({ ...params, newlyCreatedSessionId: sessionId });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionCtx.IsNewSession).toBe("true");
    expect(result.resetTriggered).toBe(false);
    expect(result.previousSessionEntry).toBeUndefined();
    const preserved = {
      sessionId,
      lifecycleRevision: seed.lifecycleRevision,
      sessionStartedAt: now,
      goal: seed.goal,
      createdAt: now,
      createdActor: seed.createdActor,
      sandbox: "required",
    };
    expect(result.sessionEntry).toMatchObject(preserved);
    expect(loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" })).toMatchObject(
      preserved,
    );
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSessionEnd).not.toHaveBeenCalled();
    expectFields(requireHookCall(hookRunnerMocks.runSessionStart, "session_start")[0], {
      sessionKey,
      sessionId,
      resumedFrom: undefined,
    });

    const next = await initSessionState(params);
    expect(next.isNewSession).toBe(false);
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);
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
    const [event, context] = requireHookCall(hookRunnerMocks.runSessionEnd, "session_end");
    expectFields(event, {
      sessionKey,
      reason: "new",
    });
    expectFields(context, { sessionKey, agentId: "main", sessionId: event?.sessionId });

    const [startEvent, startContext] = requireHookCall(
      hookRunnerMocks.runSessionStart,
      "session_start",
    );
    expectFields(startEvent, { resumedFrom: "old-session" });
    expect(event?.nextSessionId).toBe("old-session");
    expect(startEvent?.sessionId).toBe("old-session");
    expectFields(startContext, { sessionId: startEvent?.sessionId });
  });

  it("keeps rollover hooks and browser cleanup root-admitted until they settle", async () => {
    const releases: Array<() => void> = [];
    const held = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    hookRunnerMocks.runSessionEnd.mockImplementationOnce(held);
    hookRunnerMocks.runSessionStart.mockImplementationOnce(held);
    sessionCleanupMocks.closeTrackedBrowserTabsForSessions.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          releases.push(() => resolve(0));
        }),
    );
    const sessionKey = "agent:main:telegram:direct:held-rollover";
    const { storePath } = await createStoredSession({
      prefix: "openclaw-session-hook-held-rollover",
      sessionKey,
      sessionId: "old-held-session",
    });

    await initSessionState({
      ctx: { Body: "/new", SessionKey: sessionKey },
      cfg: { session: { store: storePath } } as OpenClawConfig,
      commandAuthorized: true,
    });

    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(3));
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    for (const release of releases) {
      release();
    }
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("hands rollover hooks off after restart drain closes admission", async () => {
    const releases: Array<() => void> = [];
    const held = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    hookRunnerMocks.runSessionEnd.mockImplementationOnce(held);
    hookRunnerMocks.runSessionStart.mockImplementationOnce(held);
    sessionCleanupMocks.closeTrackedBrowserTabsForSessions.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          releases.push(() => resolve(0));
        }),
    );
    const sessionKey = "agent:main:telegram:direct:restart-handoff";
    const { storePath } = await createStoredSession({
      prefix: "openclaw-session-hook-restart-handoff",
      sessionKey,
      sessionId: "old-restart-session",
    });
    const admission = tryBeginGatewayRootWorkAdmission();
    expect(admission).not.toBeNull();

    await admission?.run(async () => {
      markGatewayRestartDraining();
      await initSessionState({
        ctx: { Body: "/new", SessionKey: sessionKey },
        cfg: { session: { store: storePath } } as OpenClawConfig,
        commandAuthorized: true,
      });
      await vi.waitFor(() => expect(releases).toHaveLength(3));
      expect(getActiveGatewayRootWorkCount()).toBe(4);
    });

    admission?.release();
    expect(getActiveGatewayRootWorkCount()).toBe(3);
    for (const release of releases) {
      release();
    }
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(hookRunnerMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);
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

    const [event] = requireHookCall(hookRunnerMocks.runSessionEnd, "session_end");
    expectFields(event, { reason: "reset" });
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

    const [event] = requireHookCall(hookRunnerMocks.runSessionEnd, "session_end");
    expectFields(event, { reason: "new" });
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
        reset: { mode: "daily" },
      });

      const [event] = requireHookCall(hookRunnerMocks.runSessionEnd, "session_end");
      const [startEvent] = requireHookCall(hookRunnerMocks.runSessionStart, "session_start");
      expectFields(event, {
        reason: "daily",
      });
      expect(event?.nextSessionId).toBe(startEvent?.sessionId);
      expect(startEvent?.sessionId).toBe("daily-session");
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

      const [event] = requireHookCall(hookRunnerMocks.runSessionEnd, "session_end");
      expectFields(event, { reason: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      reason: "daily",
      reset: { mode: "daily", atHour: 4 } as SessionResetConfig,
    },
    {
      reason: "idle",
      reset: { mode: "idle", idleMinutes: 30 } as SessionResetConfig,
    },
  ])("emits one session:auto-reset event for $reason rollover", async ({ reason, reset }) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const listener = vi.fn();
      registerInternalHook("session:auto-reset", listener);
      const sessionKey = `agent:main:telegram:direct:auto-${reason}`;
      await initStoredSessionState({
        prefix: `openclaw-session-auto-${reason}`,
        sessionKey,
        sessionId: `auto-${reason}-session`,
        text: reason,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        reset,
      });

      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
      const [event] = listener.mock.calls[0] ?? [];
      expectFields(event, {
        type: "session",
        action: "auto-reset",
        sessionKey,
      });
      expectFields((event as { context?: Record<string, unknown> }).context, {
        reason,
        nextSessionKey: sessionKey,
      });
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

      const [event] = requireHookCall(hookRunnerMocks.runSessionEnd, "session_end");
      expectFields(event, { reason: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });
});
