import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  type SessionsDiagnoseResult,
  validateSessionsDiagnoseResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
} from "../../agents/embedded-agent-runner/run-state.js";
import type { SessionEntry } from "../../config/sessions.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { markDiagnosticRunProgressForTest } from "../../logging/diagnostic-run-activity.test-support.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../logging/diagnostic-session-state.js";
import { writeSessionStore } from "../test-helpers.js";
import {
  directSessionReq,
  seedLinearSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
  writeSingleLineSession,
} from "../test/server-sessions.test-helpers.js";

vi.mock("../../plugins/host-hook-state.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/host-hook-state.js")>(
    "../../plugins/host-hook-state.js",
  );
  return {
    ...actual,
    projectPluginSessionExtensionsSync: () => [],
  };
});

const { createSessionStoreDir, createSelectedGlobalSessionStore } =
  setupGatewaySessionsTestHarness();

afterEach(() => {
  ACTIVE_EMBEDDED_RUNS.clear();
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.clear();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticSessionStateForTest();
});

test("sessions.diagnose returns read-only live and stored evidence without transcript paths", async () => {
  const { dir } = await createSessionStoreDir();
  const sessionFile = path.join(dir, "sess-main.jsonl");
  await writeSingleLineSession(dir, "sess-main", "private prompt text should stay out");
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        sessionFile,
        status: "running",
      }),
    },
  });

  const result = await directSessionReq<SessionsDiagnoseResult>(
    "sessions.diagnose",
    { key: "agent:main:main" },
    {
      context: {
        chatAbortControllers: new Map([
          [
            "run-1",
            {
              controller: new AbortController(),
              sessionId: "sess-main",
              sessionKey: "agent:main:main",
              agentId: "main",
              ownerConnId: "conn-secret",
              startedAtMs: Date.now() - 1_000,
              expiresAtMs: Date.now() + 60_000,
              kind: "agent",
            },
          ],
        ]),
      },
    },
  );

  expect(result.ok).toBe(true);
  if (!result.payload) {
    throw new Error("expected sessions.diagnose payload");
  }
  expect(validateSessionsDiagnoseResult(result.payload)).toBe(true);
  expect(result.payload.live.lane).not.toHaveProperty("blockedBy");
  expect(result.payload).toMatchObject({
    ok: true,
    outcome: "diagnosed",
    session: {
      found: true,
      key: "agent:main:main",
      sessionId: "sess-main",
      hasActiveRun: true,
    },
    live: {
      gatewayRun: {
        hasActiveRun: true,
      },
    },
  });
  const serialized = JSON.stringify(result.payload);
  expect(serialized).not.toContain(sessionFile);
  expect(serialized).not.toContain("private prompt text should stay out");
  expect(serialized).not.toContain("ownerConnId");
  expect(serialized).not.toContain("conn-secret");
});

test("sessions.diagnose picks a visible active session beyond the bounded newest scan", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  const entries: Record<string, SessionEntry> = {
    "agent:main:stuck": sessionStoreEntry("sess-stuck", {
      status: "running",
      updatedAt: 1,
    }),
  };
  for (let index = 0; index < 105; index += 1) {
    entries[`agent:main:newer-${index}`] = sessionStoreEntry(`sess-newer-${index}`, {
      updatedAt: now + index,
    });
  }
  await writeSessionStore({ entries });

  const result = await directSessionReq<SessionsDiagnoseResult>(
    "sessions.diagnose",
    {},
    {
      context: {
        chatAbortControllers: new Map([
          [
            "run-stuck",
            {
              controller: new AbortController(),
              sessionId: "sess-stuck",
              sessionKey: "agent:main:stuck",
              agentId: "main",
              startedAtMs: now - 1_000,
              expiresAtMs: now + 60_000,
              kind: "agent",
            },
          ],
        ]),
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    chosenBecause: "highest live or contradictory evidence score",
    session: {
      key: "agent:main:stuck",
      sessionId: "sess-stuck",
      hasActiveRun: true,
    },
  });
});

test("sessions.diagnose picks a session-id-only active session beyond the bounded newest scan", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  const entries: Record<string, SessionEntry> = {
    "agent:main:stuck": sessionStoreEntry("sess-stuck", {
      status: "running",
      updatedAt: 1,
    }),
  };
  for (let index = 0; index < 105; index += 1) {
    entries[`agent:main:newer-${index}`] = sessionStoreEntry(`sess-newer-${index}`, {
      updatedAt: now + index,
    });
  }
  await writeSessionStore({ entries });

  const result = await directSessionReq<SessionsDiagnoseResult>(
    "sessions.diagnose",
    {},
    {
      context: {
        chatAbortControllers: new Map([
          [
            "run-stuck",
            {
              controller: new AbortController(),
              sessionId: "sess-stuck",
              agentId: "main",
              startedAtMs: now - 1_000,
              expiresAtMs: now + 60_000,
              kind: "agent",
            },
          ],
        ]),
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    chosenBecause: "highest live or contradictory evidence score",
    session: {
      key: "agent:main:stuck",
      sessionId: "sess-stuck",
      hasActiveRun: true,
    },
    live: {
      gatewayRun: {
        hasActiveRun: true,
        runs: [
          {
            runId: "run-stuck",
            sessionId: "sess-stuck",
            sessionKey: "agent:main:stuck",
            agentId: "main",
          },
        ],
      },
    },
  });
});

test("sessions.diagnose picks a lifecycle-projected active session beyond the bounded newest scan", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  const entries: Record<string, SessionEntry> = {
    "agent:main:projected": sessionStoreEntry("sess-projected", {
      status: "running",
      updatedAt: 1,
    }),
  };
  for (let index = 0; index < 105; index += 1) {
    entries[`agent:main:newer-${index}`] = sessionStoreEntry(`sess-newer-${index}`, {
      updatedAt: now + index,
    });
  }
  await writeSessionStore({ entries });
  registerAgentRunContext("run-projected", {
    isControlUiVisible: false,
    projectSessionActive: true,
    sessionId: "sess-projected",
    sessionKey: "agent:main:projected",
    agentId: "main",
  });
  try {
    const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {});

    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      outcome: "diagnosed",
      chosenBecause: "highest live or contradictory evidence score",
      session: {
        key: "agent:main:projected",
        sessionId: "sess-projected",
        hasActiveRun: true,
      },
      live: {
        gatewayRun: {
          hasActiveRun: true,
          runs: [],
        },
      },
    });
  } finally {
    clearAgentRunContext("run-projected");
  }
});

test("sessions.diagnose keeps processing-only evidence through final selection", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:processing": sessionStoreEntry("sess-processing", {
        status: "running",
        updatedAt: 1,
      }),
      "agent:main:newest": sessionStoreEntry("sess-newest", {
        updatedAt: 2,
      }),
    },
  });
  const state = getDiagnosticSessionState({
    sessionId: "sess-processing",
    sessionKey: "agent:main:processing",
  });
  state.state = "processing";
  state.queueDepth = 0;
  state.lastActivity = Date.now();

  const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {});

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    chosenBecause: "highest live or contradictory evidence score",
    session: {
      key: "agent:main:processing",
      sessionId: "sess-processing",
    },
    live: {
      diagnostic: {
        state: "processing",
      },
    },
  });
});

test("sessions.diagnose keeps terminal live contradictions before the candidate cap", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  const entries: Record<string, SessionEntry> = {
    "agent:main:contradiction": sessionStoreEntry("sess-contradiction", {
      status: "done",
      endedAt: now - 1_000,
      updatedAt: 1,
    }),
  };
  const chatAbortControllers = new Map([
    [
      "run-contradiction",
      {
        controller: new AbortController(),
        sessionId: "sess-contradiction",
        sessionKey: "agent:main:contradiction",
        agentId: "main",
        startedAtMs: now - 2_000,
        expiresAtMs: now + 60_000,
        kind: "agent" as const,
      },
    ],
  ]);
  for (let index = 0; index < 105; index += 1) {
    const sessionKey = `agent:main:active-${index}`;
    const sessionId = `sess-active-${index}`;
    entries[sessionKey] = sessionStoreEntry(sessionId, {
      status: "running",
      updatedAt: now + index,
    });
    chatAbortControllers.set(`run-active-${index}`, {
      controller: new AbortController(),
      sessionId,
      sessionKey,
      agentId: "main",
      startedAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
      kind: "agent" as const,
    });
  }
  await writeSessionStore({ entries });

  const result = await directSessionReq<SessionsDiagnoseResult>(
    "sessions.diagnose",
    {},
    {
      context: { chatAbortControllers },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    chosenBecause: "highest live or contradictory evidence score",
    session: {
      key: "agent:main:contradiction",
      sessionId: "sess-contradiction",
      status: "done",
      hasActiveRun: true,
    },
    findings: expect.arrayContaining([
      expect.objectContaining({ code: "store_terminal_but_live_processing" }),
    ]),
  });
});

test("sessions.diagnose does not preselect a stale row from a conflicting keyed run id", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      "agent:main:stale": sessionStoreEntry("sess-shared", {
        status: "running",
        updatedAt: 1,
      }),
      "agent:main:newest": sessionStoreEntry("sess-newest", {
        updatedAt: 2,
      }),
    },
  });

  const result = await directSessionReq<SessionsDiagnoseResult>(
    "sessions.diagnose",
    {},
    {
      context: {
        chatAbortControllers: new Map([
          [
            "run-other",
            {
              controller: new AbortController(),
              sessionId: "sess-shared",
              sessionKey: "agent:main:other",
              agentId: "main",
              startedAtMs: now - 1_000,
              expiresAtMs: now + 60_000,
              kind: "agent",
            },
          ],
        ]),
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    chosenBecause: "newest stored session",
    session: {
      key: "agent:main:newest",
      sessionId: "sess-newest",
      hasActiveRun: false,
    },
    live: {
      gatewayRun: {
        hasActiveRun: false,
        runs: [],
      },
    },
  });
});

test("sessions.diagnose picks an embedded active session beyond the bounded newest scan", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  const entries: Record<string, SessionEntry> = {
    "agent:main:embedded": sessionStoreEntry("sess-embedded", {
      status: "running",
      updatedAt: 1,
    }),
  };
  for (let index = 0; index < 105; index += 1) {
    entries[`agent:main:newer-${index}`] = sessionStoreEntry(`sess-newer-${index}`, {
      updatedAt: now + index,
    });
  }
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set("agent:main:embedded", "sess-embedded");
  ACTIVE_EMBEDDED_RUNS.set("sess-embedded", {
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => {},
  });
  await writeSessionStore({ entries });

  const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {});

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    chosenBecause: "highest live or contradictory evidence score",
    session: {
      key: "agent:main:embedded",
      sessionId: "sess-embedded",
      hasActiveRun: true,
    },
    live: {
      embeddedRun: {
        active: true,
        streaming: true,
      },
    },
  });
});

test("sessions.diagnose ignores stale completed progress when choosing default target", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:old": sessionStoreEntry("sess-old", { updatedAt: 1 }),
      "agent:main:new": sessionStoreEntry("sess-new", { updatedAt: 2 }),
    },
  });

  const nowSpy = vi.spyOn(Date, "now");
  try {
    nowSpy.mockReturnValue(1_700_000_000_000);
    markDiagnosticRunProgressForTest({
      sessionId: "sess-old",
      sessionKey: "agent:main:old",
      reason: "run.completed",
    });
    nowSpy.mockReturnValue(1_700_000_130_000);

    const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {});

    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      outcome: "diagnosed",
      chosenBecause: "newest stored session",
      session: { key: "agent:main:new", sessionId: "sess-new" },
    });
  } finally {
    nowSpy.mockRestore();
  }
});

test("sessions.diagnose reports no_sessions when no stored sessions exist", async () => {
  await createSessionStoreDir();
  await writeSessionStore({ entries: {} });

  const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {});

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    ok: true,
    outcome: "no_sessions",
    session: { found: false },
  });
});

test("sessions.diagnose matches label and session-id selectors from stored entries", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:ops": sessionStoreEntry("sess-ops", {
        label: "ops",
        status: "running",
        updatedAt: 10,
      }),
    },
  });

  const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {
    label: "ops",
  });

  expect(result.ok).toBe(true);
  const payload = result.payload;
  if (!payload) {
    throw new Error("expected diagnose payload");
  }
  expect(payload).toMatchObject({
    outcome: "diagnosed",
    chosenBecause: "explicit label selector",
    session: {
      key: "agent:main:ops",
      sessionId: "sess-ops",
      label: "ops",
      status: "running",
      hasActiveRun: false,
    },
  });

  const sessionIdResult = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {
    sessionId: "sess-ops",
  });
  expect(sessionIdResult.ok).toBe(true);
  expect(sessionIdResult.payload).toMatchObject({
    outcome: "diagnosed",
    chosenBecause: "explicit session id selector",
    session: {
      key: "agent:main:ops",
      sessionId: "sess-ops",
    },
  });
});

test("sessions.diagnose returns low confidence when no dominant signal exists", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-quiet", {
        status: "running",
        updatedAt: 10,
      }),
    },
  });
  await seedLinearSessionTranscript({
    contents: ["quiet transcript line"],
    sessionId: "sess-quiet",
    sessionKey: "agent:main:main",
    storePath,
  });

  const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {
    key: "agent:main:main",
  });

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    summary: {
      state: "unknown",
      confidence: "low",
      headline: "No dominant stuck-session signal was found from the available evidence.",
    },
    findings: [
      expect.objectContaining({
        code: "unknown_low_confidence",
      }),
    ],
  });
});

test("sessions.diagnose uses the warning headline for stalled active sessions", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        status: "running",
        updatedAt: 10,
      }),
    },
  });

  const nowSpy = vi.spyOn(Date, "now");
  try {
    nowSpy.mockReturnValue(1_700_000_000_000);
    markDiagnosticRunProgressForTest({
      runId: "run-main",
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      reason: "tool.running",
    });
    nowSpy.mockReturnValue(1_700_000_130_000);

    const result = await directSessionReq<SessionsDiagnoseResult>(
      "sessions.diagnose",
      { key: "agent:main:main" },
      {
        context: {
          chatAbortControllers: new Map([
            [
              "run-main",
              {
                controller: new AbortController(),
                sessionId: "sess-main",
                sessionKey: "agent:main:main",
                agentId: "main",
                startedAtMs: Date.now() - 1_000,
                expiresAtMs: Date.now() + 60_000,
                kind: "agent",
              },
            ],
          ]),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      summary: {
        state: "stalled",
        confidence: "medium",
        headline: "Active work exists, but diagnostic progress has not advanced recently.",
      },
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "active_run_visible" }),
        expect.objectContaining({ code: "last_progress_stale" }),
      ]),
    });
  } finally {
    nowSpy.mockRestore();
  }
});

test("sessions.diagnose marks terminal sessions with partial delivery route as uncertain", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        endedAt: Date.now(),
        delivery: {
          kind: "external",
          route: { channel: "telegram" },
          context: { channel: "telegram" },
          origin: { provider: "telegram" },
        },
        status: "done",
      }),
    },
  });

  const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {
    key: "agent:main:main",
  });

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    delivery: {
      uncertain: true,
      lastChannel: "telegram",
    },
    findings: expect.arrayContaining([
      expect.objectContaining({
        code: "delivery_uncertain",
      }),
    ]),
  });
});

test("sessions.diagnose excludes global and unknown fallback rows unless opted in", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", { updatedAt: 10 }),
      global: sessionStoreEntry("sess-global", { updatedAt: 30 }),
      unknown: sessionStoreEntry("sess-unknown", { updatedAt: 50 }),
    },
  });

  const defaultResult = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {});
  expect(defaultResult.ok).toBe(true);
  expect(defaultResult.payload).toMatchObject({
    outcome: "diagnosed",
    session: { key: "agent:main:main", sessionId: "sess-main" },
  });

  const globalResult = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {
    includeGlobal: true,
  });
  expect(globalResult.ok).toBe(true);
  expect(globalResult.payload).toMatchObject({
    outcome: "diagnosed",
    session: { key: "global", sessionId: "sess-global" },
    live: {
      diagnostic: { present: false },
      lane: { lane: "session:global" },
    },
  });

  const unknownResult = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {
    includeUnknown: true,
  });
  expect(unknownResult.ok).toBe(true);
  expect(unknownResult.payload).toMatchObject({
    outcome: "diagnosed",
    session: { key: "unknown", sessionId: "sess-unknown" },
  });
});

test("sessions.diagnose keeps the source agent for global fallback rows", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  const now = Date.now();
  await writeSessionStore({
    storePath: mainStorePath,
    entries: {
      global: sessionStoreEntry("sess-main-global", { updatedAt: 10 }),
    },
  });
  await writeSessionStore({
    storePath: workStorePath,
    agentId: "work",
    entries: {
      global: sessionStoreEntry("sess-work-global", { updatedAt: 20 }),
    },
  });
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set("global", "sess-main-global");
  const fallbackIndex = ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY;
  fallbackIndex.set("main:global", "sess-main-global");
  fallbackIndex.set("work:global", "sess-work-global");
  ACTIVE_EMBEDDED_RUNS.set("sess-main-global", {
    queueMessage: async () => {},
    isStreaming: () => false,
    isCompacting: () => false,
    abort: () => {},
  });
  ACTIVE_EMBEDDED_RUNS.set("sess-work-global", {
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => {},
  });

  const result = await directSessionReq<SessionsDiagnoseResult>(
    "sessions.diagnose",
    { includeGlobal: true },
    {
      context: {
        chatAbortControllers: new Map([
          [
            "run-work-global",
            {
              controller: new AbortController(),
              sessionId: "sess-work-global",
              sessionKey: "global",
              agentId: "work",
              startedAtMs: now - 1_000,
              expiresAtMs: now + 60_000,
              kind: "agent",
            },
          ],
        ]),
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    session: {
      key: "global",
      sessionId: "sess-work-global",
      agentId: "work",
      hasActiveRun: true,
    },
    live: {
      gatewayRun: {
        hasActiveRun: true,
        runs: [expect.objectContaining({ agentId: "work" })],
      },
      embeddedRun: {
        active: true,
        sessionId: "sess-work-global",
        streaming: true,
      },
    },
    nextChecks: [
      "openclaw sessions --agent work tail --session-key global",
      "openclaw sessions --agent work export-trajectory --session-key global",
      "openclaw health --verbose",
    ],
  });
});

test("sessions.diagnose rejects key agent mismatch with agentId", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const result = await directSessionReq("sessions.diagnose", {
    key: "agent:work:main",
    agentId: "main",
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "session key agent does not match agentId",
    },
  });
});

test("sessions.diagnose rejects ambiguous label selectors", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      first: sessionStoreEntry("sess-first", { label: "ops" }),
      second: sessionStoreEntry("sess-second", { label: "ops" }),
    },
  });

  const result = await directSessionReq("sessions.diagnose", { label: "ops" });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("multiple sessions match label ops"),
    },
  });
});

test("sessions.diagnose rejects ambiguous label selectors across agent global rows", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  await writeSessionStore({
    storePath: mainStorePath,
    entries: {
      global: sessionStoreEntry("sess-main-global", { label: "ops", updatedAt: 1 }),
    },
  });
  await writeSessionStore({
    storePath: workStorePath,
    agentId: "work",
    entries: {
      global: sessionStoreEntry("sess-work-global", { label: "ops", updatedAt: 2 }),
    },
  });

  const result = await directSessionReq("sessions.diagnose", { label: "ops" });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("multiple sessions match label ops"),
    },
  });
});

test("sessions.diagnose rejects ambiguous session-id selectors", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      first: sessionStoreEntry("sess-shared"),
      second: sessionStoreEntry("sess-shared"),
    },
  });

  const result = await directSessionReq("sessions.diagnose", { sessionId: "sess-shared" });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("multiple sessions match sessionId sess-shared"),
    },
  });
});

test("sessions.diagnose rejects ambiguous session-id selectors across agent unknown rows", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  await writeSessionStore({
    storePath: mainStorePath,
    entries: {
      unknown: sessionStoreEntry("sess-shared", { updatedAt: 1 }),
    },
  });
  await writeSessionStore({
    storePath: workStorePath,
    agentId: "work",
    entries: {
      unknown: sessionStoreEntry("sess-shared", { updatedAt: 2 }),
    },
  });

  const result = await directSessionReq("sessions.diagnose", { sessionId: "sess-shared" });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("multiple sessions match sessionId sess-shared"),
    },
  });
});

test("sessions.diagnose rejects multiple primary selectors", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", { label: "ops" }),
    },
  });

  const result = await directSessionReq("sessions.diagnose", {
    key: "agent:main:main",
    label: "ops",
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("choose only one of key, sessionId, or label"),
    },
  });
});
