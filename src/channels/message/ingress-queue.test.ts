// Ingress queue tests cover durable queueing for inbound channel messages.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type ChannelIngressTestDatabase = Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">;

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-queue-"));
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("channel ingress queue", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("deduplicates pending and completed ingress events", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<
        { text: string },
        { source: string },
        { handledBy: string }
      >({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 100,
      });

      const accepted = await queue.enqueue(
        "event-1",
        { text: "first" },
        { metadata: { source: "fixture" }, receivedAt: 50 },
      );
      const pending = await queue.enqueue("event-1", { text: "duplicate" });
      await queue.complete("event-1", { metadata: { handledBy: "worker" }, completedAt: 150 });
      const completed = await queue.enqueue("event-1", { text: "late duplicate" });

      expect(accepted.kind).toBe("accepted");
      expect(pending.kind).toBe("pending");
      if (pending.kind !== "pending") {
        throw new Error(`Expected pending duplicate, got ${pending.kind}`);
      }
      expect(pending.record.payload).toEqual({ text: "first" });
      expect(completed).toEqual({
        kind: "completed",
        duplicate: true,
        record: {
          id: "event-1",
          channelId: "test",
          accountId: "account",
          queueName: JSON.stringify(["test", "account"]),
          completedAt: 150,
          metadata: { handledBy: "worker" },
        },
      });
      expect(await queue.listPending()).toEqual([]);

      expect(
        await queue.complete("missing-event", {
          metadata: { handledBy: "late-worker" },
          completedAt: 200,
        }),
      ).toBe(true);
      expect(await queue.enqueue("missing-event", { text: "late duplicate" })).toMatchObject({
        kind: "completed",
        duplicate: true,
        record: {
          id: "missing-event",
          completedAt: 200,
          metadata: { handledBy: "late-worker" },
        },
      });

      await queue.enqueue(" spaced-event ", { text: "spaced" });
      expect(await queue.complete(" spaced-event ", { completedAt: 250 })).toBe(true);
      expect(await queue.enqueue("spaced-event", { text: "duplicate" })).toMatchObject({
        kind: "completed",
        duplicate: true,
        record: { id: "spaced-event", completedAt: 250 },
      });
    });
  });

  it("keeps channel and account queue identities unambiguous", async () => {
    await withTempState(async (stateDir) => {
      const first = createChannelIngressQueue<{ text: string }>({
        channelId: "a",
        accountId: "b:c",
        stateDir,
      });
      const second = createChannelIngressQueue<{ text: string }>({
        channelId: "a:b",
        accountId: "c",
        stateDir,
      });

      expect(await first.enqueue("same-id", { text: "first" })).toMatchObject({
        kind: "accepted",
      });
      expect(await second.enqueue("same-id", { text: "second" })).toMatchObject({
        kind: "accepted",
      });

      await first.complete("same-id");

      expect(await first.enqueue("same-id", { text: "first duplicate" })).toMatchObject({
        kind: "completed",
      });
      expect(await second.enqueue("same-id", { text: "second duplicate" })).toMatchObject({
        kind: "pending",
        record: { payload: { text: "second" } },
      });
    });
  });

  it("can bound pending scans and prune stale pending rows", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createChannelIngressQueue<{ index: number }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => clock++,
      });

      await queue.enqueue("0002", { index: 2 });
      await queue.enqueue("0001", { index: 1 });
      await queue.enqueue("0003", { index: 3 });

      expect(
        (await queue.listPending({ limit: 2, orderBy: "id" })).map((record) => record.id),
      ).toEqual(["0001", "0002"]);
      expect(await queue.prune({ pendingTtlMs: 3, pendingMaxEntries: 1, now: 7 })).toBe(2);
      expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).toEqual([
        "0003",
      ]);
    });
  });

  it("does not prune protected rows while enforcing max-entry limits", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ index: number }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 10,
      });

      await queue.enqueue("z", { index: 1 });
      await queue.enqueue("a", { index: 2 });

      expect(await queue.prune({ pendingMaxEntries: 1, protectIds: ["a"] })).toBe(0);
      expect(
        (await queue.listPending({ limit: "all", orderBy: "id" })).map((row) => row.id),
      ).toEqual(["a", "z"]);
    });
  });

  it("prunes max-entry overflow across bounded batches", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createChannelIngressQueue<{ index: number }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => clock++,
      });

      for (let index = 0; index < 520; index += 1) {
        await queue.enqueue(String(index).padStart(4, "0"), { index });
      }

      expect(await queue.prune({ pendingMaxEntries: 2 })).toBe(518);
      expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual([
        "0518",
        "0519",
      ]);
    });
  });

  it("claims, releases, and skips blocked lanes", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => clock++,
      });

      await queue.enqueue("a", { text: "blocked" }, { laneKey: "chat-1", receivedAt: 1 });
      await queue.enqueue("b", { text: "open" }, { laneKey: "chat-2", receivedAt: 2 });

      const claimed = await queue.claimNext({
        ownerId: "worker",
        blockedLaneKeys: ["chat-1"],
      });

      expect(claimed?.id).toBe("b");
      if (!claimed) {
        throw new Error("Expected a claimed ingress event");
      }
      expect(await queue.release(claimed, { lastError: "retry", releasedAt: 20 })).toBe(true);
      expect((await queue.listPending()).find((record) => record.id === "b")).toMatchObject({
        attempts: 1,
        lastAttemptAt: 20,
        lastError: "retry",
      });
    });
  });

  it("requires claim tokens before mutating claimed rows", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 10,
      });

      await queue.enqueue("event-1", { text: "claimed" });
      const claimed = await queue.claim("event-1", { ownerId: "worker" });
      if (!claimed) {
        throw new Error("Expected a claimed ingress event");
      }

      expect(await queue.complete("event-1")).toBe(false);
      expect(await queue.release("event-1")).toBe(false);
      expect(await queue.fail("event-1", { reason: "stale-handler" })).toBe(false);
      expect(await queue.delete("event-1")).toBe(false);

      expect(await queue.complete(claimed, { completedAt: 20 })).toBe(true);
      const duplicate = await queue.enqueue("event-1", { text: "duplicate" });
      expect(duplicate.kind).toBe("completed");
    });
  });

  it("recovers stale claims and prunes completed or failed rows", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 10,
      });

      await queue.enqueue("old", { text: "old" });
      await queue.enqueue("keep", { text: "keep" });
      const old = await queue.claim("old", { ownerId: "worker" });
      const keep = await queue.claim("keep", { ownerId: "worker" });
      if (!keep) {
        throw new Error("Expected a claimed ingress event");
      }

      expect(
        await queue.recoverStaleClaims({
          staleMs: 5,
          now: 20,
          shouldRecover: (claim) => claim.id === old?.id,
        }),
      ).toBe(1);
      expect((await queue.listPending()).map((record) => record.id)).toEqual(["old"]);
      expect((await queue.listClaims()).map((record) => record.id)).toEqual(["keep"]);

      await queue.complete("old", { completedAt: 25 });
      await queue.fail(keep, { reason: "poison", message: "bad", failedAt: 25 });
      await queue.enqueue("retry", { text: "retry" });
      await queue.release("retry", { lastError: "stale retry text", releasedAt: 26 });
      await queue.complete("retry", { completedAt: 27 });

      const database = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const kysely = getNodeSqliteKysely<ChannelIngressTestDatabase>(database.db);
      const rows = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("channel_ingress_events")
          .select(["event_id", "payload_json", "metadata_json", "last_attempt_at", "last_error"])
          .where("event_id", "in", ["old", "keep", "retry"])
          .orderBy("event_id", "asc"),
      ).rows;
      expect(rows).toEqual([
        {
          event_id: "keep",
          last_attempt_at: null,
          last_error: "bad",
          metadata_json: null,
          payload_json: "null",
        },
        {
          event_id: "old",
          last_attempt_at: null,
          last_error: null,
          metadata_json: null,
          payload_json: "null",
        },
        {
          event_id: "retry",
          last_attempt_at: null,
          last_error: null,
          metadata_json: null,
          payload_json: "null",
        },
      ]);

      expect(await queue.prune({ completedTtlMs: 10, failedTtlMs: 10, now: 40 })).toBe(3);
      expect(await queue.listPending()).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
    });
  });
});
