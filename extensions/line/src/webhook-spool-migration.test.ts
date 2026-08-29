// Line tests cover the pre-drain (#109655) spool upgrade migration.
import type { webhook } from "@line/bot-sdk";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateLineLegacySpoolRows } from "./webhook-spool-migration.js";
import { createLineWebhookSpool, type LineWebhookTurnAdoptionLifecycle } from "./webhook-spool.js";
import {
  createEvent,
  payloadFor,
  runtime,
  waitForVerdict,
  withQueue,
} from "./webhook-spool.test-support.js";

describe("LINE webhook spool upgrade migration", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("delivers pre-drain rows once after the doctor migration", async () => {
    await withQueue(async (queue, legacySeed) => {
      const event = createEvent({ webhookEventId: "legacy-upgrade-1" });
      await legacySeed.enqueue(
        "legacy-upgrade-1",
        { version: 1, destination: "destination-1", event },
        { laneKey: "user:user-1" },
      );
      await migrateLineLegacySpoolRows(queue);
      const deliver = vi.fn(async (_event, _destination, control) => {
        await control.turnAdoptionLifecycle.onAdopted();
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        // The migration rewrites the row into the canonical keyspace; delivery
        // completes under the message: id while the legacy id keeps a tombstone.
        await waitForVerdict(queue, "legacy-upgrade-1", "completed");
        await waitForVerdict(queue, "message:message-legacy-upgrade-1", "completed");
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver).toHaveBeenCalledWith(
          event,
          "destination-1",
          expect.objectContaining({ turnAdoptionLifecycle: expect.anything() }),
        );
      } finally {
        await spool.stop();
      }
    });
  });

  it("dead-letters a pre-drain row whose event does not match its stored id", async () => {
    await withQueue(async (queue, legacySeed) => {
      const event = createEvent({ webhookEventId: "legacy-other-id" });
      await legacySeed.enqueue(
        "legacy-mismatch",
        { version: 1, destination: "destination-1", event },
        { laneKey: "user:user-1" },
      );
      await migrateLineLegacySpoolRows(queue);
      const deliver = vi.fn(async () => {});
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        await waitForVerdict(queue, "legacy-mismatch", "failed");
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await spool.stop();
      }
    });
  });

  it("re-runs a partially applied migration without a duplicate delivery", async () => {
    await withQueue(async (queue, legacySeed) => {
      // Simulate a crash between the migration's enqueue and complete: the
      // canonical row already exists while the legacy row is still pending.
      const event = createEvent({ webhookEventId: "legacy-partial" });
      await legacySeed.enqueue(
        "legacy-partial",
        { version: 1, destination: "destination-1", event },
        { laneKey: "user:user-1" },
      );
      await queue.enqueue("message:message-legacy-partial", payloadFor(event), {
        laneKey: "user:user-1",
      });
      await migrateLineLegacySpoolRows(queue);
      const deliver = vi.fn(async (_event, _destination, control) => {
        await control.turnAdoptionLifecycle.onAdopted();
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        await waitForVerdict(queue, "message:message-legacy-partial", "completed");
        await waitForVerdict(queue, "legacy-partial", "completed");
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await spool.stop();
      }
    });
  });

  it("does not resurrect a migrated event that was already delivered", async () => {
    await withQueue(async (queue, legacySeed) => {
      const event = createEvent({ webhookEventId: "legacy-delivered" });
      await queue.enqueue("message:message-legacy-delivered", payloadFor(event));
      await queue.complete("message:message-legacy-delivered");
      await legacySeed.enqueue(
        "legacy-delivered",
        { version: 1, destination: "destination-1", event },
        { laneKey: "user:user-1" },
      );
      const result = await migrateLineLegacySpoolRows(queue);
      // The canonical id is already a completion tombstone, so retiring the legacy
      // row owes no delivery and must not be reported as one.
      expect(result).toMatchObject({ migrated: 0, reconciled: 1 });
      const deliver = vi.fn(async () => {});
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        await waitForVerdict(queue, "legacy-delivered", "completed");
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await spool.stop();
      }
    });
  });

  it("reports no delivery when the canonical id already dead-lettered", async () => {
    await withQueue(async (queue, legacySeed) => {
      // A redelivered message id can reach the migration after an earlier copy
      // already exhausted its retries under the canonical id.
      const event = createEvent({ webhookEventId: "legacy-buried-canonical" });
      await queue.enqueue("message:message-legacy-buried-canonical", payloadFor(event));
      expect(
        await queue.fail("message:message-legacy-buried-canonical", {
          reason: "retry-limit-exceeded",
          message: "dispatch failed",
        }),
      ).toBe(true);
      await legacySeed.enqueue(
        "legacy-buried-canonical",
        { version: 1, destination: "destination-1", event },
        { laneKey: "user:user-1" },
      );

      const result = await migrateLineLegacySpoolRows(queue);

      expect(result).toMatchObject({ migrated: 0, reconciled: 1 });
      // The legacy row is retired, and the message stays inspectable under the
      // canonical dead-letter rather than being resurrected by the migration.
      await waitForVerdict(queue, "legacy-buried-canonical", "completed");
      await waitForVerdict(queue, "message:message-legacy-buried-canonical", "failed");
    });
  });

  it("recovers a legacy row still claimed by the retired worker before migrating", async () => {
    await withQueue(async (queue, legacySeed) => {
      const event = createEvent({ webhookEventId: "legacy-claimed" });
      await legacySeed.enqueue(
        "legacy-claimed",
        { version: 1, destination: "destination-1", event },
        { laneKey: "user:user-1" },
      );
      expect(await legacySeed.claim("legacy-claimed", { ownerId: "retired-worker" })).toBeTruthy();
      await migrateLineLegacySpoolRows(queue);
      const deliver = vi.fn(async (_event, _destination, control) => {
        await control.turnAdoptionLifecycle.onAdopted();
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        await waitForVerdict(queue, "legacy-claimed", "completed");
        await waitForVerdict(queue, "message:message-legacy-claimed", "completed");
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await spool.stop();
      }
    });
  });

  it("recovers a row the pre-fix decoder dead-lettered and delivers it once", async () => {
    await withQueue(async (queue, legacySeed) => {
      // A deployment that upgraded before the migration existed dead-lettered its
      // pre-drain rows at the canonical decoder with this exact signature.
      const event = createEvent({ webhookEventId: "legacy-buried" });
      await legacySeed.enqueue(
        "legacy-buried",
        { version: 1, destination: "destination-1", event },
        { laneKey: "user:user-1" },
      );
      await queue.fail("legacy-buried", {
        reason: "invalid-event",
        message: "LINE webhook spool payload is invalid.",
      });
      await migrateLineLegacySpoolRows(queue);
      const deliver = vi.fn(async (_event, _destination, control) => {
        await control.turnAdoptionLifecycle.onAdopted();
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        await waitForVerdict(queue, "legacy-buried", "completed");
        await waitForVerdict(queue, "message:message-legacy-buried", "completed");
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await spool.stop();
      }
    });
  });

  it("does not recover a row the identity fence dead-lettered", async () => {
    await withQueue(async (queue, legacySeed) => {
      const event = createEvent({ webhookEventId: "legacy-other-id" });
      await legacySeed.enqueue(
        "legacy-fenced",
        { version: 1, destination: "destination-1", event },
        { laneKey: "user:user-1" },
      );
      await migrateLineLegacySpoolRows(queue);
      // The fence dead-lettered the row; a rerun must not resurrect it.
      const rerun = await migrateLineLegacySpoolRows(queue);
      expect(rerun).toEqual({
        migrated: 0,
        reconciled: 0,
        deadLettered: 0,
        recovered: 0,
        failures: [],
      });
      const verdict = await queue.enqueue("legacy-fenced", {
        version: 1,
        rawEvent: "{}",
        destination: "",
      });
      expect(verdict.kind).toBe("failed");
    });
  });

  it("does not recover a legacy row dead-lettered for a delivery failure", async () => {
    await withQueue(async (queue, legacySeed) => {
      const event = createEvent({ webhookEventId: "legacy-exhausted" });
      await legacySeed.enqueue(
        "legacy-exhausted",
        { version: 1, destination: "destination-1", event },
        { laneKey: "user:user-1" },
      );
      await queue.fail("legacy-exhausted", {
        reason: "retry-limit-exceeded",
        message: "delivery failed after 8 attempts",
      });
      const result = await migrateLineLegacySpoolRows(queue);
      expect(result).toEqual({
        migrated: 0,
        reconciled: 0,
        deadLettered: 0,
        recovered: 0,
        failures: [],
      });
      const verdict = await queue.enqueue("legacy-exhausted", {
        version: 1,
        rawEvent: "{}",
        destination: "",
      });
      expect(verdict.kind).toBe("failed");
    });
  });

  it("delivers a migrated row before a newer event on the same lane", async () => {
    await withQueue(async (queue, legacySeed) => {
      const legacyEvent = createEvent({ webhookEventId: "legacy-ordered" });
      const newerEvent = createEvent({ webhookEventId: "event-newer" });
      await legacySeed.enqueue(
        "legacy-ordered",
        { version: 1, destination: "destination-1", event: legacyEvent },
        { laneKey: "user:user-1", receivedAt: Date.now() - 60_000 },
      );
      await queue.enqueue("message:message-event-newer", payloadFor(newerEvent), {
        laneKey: "user:user-1",
      });
      await migrateLineLegacySpoolRows(queue);
      const delivered: string[] = [];
      const deliver = vi.fn(
        async (
          event: webhook.Event,
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          delivered.push(event.webhookEventId ?? "");
          await control.turnAdoptionLifecycle.onAdopted();
        },
      );
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        await waitForVerdict(queue, "message:message-event-newer", "completed");
        expect(delivered).toEqual(["legacy-ordered", "event-newer"]);
      } finally {
        await spool.stop();
      }
    });
  });
});
