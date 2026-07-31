// Session reset concurrency tests protect newer same-id lifecycle owners.
import { afterEach, expect, test } from "vitest";
import {
  listRegisteredAgentHarnesses,
  registerAgentHarness,
  restoreRegisteredAgentHarnesses,
} from "../agents/harness/registry.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  sessionLifecycleHookMocks,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
  subagentLifecycleHookMocks,
  threadBindingMocks,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test("sessions.reset preserves a concurrent same-id lifecycle replacement", async () => {
  const registeredHarnesses = listRegisteredAgentHarnesses();
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", { lifecycleRevision: "original-revision" }),
    },
  });
  let lifecycleCurrent = true;
  registerAgentHarness({
    id: "reset-race-observer",
    label: "Reset race observer",
    supports: () => ({ supported: false }),
    runAttempt: async () => {
      throw new Error("not used");
    },
    reset: async () => {
      lifecycleCurrent = false;
      await writeSessionStore({
        entries: {
          main: sessionStoreEntry("sess-main", {
            label: "newer owner",
            lifecycleRevision: "replacement-revision",
          }),
        },
      });
    },
  });
  const { performGatewaySessionReset } = await import("./session-reset-service.js");

  try {
    const reset = await performGatewaySessionReset({
      key: "main",
      reason: "new",
      commandSource: "gateway:agent",
      assertCurrent: () => {
        if (!lifecycleCurrent) {
          throw new Error("stale lifecycle");
        }
      },
    });

    expect(reset).toMatchObject({
      ok: true,
      entry: {
        label: "newer owner",
        lifecycleRevision: "replacement-revision",
        sessionId: "sess-main",
      },
    });
    expect(
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath,
      }),
    ).toEqual([]);
    expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
    expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();
  } finally {
    restoreRegisteredAgentHarnesses(registeredHarnesses);
  }
});
