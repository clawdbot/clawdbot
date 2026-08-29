// Covers durable restart recovery of the terminal continue_work outcome against
// the real SQLite task-flow registry, the real session-delivery queue, and the
// real gateway delivery path.
//
// The in-memory system-event queue is explicitly non-durable, so these tests
// deliberately avoid mocking either store or the delivery executor: they persist
// a terminal row, discard all process-local state, reload from disk, and then
// assert through the production recovery/delivery/acknowledgement path.
import { describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { deliverQueuedSessionDelivery } from "../../gateway/server-restart-sentinel.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { recoverPendingSessionDeliveries } from "../../infra/session-delivery-queue-recovery.js";
import { scheduleSessionDelivery } from "../../infra/session-delivery-queue-runtime.js";
import {
  enqueueSessionDeliveryWithStatus,
  loadPendingSessionDeliveries,
} from "../../infra/session-delivery-queue-storage.js";
import {
  drainSystemEventEntries,
  enqueueSystemEventRaw as enqueueSystemEvent,
  peekSystemEvents,
} from "../../infra/system-events.js";
import {
  listTaskFlowRecords,
  reloadTaskFlowRegistryFromStore,
  updateFlowRecordByIdExpectedRevision,
} from "../../tasks/task-flow-registry.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { settleManagedSystemEventsAfterTurnAdoption } from "../reply/session-system-event-adoption.js";
import { prepareFormattedSystemEvents } from "../reply/session-system-events.js";
import { CONTINUATION_WORK_CONTROLLER_ID } from "./work-flow-state.js";
import {
  enqueuePendingWork,
  listPendingTerminalNoticeWork,
  markPendingWorkFailed,
} from "./work-store.js";
import {
  CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE,
  deliverPendingTerminalNotice,
  deliverPendingTerminalNoticeWithRetry,
  drainPendingTerminalNotices,
  resetTerminalNoticeRetriesForTests,
  TERMINAL_NOTICE_RETRY_DELAYS_MS,
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
    enqueueSessionDeliveryWithStatus,
    scheduleSessionDelivery,
    enqueueSystemEvent,
    requestHeartbeatNow,
    stateDir,
  };
}

/**
 * Run the REAL prompt preparation, then the REAL adoption settlement, exactly
 * as get-reply-run-admission + get-reply-run-execute compose them: preparation
 * hands back managed deliveries, the recorder stamps the adopted ack ids onto
 * the persisted user turn, and settlement acks only what that turn adopted.
 */
async function preparePrompt(stateDir: string) {
  return await prepareFormattedSystemEvents({
    cfg: { session: { store: stateDir } } as never,
    agentId: "main",
    sessionKey: SESSION_KEY,
    isMainSession: true,
    isNewSession: false,
  });
}

async function adoptPreparedTurn(
  prepared: Awaited<ReturnType<typeof preparePrompt>>,
): Promise<void> {
  // The persisted user turn records which delivery ids it adopted; settlement
  // acks exactly those and nothing else.
  await settleManagedSystemEventsAfterTurnAdoption({
    deliveries: prepared.managedDeliveries,
    persistedMessage: {
      __openclaw: {
        sessionDeliveryAckIds: prepared.managedDeliveries.map((delivery) => delivery.id),
      },
    },
  });
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

/**
 * Re-arm the durable obligation on an already-terminal row, simulating a stale
 * flag observed after the delivery row was settled.
 */
function restorePendingNoticeFlag(): void {
  const flow = listTaskFlowRecords().find(
    (record) => record.controllerId === CONTINUATION_WORK_CONTROLLER_ID,
  );
  if (!flow) {
    throw new Error("expected a continuation work flow");
  }
  const state = flow.stateJson as Record<string, unknown>;
  const updated = updateFlowRecordByIdExpectedRevision({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    patch: { stateJson: { ...state, terminalNoticePending: "retry-exhausted" } },
  });
  if (!updated.applied) {
    throw new Error("expected stale-flag restore to commit");
  }
}

/** Drop every process-local trace of the notice, as a gateway restart would. */
function simulateGatewayRestart(): void {
  drainSystemEventEntries(SESSION_KEY);
  reloadTaskFlowRegistryFromStore();
}

const SESSION_ID = "session-terminal-notice-1";

/** Create the real session entry prepareFormattedSystemEvents resolves. */
async function seedSessionEntry(stateDir: string): Promise<void> {
  await replaceSessionEntry(
    {
      storePath: resolveSessionStorePathCore(stateDir, { agentId: "main" }),
      sessionKey: SESSION_KEY,
    },
    {
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      updatedAt: Date.now(),
      status: "done",
    } as never,
  );
}

/**
 * Persist a user turn that records the adopted delivery ids, exactly as the
 * transcript recorder does, WITHOUT acking the queue rows — the crash window
 * between transcript adoption and queue settlement.
 */
async function persistAdoptedTurnWithoutQueueAck(
  stateDir: string,
  deliveryIds: readonly string[],
): Promise<void> {
  await appendTranscriptMessage(
    {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      storePath: resolveSessionStorePathCore(stateDir, { agentId: "main" }),
    } as never,
    {
      message: {
        role: "user",
        content: "adopted turn",
        timestamp: Date.now(),
        __openclaw: { sessionDeliveryAckIds: [...deliveryIds] },
      },
    } as never,
  );
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

  it("keeps the durable row pending through REAL prompt preparation until the turn is adopted", async () => {
    await withDurableState(async (stateDir) => {
      terminalizeWithPendingNotice();
      await drainPendingTerminalNotices(realDeps(stateDir));
      simulateGatewayRestart();
      await runProductionDeliveryRecovery(stateDir);

      // Real prompt preparation surfaces the notice to the model AND hands back
      // an adoption-scoped delivery instead of acking during preparation.
      const prepared = await preparePrompt(stateDir);
      expect(
        prepared.blocks.some((block) => block.text.includes("continue_work permanently failed")),
      ).toBe(true);
      expect(prepared.managedDeliveries.map((delivery) => delivery.id)).toEqual([
        (await loadPendingSessionDeliveries(stateDir))[0]?.id,
      ]);
      // Preparation must NOT have completed the durable row.
      expect(await pendingDeliveryTexts(stateDir)).toEqual([
        CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE,
      ]);

      // Admission fails / process dies after preparation but before adoption.
      simulateGatewayRestart();
      await runProductionDeliveryRecovery(stateDir);
      expect(peekSystemEvents(SESSION_KEY)).toEqual([CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE]);
      expect(await pendingDeliveryTexts(stateDir)).toEqual([
        CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE,
      ]);
    });
  });

  it("completes the durable row only once a prepared turn is durably adopted, then stops replaying", async () => {
    await withDurableState(async (stateDir) => {
      terminalizeWithPendingNotice();
      await drainPendingTerminalNotices(realDeps(stateDir));
      simulateGatewayRestart();
      await runProductionDeliveryRecovery(stateDir);

      const prepared = await preparePrompt(stateDir);
      expect(prepared.managedDeliveries).toHaveLength(1);
      await adoptPreparedTurn(prepared);

      // Adoption is what settles the row.
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

  it("clears a stale work flag against a completed tombstone without a second event or wake", async () => {
    await withDurableState(async (stateDir) => {
      terminalizeWithPendingNotice();
      await drainPendingTerminalNotices(realDeps(stateDir));
      simulateGatewayRestart();
      await runProductionDeliveryRecovery(stateDir);
      await adoptPreparedTurn(await preparePrompt(stateDir));
      expect(await loadPendingSessionDeliveries(stateDir)).toEqual([]);

      // A stale obligation is observed after the row was already settled.
      restorePendingNoticeFlag();
      simulateGatewayRestart();
      expect(listPendingTerminalNoticeWork()).toHaveLength(1);

      const scheduled: string[] = [];
      const wakes: unknown[] = [];
      const handed = await drainPendingTerminalNotices({
        ...realDeps(stateDir),
        scheduleSessionDelivery: async (id: string) => {
          scheduled.push(id);
          return true;
        },
        requestHeartbeatNow: (() => {
          wakes.push(true);
        }) as typeof requestHeartbeatNow,
      });

      // The tombstone settled this key: release the flag, surface nothing.
      expect(handed).toBe(0);
      expect(listPendingTerminalNoticeWork()).toEqual([]);
      expect(peekSystemEvents(SESSION_KEY)).toEqual([]);
      expect(scheduled).toEqual([]);
      expect(wakes).toEqual([]);
      expect(await loadPendingSessionDeliveries(stateDir)).toEqual([]);
    });
  });

  it("retries a transiently failed durable handoff without waiting for a restart", async () => {
    await withDurableState(async (stateDir) => {
      vi.useFakeTimers();
      try {
        terminalizeWithPendingNotice();
        const [owed] = listPendingTerminalNoticeWork();
        if (!owed) {
          throw new Error("expected a pending terminal notice");
        }

        let attempts = 0;
        const deps = {
          ...realDeps(stateDir),
          enqueueSessionDeliveryWithStatus: (async (payload, dir) => {
            attempts += 1;
            if (attempts === 1) {
              throw new Error("transient sqlite failure");
            }
            return await enqueueSessionDeliveryWithStatus(payload, dir);
          }) as typeof enqueueSessionDeliveryWithStatus,
        };

        // First handoff fails; the flag must survive and a live retry arm.
        expect(await deliverPendingTerminalNoticeWithRetry(owed, deps)).toBe(false);
        expect(listPendingTerminalNoticeWork()).toHaveLength(1);
        expect(await loadPendingSessionDeliveries(stateDir)).toEqual([]);

        // No gateway restart: the armed retry completes the handoff.
        await vi.advanceTimersByTimeAsync(TERMINAL_NOTICE_RETRY_DELAYS_MS[0]);
        await vi.waitFor(async () => {
          expect(await loadPendingSessionDeliveries(stateDir)).toHaveLength(1);
        });
        expect(attempts).toBe(2);
        expect(listPendingTerminalNoticeWork()).toEqual([]);
        expect(await pendingDeliveryTexts(stateDir)).toEqual([
          CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE,
        ]);
      } finally {
        resetTerminalNoticeRetriesForTests();
        vi.useRealTimers();
      }
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

  it("reconciles an already-adopted ack id after a crash before queue settlement", async () => {
    await withDurableState(async (stateDir) => {
      await seedSessionEntry(stateDir);
      terminalizeWithPendingNotice();
      await drainPendingTerminalNotices(realDeps(stateDir));
      simulateGatewayRestart();
      await runProductionDeliveryRecovery(stateDir);

      const prepared = await preparePrompt(stateDir);
      const deliveryIds = prepared.managedDeliveries.map((delivery) => delivery.id);
      expect(deliveryIds).toHaveLength(1);

      // The turn is durably adopted, then the process dies BEFORE the queue ack.
      await persistAdoptedTurnWithoutQueueAck(stateDir, deliveryIds);
      simulateGatewayRestart();
      await runProductionDeliveryRecovery(stateDir);
      expect(await loadPendingSessionDeliveries(stateDir)).toHaveLength(1);

      // Preparation must recognise the already-adopted id: settle it, and keep
      // it out of the prompt rather than injecting the outcome a second time.
      const replay = await preparePrompt(stateDir);
      expect(
        replay.blocks.some((block) => block.text.includes("continue_work permanently failed")),
      ).toBe(false);
      expect(replay.managedDeliveries).toEqual([]);
      expect(await loadPendingSessionDeliveries(stateDir)).toEqual([]);
    });
  });

  it("treats an inconclusive enqueue status as a failed handoff", async () => {
    await withDurableState(async (stateDir) => {
      vi.useFakeTimers();
      try {
        terminalizeWithPendingNotice();
        const [owed] = listPendingTerminalNoticeWork();
        if (!owed) {
          throw new Error("expected a pending terminal notice");
        }

        let inconclusive = true;
        const scheduled: string[] = [];
        const wakes: unknown[] = [];
        const deps = {
          ...realDeps(stateDir),
          enqueueSessionDeliveryWithStatus: (async (payload, dir) => {
            const result = await enqueueSessionDeliveryWithStatus(payload, dir);
            return inconclusive ? { id: result.id, status: "unknown" as const } : result;
          }) as typeof enqueueSessionDeliveryWithStatus,
          scheduleSessionDelivery: async (id: string) => {
            scheduled.push(id);
            return true;
          },
          requestHeartbeatNow: (() => {
            wakes.push(true);
          }) as typeof requestHeartbeatNow,
        };

        expect(await deliverPendingTerminalNoticeWithRetry(owed, deps)).toBe(false);

        // Unknown status must not clear the flag, surface, schedule, or wake.
        expect(listPendingTerminalNoticeWork()).toHaveLength(1);
        expect(peekSystemEvents(SESSION_KEY)).toEqual([]);
        expect(scheduled).toEqual([]);
        expect(wakes).toEqual([]);

        // The bounded retry resolves it once the read is conclusive again.
        inconclusive = false;
        await vi.advanceTimersByTimeAsync(TERMINAL_NOTICE_RETRY_DELAYS_MS[0]);
        await vi.waitFor(() => {
          expect(listPendingTerminalNoticeWork()).toEqual([]);
        });
        expect(await pendingDeliveryTexts(stateDir)).toEqual([
          CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE,
        ]);
      } finally {
        resetTerminalNoticeRetriesForTests();
        vi.useRealTimers();
      }
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
