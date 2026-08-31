// Durable receive tests cover shared ingress-queue persistence and replay behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createDurableInboundReceiveJournalFromQueue } from "./durable-receive.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type TestPayload = { body: string };
type TestMetadata = { source: string };
type TestCompletedMetadata = { delivered: boolean };

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-durable-receive-"));
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("createDurableInboundReceiveJournalFromQueue", () => {
  it("uses the shared channel ingress queue as durable storage", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<TestPayload, TestMetadata, TestCompletedMetadata>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 10,
      });
      const journal = createDurableInboundReceiveJournalFromQueue({
        queue,
        retention: { completedMaxEntries: 1 },
      });

      await expect(
        journal.accept("message-1", { body: "hello" }, { metadata: { source: "live" } }),
      ).resolves.toMatchObject({
        kind: "accepted",
        duplicate: false,
        record: {
          id: "message-1",
          payload: { body: "hello" },
          metadata: { source: "live" },
          receivedAt: 10,
        },
      });

      await expect(journal.pending()).resolves.toMatchObject([
        {
          id: "message-1",
          payload: { body: "hello" },
          metadata: { source: "live" },
        },
      ]);

      await expect(journal.release("message-1", { lastError: "retry" })).resolves.toBe(true);
      await expect(journal.pending()).resolves.toMatchObject([
        {
          id: "message-1",
          attempts: 1,
          lastError: "retry",
        },
      ]);

      await journal.complete("message-1", {
        metadata: { delivered: true },
        completedAt: 20,
      });
      await expect(journal.accept("message-1", { body: "again" })).resolves.toMatchObject({
        kind: "completed",
        duplicate: true,
        record: {
          id: "message-1",
          completedAt: 20,
          metadata: { delivered: true },
        },
      });

      await journal.accept("message-2", { body: "new" });
      await journal.complete("message-2", { completedAt: 21 });
      await expect(journal.accept("message-1", { body: "past retention" })).resolves.toMatchObject({
        kind: "accepted",
        duplicate: false,
      });
    });
  });
});
