// Covers terminal session delivery queue recovery and retry exhaustion.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";

const sleepMock = vi.hoisted(() => vi.fn<(ms: number) => Promise<void>>());

vi.mock("../utils/sleep.js", () => ({ sleep: sleepMock }));

import {
  buildPostCompactionDelegateDeliveryPayload,
  failSessionDelivery,
  loadPendingSessionDeliveries,
  markSessionDeliveryAttemptStarted,
} from "./session-delivery-queue-storage.js";
import {
  drainPendingSessionDeliveries,
  enqueueSessionDelivery,
  recoverPendingSessionDeliveries,
} from "./session-delivery-queue.js";

describe("session-delivery queue recovery", () => {
  beforeEach(() => {
    sleepMock.mockReset();
    sleepMock.mockResolvedValue(undefined);
  });

  function readSessionQueueRow(
    tempDir: string,
    id: string,
  ): { status: string; entry_json: string } | undefined {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
    });
    return db
      .prepare(
        `SELECT status, entry_json
           FROM delivery_queue_entries
          WHERE queue_name = 'session' AND id = ?`,
      )
      .get(id) as { status: string; entry_json: string } | undefined;
  }

  it("settles entries moved to failed after startup retry exhaustion", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:startup-exhausted",
          maxRetries: 1,
        },
        tempDir,
      );
      await failSessionDelivery(id, "busy", tempDir);

      const deliver = vi.fn(async () => undefined);
      const onSettled = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        onSettled,
        stateDir: tempDir,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(summary.skippedMaxRetries).toBe(1);
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id }), "moved-to-failed");
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
    });
  });

  it.each(["runtime", "startup"] as const)(
    "scrubs post-compaction snapshots after %s retry exhaustion",
    async (mode) => {
      await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
        const secret = `POST_COMPACTION_EXHAUSTED_${mode}`;
        const payload = buildPostCompactionDelegateDeliveryPayload({
          sessionKey: "agent:main:main",
          delegate: {
            task: `exhaust ${mode} delivery`,
            createdAt: 123,
            attachments: [{ name: "brief.md", content: secret }],
            attachAs: { mountPath: "handoff" },
          },
          sequence: 0,
        });
        const id = await enqueueSessionDelivery({ ...payload, maxRetries: 1 }, tempDir);
        await failSessionDelivery(id, "busy", tempDir);

        const deliver = vi.fn(async () => undefined);
        if (mode === "runtime") {
          await drainPendingSessionDeliveries({
            drainKey: "post-compaction-exhaustion",
            logLabel: "post-compaction exhaustion",
            deliver,
            stateDir: tempDir,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            selectEntry: (entry) => ({ match: entry.id === id, bypassBackoff: true }),
          });
        } else {
          await recoverPendingSessionDeliveries({
            deliver,
            stateDir: tempDir,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          });
        }

        expect(deliver).not.toHaveBeenCalled();
        const row = readSessionQueueRow(tempDir, id);
        expect(row?.status).toBe("failed");
        expect(row?.entry_json).not.toContain(secret);
        if (!row) {
          throw new Error(`Expected failed session delivery row ${id}`);
        }
        const failedEntry = JSON.parse(row.entry_json) as Record<string, unknown>;
        expect(failedEntry).not.toHaveProperty("attachments");
        expect(failedEntry).not.toHaveProperty("attachAs");
      });
    },
  );

  it.each(["runtime", "startup"] as const)(
    "reconciles an accepted agent turn before %s retry exhaustion",
    async (mode) => {
      if (mode === "startup") {
        vi.useFakeTimers();
      }
      try {
        await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
          const id = await enqueueSessionDelivery(
            {
              kind: "agentTurn",
              sessionKey: "agent:main:main",
              message: "generated image ready",
              messageId: `image:task-exhausted-${mode}:agent-loop`,
              maxRetries: 1,
            },
            tempDir,
          );
          const entry = await loadPendingSessionDeliveries(tempDir).then((entries) => entries[0]);
          if (!entry) {
            throw new Error("Expected pending session delivery");
          }
          await markSessionDeliveryAttemptStarted(entry, tempDir);
          await failSessionDelivery(id, "final response lost", tempDir);

          const deliver = vi.fn(async () => undefined);
          if (mode === "startup") {
            vi.setSystemTime(new Date(Date.now() + 60_000));
          }
          if (mode === "runtime") {
            await drainPendingSessionDeliveries({
              drainKey: `test-started-exhausted-${mode}`,
              logLabel: "test started reconciliation",
              deliver,
              stateDir: tempDir,
              log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
              selectEntry: (candidate) => ({ match: candidate.id === id, bypassBackoff: true }),
            });
          } else {
            const summary = await recoverPendingSessionDeliveries({
              deliver,
              stateDir: tempDir,
              log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            });
            expect(summary.skippedMaxRetries).toBe(0);
          }

          expect(deliver).toHaveBeenCalledWith(
            expect.objectContaining({ id, deliveryStartedAt: expect.any(Number) }),
            { stateDir: tempDir },
          );
          expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
        });
      } finally {
        if (mode === "startup") {
          vi.useRealTimers();
        }
      }
    },
  );

  it("dead-letters a started agent turn after its bounded reconciliation fails", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-reconciliation-failed:agent-loop",
          maxRetries: 1,
        },
        tempDir,
      );
      const [entry] = await loadPendingSessionDeliveries(tempDir);
      if (!entry) {
        throw new Error("Expected pending session delivery");
      }
      await markSessionDeliveryAttemptStarted(entry, tempDir);
      await failSessionDelivery(id, "final response lost", tempDir);

      const deliver = vi.fn(async () => {
        throw new Error("terminal evidence unavailable");
      });
      const drain = async () =>
        await drainPendingSessionDeliveries({
          drainKey: "test-started-reconciliation-failed",
          logLabel: "test started reconciliation",
          deliver,
          stateDir: tempDir,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          selectEntry: (candidate) => ({ match: candidate.id === id, bypassBackoff: true }),
        });

      await drain();
      expect(deliver).toHaveBeenCalledOnce();
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([
        expect.objectContaining({ id, retryCount: 2, deliveryStartedAt: expect.any(Number) }),
      ]);

      await drain();
      expect(deliver).toHaveBeenCalledOnce();
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
    });
  });

  it("skips entries queued after the startup recovery cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));

    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "recover old entry",
        },
        tempDir,
      );
      const maxEnqueuedAt = Date.now();

      vi.setSystemTime(new Date("2026-04-23T00:00:05.000Z"));
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "leave fresh entry queued",
        },
        tempDir,
      );

      const deliver = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        stateDir: tempDir,
        maxEnqueuedAt,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(summary.recovered).toBe(1);
      const pending = await loadPendingSessionDeliveries(tempDir);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.kind).toBe("systemEvent");
      if (pending[0]?.kind === "systemEvent") {
        expect(pending[0].text).toBe("leave fresh entry queued");
      }
    });

    vi.useRealTimers();
  });
});
