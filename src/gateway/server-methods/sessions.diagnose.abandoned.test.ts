import { afterEach, expect, test } from "vitest";
import type { SessionsDiagnoseResult } from "../../../packages/gateway-protocol/src/index.js";
import {
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
} from "../../agents/embedded-agent-runner/run-state.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "../../logging/diagnostic-session-state.js";
import { writeSessionStore } from "../test-helpers.js";
import {
  directSessionReq,
  seedLinearSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "../test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

afterEach(() => {
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.clear();
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticSessionStateForTest();
});

test("sessions.diagnose classifies timed-out abandoned embedded runs as stalled", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-timeout", {
        status: "running",
        updatedAt: 10,
      }),
    },
  });
  await seedLinearSessionTranscript({
    contents: ["timeout transcript line"],
    sessionId: "sess-timeout",
    sessionKey: "agent:main:main",
    storePath,
  });
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set("sess-timeout", {
    sessionId: "sess-timeout",
    sessionKey: "agent:main:main",
    abandonedAtMs: 1_700_000_000_000,
    reason: "timeout",
  });
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set("agent:main:main", "sess-timeout");

  const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {
    key: "agent:main:main",
  });

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    summary: {
      state: "stalled",
      confidence: "medium",
      headline: "The embedded run was abandoned after timing out.",
    },
    live: {
      embeddedRun: {
        active: false,
        abandoned: {
          sessionId: "sess-timeout",
          sessionKey: "agent:main:main",
          abandonedAtMs: 1_700_000_000_000,
          reason: "timeout",
        },
      },
    },
    findings: [
      expect.objectContaining({
        code: "embedded_run_abandoned_timeout",
        severity: "warn",
      }),
    ],
  });
});
