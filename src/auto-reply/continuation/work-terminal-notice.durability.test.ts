// Covers durable restart recovery of the terminal continue_work outcome against
// the real SQLite task-flow registry and the real session-delivery queue.
//
// The in-memory system-event queue is explicitly non-durable, so these tests
// deliberately avoid mocking either store: they persist a terminal row, discard
// all process-local state, reload from disk, and then assert through the
// production recovery path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ackSessionDelivery,
  enqueueSessionDelivery,
} from "../../infra/session-delivery-queue-storage.js";
import {
  loadPendingSessionDeliveries,
  recoverPendingSessionDeliveries,
} from "../../infra/session-delivery-queue.js";
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
  drainPendingTerminalNotices,
} from "./work-terminal-notice.js";

/**
 * Real production collaborators, pinned to the temp state dir. Nothing here is
 * mocked: the point of these tests is that the durable stores carry the notice.
 */
function realDeps(stateDir: string) {
  return { enqueueSessionDelivery, ackSessionDelivery, enqueueSystemEvent, stateDir };
}

const SESSION_KEY = "agent:main:terminal-notice-durability";
const RAW_DRIVER_ERROR =
  "provider rejected token sk-live-9f3c1d2b7a at https://api.example/v1/messages";

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

describe("continuation_work terminal notice durability", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("persists the terminal failure and its pending notice across a restart", async () => {
    await withDurableState(async () => {
      terminalizeWithPendingNotice();

      // Nothing has been handed to the delivery queue yet; the obligation lives
      // only in the durable row.
      simulateGatewayRestart();

      const pending = listPendingTerminalNoticeWork();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.sessionKey).toBe(SESSION_KEY);
      expect(pending[0]?.terminalNoticePending).toBe("retry-exhausted");
    });
  });

  it("delivers the actionable outcome through the production recovery path after a restart", async () => {
    await withDurableState(async (stateDir) => {
      terminalizeWithPendingNotice();

      // Hand the obligation to the durable queue, then lose ALL process state
      // before the prompt ever drains the in-memory event.
      const handed = await drainPendingTerminalNotices(realDeps(stateDir));
      expect(handed).toBe(1);
      simulateGatewayRestart();

      // The in-memory fast path is gone; only the durable row remains.
      expect(peekSystemEvents(SESSION_KEY)).toEqual([]);
      const durable = await loadPendingSessionDeliveries(stateDir);
      expect(durable).toHaveLength(1);
      expect(durable[0]).toMatchObject({ kind: "systemEvent", sessionKey: SESSION_KEY });

      // Replay through the real session-delivery recovery path.
      const delivered: string[] = [];
      await recoverPendingSessionDeliveries({
        deliver: async (entry) => {
          if (entry.kind === "systemEvent") {
            delivered.push(entry.text);
          }
        },
        stateDir,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain("continue_work permanently failed");
      expect(delivered[0]).toContain("Reissue continue_work");
    });
  });

  it("cannot produce a duplicate outcome across repeated recovery", async () => {
    await withDurableState(async (stateDir) => {
      terminalizeWithPendingNotice();
      const deps = realDeps(stateDir);

      const first = await drainPendingTerminalNotices(deps);
      expect(first).toBe(1);

      // Repeated restarts + drains must not enqueue a second durable notice.
      simulateGatewayRestart();
      const second = await drainPendingTerminalNotices(deps);
      simulateGatewayRestart();
      const third = await drainPendingTerminalNotices(deps);

      expect(second).toBe(0);
      expect(third).toBe(0);
      expect(listPendingTerminalNoticeWork()).toEqual([]);
      expect(await loadPendingSessionDeliveries(stateDir)).toHaveLength(1);
    });
  });

  it("never exposes the raw driver error to the agent", async () => {
    await withDurableState(async (stateDir) => {
      terminalizeWithPendingNotice();
      await drainPendingTerminalNotices(realDeps(stateDir));

      const durable = await loadPendingSessionDeliveries(stateDir);
      const durableText = durable[0]?.kind === "systemEvent" ? durable[0].text : "";
      expect(durableText).toBe(CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE);
      expect(durableText).not.toContain("sk-live-9f3c1d2b7a");
      expect(durableText).not.toContain("https://api.example");
      expect(durableText).not.toContain("provider rejected token");
    });
  });
});
