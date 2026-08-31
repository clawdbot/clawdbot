// Account purge tests cover the durable rows a removed channel account owned.
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
import { createChannelIngressQueue, purgeChannelIngressQueueAccount } from "./ingress-queue.js";

type ChannelIngressTestDatabase = Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">;

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-purge-"));
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function openQueue(stateDir: string, channelId: string, accountId: string) {
  return createChannelIngressQueue<{ text: string }>({ channelId, accountId, stateDir });
}

/** Reads stored rows straight from SQLite so status assertions never rely on the API under test. */
function readStoredRows(stateDir: string) {
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  return executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<ChannelIngressTestDatabase>(database.db)
      .selectFrom("channel_ingress_events")
      .select(["channel_id", "account_id", "event_id", "status"])
      .orderBy("channel_id", "asc")
      .orderBy("account_id", "asc")
      .orderBy("event_id", "asc"),
  ).rows;
}

/** Leaves one row of the removed account in each status the queue can hold. */
async function seedEveryStatus(stateDir: string, channelId: string, accountId: string) {
  const queue = openQueue(stateDir, channelId, accountId);
  await queue.enqueue("pending-1", { text: "pending" });
  await queue.enqueue("claimed-1", { text: "claimed" });
  await queue.claim("claimed-1");
  await queue.enqueue("completed-1", { text: "completed" });
  await queue.complete("completed-1");
  await queue.enqueue("failed-1", { text: "failed" });
  const failing = await queue.claim("failed-1");
  if (!failing) {
    throw new Error("Expected to claim the row the test dead-letters");
  }
  await queue.fail(failing, { reason: "poison" });
  return queue;
}

describe("channel ingress queue account purge", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("discards every stored status of the removed account and counts the unanswered rows", async () => {
    await withTempState(async (stateDir) => {
      await seedEveryStatus(stateDir, "line", "default");
      const otherAccount = openQueue(stateDir, "line", "work");
      await otherAccount.enqueue("work-1", { text: "still configured" });
      const otherChannel = openQueue(stateDir, "telegram", "default");
      await otherChannel.enqueue("telegram-1", { text: "another channel" });

      expect(readStoredRows(stateDir)).toEqual([
        { channel_id: "line", account_id: "default", event_id: "claimed-1", status: "claimed" },
        { channel_id: "line", account_id: "default", event_id: "completed-1", status: "completed" },
        { channel_id: "line", account_id: "default", event_id: "failed-1", status: "failed" },
        { channel_id: "line", account_id: "default", event_id: "pending-1", status: "pending" },
        { channel_id: "line", account_id: "work", event_id: "work-1", status: "pending" },
        {
          channel_id: "telegram",
          account_id: "default",
          event_id: "telegram-1",
          status: "pending",
        },
      ]);

      // The account id is omitted the way the removal command omits it for the default
      // account, so the purge and the queue must agree on the same default.
      expect(purgeChannelIngressQueueAccount({ channelId: "line", stateDir })).toEqual({
        discarded: 4,
        // Completed and dead-lettered rows are already settled; only the pending and
        // claimed rows were inbound work that now has no account left to answer it.
        undelivered: 2,
      });

      expect(readStoredRows(stateDir)).toEqual([
        { channel_id: "line", account_id: "work", event_id: "work-1", status: "pending" },
        {
          channel_id: "telegram",
          account_id: "default",
          event_id: "telegram-1",
          status: "pending",
        },
      ]);
    });
  });

  it("reports nothing discarded for an account that holds no rows", async () => {
    await withTempState(async (stateDir) => {
      const queue = openQueue(stateDir, "line", "work");
      await queue.enqueue("work-1", { text: "still configured" });

      expect(
        purgeChannelIngressQueueAccount({ channelId: "line", accountId: "default", stateDir }),
      ).toEqual({ discarded: 0, undelivered: 0 });
      // A second removal of the same account is a no-op rather than a repeated report.
      expect(
        purgeChannelIngressQueueAccount({ channelId: "line", accountId: "work", stateDir }),
      ).toEqual({ discarded: 1, undelivered: 1 });
      expect(
        purgeChannelIngressQueueAccount({ channelId: "line", accountId: "work", stateDir }),
      ).toEqual({ discarded: 0, undelivered: 0 });
      expect(readStoredRows(stateDir)).toEqual([]);
    });
  });

  it("lets a re-added account start clean instead of inheriting the removed account's rows", async () => {
    await withTempState(async (stateDir) => {
      const before = openQueue(stateDir, "line", "default");
      await before.enqueue("event-1", { text: "from the removed account" });

      purgeChannelIngressQueueAccount({ channelId: "line", accountId: "default", stateDir });

      // Same channel and account id as the removed account: without the purge this
      // enqueue is deduplicated against the old row and the event is silently dropped.
      const after = openQueue(stateDir, "line", "default");
      const readmitted = await after.enqueue("event-1", { text: "after re-adding" });
      expect(readmitted.kind).toBe("accepted");
      expect(await after.listPending({ limit: "all" })).toMatchObject([
        { payload: { text: "after re-adding" } },
      ]);
    });
  });
});
