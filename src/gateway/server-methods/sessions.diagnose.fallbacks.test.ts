import { afterEach, expect, test } from "vitest";
import type { SessionsDiagnoseResult } from "../../../packages/gateway-protocol/src/index.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
} from "../../agents/embedded-agent-runner/run-state.js";
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
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "../test/server-sessions.test-helpers.js";

const { createSelectedGlobalSessionStore } = setupGatewaySessionsTestHarness();

afterEach(() => {
  ACTIVE_EMBEDDED_RUNS.clear();
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.clear();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticSessionStateForTest();
});

test("sessions.diagnose scopes shared-id embedded evidence before ranking global rows", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  await writeSessionStore({
    storePath: mainStorePath,
    entries: {
      global: sessionStoreEntry("sess-shared-global", { updatedAt: 10 }),
    },
  });
  await writeSessionStore({
    storePath: workStorePath,
    agentId: "work",
    entries: {
      global: sessionStoreEntry("sess-shared-global", { updatedAt: 20 }),
    },
  });
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.set(
    "main:global",
    "sess-shared-global",
  );
  ACTIVE_EMBEDDED_RUNS.set("sess-shared-global", {
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => {},
  });

  const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {
    includeGlobal: true,
  });

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    chosenBecause: "highest live or contradictory evidence score",
    session: {
      key: "global",
      sessionId: "sess-shared-global",
      agentId: "main",
      hasActiveRun: true,
    },
    live: {
      embeddedRun: {
        active: true,
        sessionId: "sess-shared-global",
      },
    },
  });
});

test("sessions.diagnose omits ambiguous process-wide evidence for multi-agent fallback rows", async () => {
  const { workStorePath } = await createSelectedGlobalSessionStore();
  await writeSessionStore({
    storePath: workStorePath,
    agentId: "work",
    entries: {
      global: sessionStoreEntry("sess-work-global", { updatedAt: 20 }),
    },
  });
  const state = getDiagnosticSessionState({
    sessionId: "sess-work-global",
    sessionKey: "global",
  });
  state.state = "processing";
  state.queueDepth = 2;
  markDiagnosticRunProgressForTest({
    sessionId: "sess-work-global",
    sessionKey: "global",
    reason: "model_call:stream",
  });
  registerAgentRunContext("ownerless-global-lifecycle", {
    isControlUiVisible: false,
    projectSessionActive: true,
    sessionId: "sess-work-global",
    sessionKey: "global",
  });
  try {
    const result = await directSessionReq<SessionsDiagnoseResult>(
      "sessions.diagnose",
      {
        key: "global",
        agentId: "work",
      },
      {
        context: {
          chatAbortControllers: new Map([
            [
              "ownerless-global-controller",
              {
                controller: new AbortController(),
                sessionId: "sess-work-global",
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
    const payload = result.payload;
    if (!payload) {
      throw new Error("expected diagnose payload");
    }
    expect(payload.session).toMatchObject({
      key: "global",
      sessionId: "sess-work-global",
      agentId: "work",
      hasActiveRun: false,
    });
    expect(payload.live.gatewayRun).toEqual({ hasActiveRun: false, runs: [] });
    expect(payload.live).not.toHaveProperty("diagnostic");
    expect(payload.live).not.toHaveProperty("lane");
  } finally {
    clearAgentRunContext("ownerless-global-lifecycle");
  }
});

test("sessions.diagnose scopes unknown fallback active runs to the requested agent", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  const now = Date.now();
  await writeSessionStore({
    storePath: mainStorePath,
    entries: {
      unknown: sessionStoreEntry("sess-main-unknown", { updatedAt: 10 }),
    },
  });
  await writeSessionStore({
    storePath: workStorePath,
    agentId: "work",
    entries: {
      unknown: sessionStoreEntry("sess-work-unknown", { updatedAt: 20 }),
    },
  });

  const result = await directSessionReq<SessionsDiagnoseResult>(
    "sessions.diagnose",
    { key: "unknown", agentId: "work" },
    {
      context: {
        chatAbortControllers: new Map([
          [
            "run-main-unknown",
            {
              controller: new AbortController(),
              sessionId: "sess-main-unknown",
              sessionKey: "unknown",
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
  const payload = result.payload;
  if (!payload) {
    throw new Error("expected diagnose payload");
  }
  const gatewayRun = payload.live.gatewayRun;
  if (!gatewayRun) {
    throw new Error("expected gateway run diagnosis");
  }
  expect(payload.outcome).toBe("diagnosed");
  expect(payload.session).toMatchObject({
    key: "unknown",
    sessionId: "sess-work-unknown",
    agentId: "work",
    hasActiveRun: false,
  });
  expect(gatewayRun.hasActiveRun).toBe(false);
  expect(gatewayRun.runs).toEqual([]);
  expect(payload.nextChecks).toEqual([
    "openclaw sessions --agent work tail --session-key unknown",
    "openclaw sessions --agent work export-trajectory --session-key unknown",
    "openclaw health --verbose",
  ]);
});
