// Covers durable restart recovery of the terminal continue_work outcome against
// the real SQLite task-flow registry, the real session-delivery queue, and the
// real gateway delivery path.
//
// The in-memory system-event queue is explicitly non-durable, so these tests
// deliberately avoid mocking either store or the delivery executor: they persist
// a terminal row, discard all process-local state, reload from disk, and then
// assert through the production recovery/delivery/acknowledgement path.
import { describe, expect, it, vi } from "vitest";
import { deliverQueuedSessionDelivery } from "../../gateway/server-restart-sentinel.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { scheduleSessionDelivery } from "../../infra/session-delivery-queue-runtime.js";
import {
  ackSessionDelivery,
  enqueueSessionDelivery,
  loadPendingSessionDeliveries,
} from "../../infra/session-delivery-queue-storage.js";
import { recoverPendingSessionDeliveries } from "../../infra/session-delivery-queue.js";
import {
  drainSystemEventEntries,
  enqueueSystemEvent,
  peekSystemEvents,
} from "../../infra/system-events.js";
import { reloadTaskFlowRegistryFromStore } from "../../tasks/task-flow-registry.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  enqueuePendingWork,
  listPendingTerminalNoticeWork,
  markPendingWorkFailed,
} from "./work-store.js";
import {
  CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE,
  deliverPendingTerminalNotice,
  drainPendingTerminalNotices,
} from "./work-terminal-notice.js";

const SESSION_KEY = "agent:main:terminal-notice-durability";
const RAW_DRIVER_ERROR =
  "provider rejected token sk-live-9f3c1d2b7a at https://api.example/v1/messages";

/**
 * Real production collaborators, pinned to the temp state dir. Nothing here is
 * mocked: the point of these tests is that the durable stores carry the notice.
 */
function realDeps(stateDir: string) {
  return {
    enqueueSessionDelivery,
    scheduleSessionDelivery,
    enqueueSystemEvent,
    requestHeartbeatNow,
    stateDir,
  };
}

async function withDurableState<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-continuation-terminal-notice-" },
    async (state) => {
      resetTaskFlowRegistryForTests();
      try {
        return await run(state.stateDir);
      } finally {
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

/**
 * Terminalize a claimed row exactly as the retry-exhaustion branch does: the
 * notice obligation is written in the same CAS as the failure.
 */
function terminalizeWithPendingNotice(): void {
  const enqueued = enqueuePendingWork({
    sessionKey: SESSION_KEY,
    hop: 2,
    delayMs: 0,
    electedAt: Date.now(),
    dueAt: Date.now(),
    maxChainLength: 8,
    reason: "durable exhaustion proof",
  });
  if (!enqueued) {
    throw new Error("expected durable continuation work row");
  }
  const failed = markPendingWorkFailed(enqueued, RAW_DRIVER_ERROR, {
    terminalNoticePending: "retry-exhausted",
  });
  if (!failed) {
    throw new Error("expected terminal CAS to commit");
  }
}

/** Drop every process-local trace of the notice, as a gateway restart would. */
function simulateGatewayRestart(): void {
  drainSystemEventEntries(SESSION_KEY);
  reloadTaskFlowRegistryFromStore();
}

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * Drive the REAL gateway delivery executor over every pending row, exactly as
 * startup recovery does. `deps` is unused by the systemEvent branch.
 */
async function runProductionDeliveryRecovery(stateDir: string): Promise<void> {
  await recoverPendingSessionDeliveries({
    deliver: (entry, context = {}) =>
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry,
        ...(context.stateDir !== undefined ? { stateDir: context.stateDir } : {}),
      }),
    stateDir,
    log: silentLog(),
  });
}

async function pendingDeliveryTexts(stateDir: string): Promise<string[]> {
  const pending = await loadPendingSessionDeliveries(stateDir);
  return pending.map((entry) => (entry.kind === "systemEvent" ? entry.text : entry.kind));
}

describe("continuation_work terminal notice durability", () => {
  it("persists the terminal failure and its pending notice across a restart", async () => {
    await withDurableState(async () => {
      terminalizeWithPendingNotice();
      simulateGatewayRestart();

      const pending = listPendingTerminalNoticeWork();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.sessionKey).toBe(SESSION_KEY);
      expect(pending[0]?.terminalNoticePending).toBe("retry-exhausted");
    });
  });

  it("keeps the durable row pending through the real delivery path until the prompt adopts it", async () => {
    await withDurableState(async (stateDir) => {
      terminalizeWithPendingNotice();
      expect(await drainPendingTerminalNotices(realDeps(stateDir))).toBe(1);

      // Crash after the handoff but before the prompt ever consumed the event.
      simulateGatewayRestart();
      expect(peekSystemEvents(SESSION_KEY)).toEqual([]);

      // The REAL delivery executor re-enqueues the event in memory. It must NOT
      // complete the durable row: process memory is not durable.
      await runProductionDeliveryRecovery(stateDir);

      expect(peekSystemEvents(SESSION_KEY)).toEqual([CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE]);
      expect(await pendingDeliveryTexts(stateDir)).toEqual([
        CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE,
      ]);

      // Crash again before consumption: the notice must still replay.
      simulateGatewayRestart();
      expect(peekSystemEvents(SESSION_KEY)).toEqual([]);
      await runProductionDeliveryRecovery(stateDir);
      expect(peekSystemEvents(SESSION_KEY)).toEqual([CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE]);
    });
  });

  it("completes the durable row only after prompt adoption acknowledges it, then stops replaying", async () => {
    await withDurableState(async (stateDir) => {
      terminalizeWithPendingNotice();
      await drainPendingTerminalNotices(realDeps(stateDir));
      const [queued] = await loadPendingSessionDeliveries(stateDir);
      const deliveryId = queued?.id;
      expect(deliveryId).toBeDefined();

      // The prompt path acks by delivery id once the event is actually adopted.
      await ackSessionDelivery(deliveryId as string, stateDir);
      expect(await loadPendingSessionDeliveries(stateDir)).toEqual([]);

      // After adoption, restart + recovery must produce NO further outcome, and
      // the completed tombstone must reject a re-enqueue of the same notice.
      simulateGatewayRestart();
      await runProductionDeliveryRecovery(stateDir);
      expect(peekSystemEvents(SESSION_KEY)).toEqual([]);

      expect(await drainPendingTerminalNotices(realDeps(stateDir))).toBe(0);
      expect(await loadPendingSessionDeliveries(stateDir)).toEqual([]);
    });
  });

  it("never lets a losing concurrent handoff complete the winner's shared row", async () => {
    await withDurableState(async (stateDir) => {
      terminalizeWithPendingNotice();
      const [owed] = listPendingTerminalNoticeWork();
      if (!owed) {
        throw new Error("expected a pending terminal notice");
      }

      // Two handoffs race on the same flow. Both resolve the same deterministic
      // delivery id, so the "loser" is looking at the winner's only row.
      const [first, second] = await Promise.all([
        deliverPendingTerminalNotice(owed, realDeps(stateDir)),
        deliverPendingTerminalNotice(owed, realDeps(stateDir)),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
      // The shared row survives: the loser must not acknowledge or complete it.
      expect(await pendingDeliveryTexts(stateDir)).toEqual([
        CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE,
      ]);
      expect(listPendingTerminalNoticeWork()).toEqual([]);

      // And it is still deliverable through the production path.
      simulateGatewayRestart();
      await runProductionDeliveryRecovery(stateDir);
      expect(peekSystemEvents(SESSION_KEY)).toEqual([CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE]);
    });
  });

  it("schedules a notice recovered after the startup queue scan instead of waiting for traffic", async () => {
    await withDurableState(async (stateDir) => {
      terminalizeWithPendingNotice();
      simulateGatewayRestart();

      // Startup scans the delivery queue BEFORE continuation recovery runs, so
      // at scan time this notice is flag-only with no queue row to arm.
      expect(await loadPendingSessionDeliveries(stateDir)).toEqual([]);
      expect(listPendingTerminalNoticeWork()).toHaveLength(1);

      const scheduled: string[] = [];
      const wakes: { sessionKey?: string }[] = [];
      const handed = await drainPendingTerminalNotices({
        ...realDeps(stateDir),
        scheduleSessionDelivery: async (id: string) => {
          scheduled.push(id);
          return true;
        },
        requestHeartbeatNow: ((opts?: { sessionKey?: string }) => {
          wakes.push(opts ?? {});
        }) as typeof requestHeartbeatNow,
      });

      expect(handed).toBe(1);
      const [queued] = await loadPendingSessionDeliveries(stateDir);
      // The row created after the scan is actively armed and its target woken.
      expect(scheduled).toEqual([queued?.id]);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.sessionKey).toBe(SESSION_KEY);
    });
  });

  it("cannot produce a duplicate outcome across repeated recovery", async () => {
    await withDurableState(async (stateDir) => {
      terminalizeWithPendingNotice();
      const deps = realDeps(stateDir);

      expect(await drainPendingTerminalNotices(deps)).toBe(1);

      simulateGatewayRestart();
      expect(await drainPendingTerminalNotices(deps)).toBe(0);
      simulateGatewayRestart();
      expect(await drainPendingTerminalNotices(deps)).toBe(0);

      expect(listPendingTerminalNoticeWork()).toEqual([]);
      expect(await loadPendingSessionDeliveries(stateDir)).toHaveLength(1);
    });
  });

  it("never exposes the raw driver error to the agent", async () => {
    await withDurableState(async (stateDir) => {
      terminalizeWithPendingNotice();
      await drainPendingTerminalNotices(realDeps(stateDir));
      simulateGatewayRestart();
      await runProductionDeliveryRecovery(stateDir);

      const durableText = (await pendingDeliveryTexts(stateDir))[0] ?? "";
      const promptText = peekSystemEvents(SESSION_KEY)[0] ?? "";
      for (const text of [durableText, promptText]) {
        expect(text).toBe(CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE);
        expect(text).not.toContain("sk-live-9f3c1d2b7a");
        expect(text).not.toContain("https://api.example");
        expect(text).not.toContain("provider rejected token");
      }
    });
  });
});
