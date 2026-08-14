// Doctor delivery failure tests protect aggregate-only guidance.
import { describe, expect, it, vi } from "vitest";
import {
  moveDeliveryQueueEntryToFailed,
  upsertDeliveryQueueEntry,
} from "../infra/delivery-queue-sqlite.js";
import type { DeliveryQueueTerminalPolicy } from "../infra/delivery-queue-sqlite.types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { noteDeliveryFailures } from "./doctor-delivery-failures.js";

describe("noteDeliveryFailures", () => {
  it("reports aggregate classifications and safe inspection commands only", async () => {
    await withTestDir({ prefix: "openclaw-doctor-delivery-" }, async (stateDir) => {
      const policy: DeliveryQueueTerminalPolicy = {
        version: 1,
        detail: "full",
        replay: "owner-managed",
        fence: { kind: "permanent" },
        reason: "owner_settled",
        payload: "present",
        cleanup: "pending",
        evidence: "owner_managed",
        owner: "subagent_completion",
        detailExpiresAt: Date.now() + 1_000,
      };
      upsertDeliveryQueueEntry({
        queueName: "session",
        entry: {
          id: "secret-task-route",
          enqueuedAt: Date.now(),
          retryCount: 1,
          terminalPolicy: policy,
        },
        stateDir,
      });
      moveDeliveryQueueEntryToFailed("session", "secret-task-route", policy, stateDir);
      const noteFn = vi.fn();

      noteDeliveryFailures({ stateDir, noteFn });

      const text = String(noteFn.mock.calls[0]?.[0]);
      expect(text).toContain("session: 1 failed");
      expect(text).toContain("owner-cleanup-pending=1");
      expect(text).toContain("openclaw delivery failures list");
      expect(text).toContain("openclaw tasks retry <task-id>");
      expect(text).not.toContain("secret-task-route");
    });
  });

  it("uses exact SQL summary facts beyond the list command limit", async () => {
    await withTestDir({ prefix: "openclaw-doctor-delivery-" }, async (stateDir) => {
      const failedAt = Date.now() - 31 * 24 * 60 * 60_000;
      const policy: DeliveryQueueTerminalPolicy = {
        version: 1,
        detail: "full",
        replay: "safe",
        fence: { kind: "none" },
        reason: "retry_exhausted",
        payload: "present",
        cleanup: "complete",
        evidence: "pre_side_effect",
      };
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const insert = db.prepare(
        `INSERT INTO delivery_queue_entries
          (queue_name,id,status,entry_kind,retry_count,entry_json,enqueued_at,updated_at,failed_at)
         VALUES ('session',?,'failed','systemEvent',0,?,?,?,?)`,
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let index = 0; index < 501; index += 1) {
          const id = `sample-proof-${index}`;
          insert.run(
            id,
            JSON.stringify({ id, enqueuedAt: failedAt, retryCount: 0, terminalPolicy: policy }),
            failedAt,
            failedAt,
            failedAt,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const noteFn = vi.fn();

      noteDeliveryFailures({ stateDir, noteFn });

      const text = String(noteFn.mock.calls[0]?.[0]);
      expect(text).toContain("payload-bearing=501");
      expect(text).toContain("oldest-payload-overdue=yes");
      expect(text).not.toContain("sample-proof-");
    });
  });

  it("reports malformed legacy JSON conservatively without exposing its bytes", async () => {
    await withTestDir({ prefix: "openclaw-doctor-delivery-" }, async (stateDir) => {
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      db.prepare(
        `INSERT INTO delivery_queue_entries
          (queue_name,id,status,entry_kind,retry_count,entry_json,enqueued_at,updated_at,failed_at)
         VALUES ('session','malformed-secret-id','failed','systemEvent',0,'{private-malformed',1,1,1)`,
      ).run();
      const noteFn = vi.fn();

      expect(() => noteDeliveryFailures({ stateDir, noteFn })).not.toThrow();

      const text = String(noteFn.mock.calls[0]?.[0]);
      expect(text).toContain("session: 1 failed");
      expect(text).toContain("legacy-unknown=1");
      expect(text).not.toContain("malformed-secret-id");
      expect(text).not.toContain("private-malformed");
    });
  });
});
