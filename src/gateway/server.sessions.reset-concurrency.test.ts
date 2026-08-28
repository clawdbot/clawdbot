// Session reset concurrency tests protect newer same-id lifecycle owners.
import { afterEach, expect, test, vi } from "vitest";
import { listRegisteredAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import { isSessionWorkStartInvalidatedError } from "../config/sessions/lifecycle.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../config/sessions/session-diff-baseline-capture.js";
import type { InternalSessionEntry, SessionDiffBaseline } from "../config/sessions/types.js";
import { ensureSessionDiffBaseline } from "../sessions/session-diff-baseline.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  sessionLifecycleHookMocks,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
  subagentLifecycleHookMocks,
  threadBindingMocks,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

type CaptureSessionDiffBaseline =
  (typeof import("../sessions/session-diff.js"))["captureSessionDiffBaseline"];
const captureMocks = vi.hoisted(() => ({
  capture: vi.fn<CaptureSessionDiffBaseline>(),
}));

vi.mock("../sessions/session-diff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessions/session-diff.js")>()),
  captureSessionDiffBaseline: captureMocks.capture,
}));

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
      workerPlacementContext: {},
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

test("sessions.reset fences an old same-id baseline completion with a fresh capture id", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:main";
  const sessionId = "sess-main";
  const oldClaim = createSessionDiffBaselineCaptureClaim();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(sessionId, {
        createdVia: "operator",
        sessionDiffBaselineCapture: oldClaim,
      } as Partial<InternalSessionEntry>),
    },
  });
  const capture = createDeferredCore<SessionDiffBaseline>();
  captureMocks.capture.mockReturnValueOnce(capture.promise);
  const oldEntry = loadSessionEntry({ sessionKey, storePath }) as InternalSessionEntry;
  const oldCompletion = ensureSessionDiffBaseline({
    cwd: "/workspace",
    entry: oldEntry,
    isNewSession: false,
    sessionKey,
    storePath,
  });
  const oldOutcome = Promise.allSettled([oldCompletion]);
  await vi.waitFor(() => expect(captureMocks.capture).toHaveBeenCalledOnce());
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  try {
    const reset = await performGatewaySessionReset({
      key: "main",
      reason: "new",
      commandSource: "gateway:agent",
      workerPlacementContext: {},
      armSessionDiffBaselineCapture: true,
    });
    expect(reset).toMatchObject({ ok: true, entry: { sessionId } });
    if (!reset.ok || "incognitoDeleted" in reset) {
      throw new Error("expected reset session entry");
    }
    expect(reset.entry).not.toHaveProperty("sessionDiffBaselineCapture");
    const afterReset = loadSessionEntry({ sessionKey, storePath }) as InternalSessionEntry;
    expect(afterReset.sessionDiffBaselineCapture?.captureId).not.toBe(oldClaim.captureId);
    expect(afterReset.sessionDiffBaselineCapture).toMatchObject({
      status: "pending",
    });

    capture.resolve({ version: 1, sessionId, root: "/workspace", files: [] });
    const [settled] = await oldOutcome;
    expect(settled?.status).toBe("rejected");
    if (settled?.status === "rejected") {
      expect(isSessionWorkStartInvalidatedError(settled.reason)).toBe(true);
      expect(String(settled.reason)).toMatch(/changed while starting work/i);
    }
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionDiffBaselineCapture: afterReset.sessionDiffBaselineCapture,
    });
    expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("sessionDiffBaseline");
  } finally {
    capture.resolve({ version: 1, sessionId, root: "/workspace", files: [] });
    await oldOutcome;
  }
});
