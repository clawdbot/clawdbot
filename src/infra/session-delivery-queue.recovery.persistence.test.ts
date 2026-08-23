// Covers real session-delivery retry failures against the persistent SQLite queue.
import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  drainPendingSessionDeliveries,
  enqueueSessionDelivery,
  loadPendingSessionDeliveries,
  recoverPendingSessionDeliveries,
} from "./session-delivery-queue.js";

describe("session-delivery recovery persistence", () => {
  it.each(["startup", "targeted drain"] as const)(
    "surfaces real SQLite retry-persistence failures during %s recovery",
    async (mode) => {
      await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
        const id = await enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "recover after storage is writable",
          },
          tempDir,
        );
        const { db } = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
        });
        const deliver = vi.fn(async () => {
          db.exec("PRAGMA query_only = ON");
          throw new Error("session delivery interrupted");
        });
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        try {
          const recovery =
            mode === "startup"
              ? recoverPendingSessionDeliveries({ deliver, stateDir: tempDir, log })
              : drainPendingSessionDeliveries({
                  drainKey: "test-read-only-retry-persistence",
                  logLabel: "test read-only retry persistence",
                  deliver,
                  stateDir: tempDir,
                  log,
                  selectEntry: (entry) => ({ match: entry.id === id }),
                });

          await expect(recovery).rejects.toThrow(/readonly/iu);
        } finally {
          db.exec("PRAGMA query_only = OFF");
        }

        expect(deliver).toHaveBeenCalledTimes(1);
        const [pending] = await loadPendingSessionDeliveries(tempDir);
        expect(pending).toEqual(expect.objectContaining({ id, retryCount: 0 }));
        expect(pending?.lastAttemptAt).toBeUndefined();

        const retryDelivery = vi.fn(async () => undefined);
        await expect(
          recoverPendingSessionDeliveries({
            deliver: retryDelivery,
            stateDir: tempDir,
            log,
          }),
        ).resolves.toMatchObject({ recovered: 1 });
        expect(retryDelivery).toHaveBeenCalledTimes(1);
        expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
      });
    },
  );
});
