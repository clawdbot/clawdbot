// Telegram tests cover telegram ingress spool plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { clearTelegramRuntime, setTelegramRuntime } from "./runtime.js";
import type { TelegramRuntime } from "./runtime.types.js";
import {
  claimNextTelegramSpooledUpdate,
  claimTelegramSpooledUpdate,
  completeTelegramSpooledUpdate,
  completeTelegramSpooledUpdateWithRetry,
  failTelegramSpooledUpdateClaim,
  isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess,
  listTelegramSpooledUpdateClaims,
  listTelegramSpooledUpdates,
  recoverStaleTelegramSpooledUpdateClaims,
  refreshTelegramSpooledUpdateClaim,
  releaseTelegramSpooledUpdateClaim,
  TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS,
  writeTelegramSpooledUpdate,
} from "./telegram-ingress-spool.js";

function installTelegramIngressQueueRuntime(resolveStateDir: () => string): void {
  setTelegramRuntime({
    state: {
      resolveStateDir,
      openChannelIngressQueue: (
        options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
      ) => createChannelIngressQueue({ ...options, channelId: "telegram" }),
    },
  } as TelegramRuntime);
}

async function withTempSpool<T>(fn: (spoolDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
  const spoolDir = path.join(stateDir, "telegram", "ingress-spool-test");
  await fs.mkdir(spoolDir, { recursive: true });
  installTelegramIngressQueueRuntime(() => stateDir);
  try {
    return await fn(spoolDir);
  } finally {
    clearTelegramRuntime();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("Telegram ingress spool", () => {
  afterEach(() => {
    clearTelegramRuntime();
    closeOpenClawStateDatabaseForTest();
  });

  it("persists updates durably in update_id order and tombstones handled entries", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 11, message: { text: "second" } },
        now: 2,
      });
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 10, message: { text: "first" } },
        now: 1,
      });

      const updates = await listTelegramSpooledUpdates({ spoolDir });

      expect(updates.map((update) => update.updateId)).toEqual([10, 11]);
      expect(updates.map((update) => update.receivedAt)).toEqual([1, 2]);
      expect(updates[0]?.update).toEqual({ update_id: 10, message: { text: "first" } });

      if (!updates[0]) {
        throw new Error("Expected a spooled update");
      }
      await completeTelegramSpooledUpdate(updates[0]);

      expect(
        (await listTelegramSpooledUpdates({ spoolDir })).map((update) => update.updateId),
      ).toEqual([11]);

      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 10, message: { text: "refetched first" } },
        now: 3,
      });
      expect(
        (await listTelegramSpooledUpdates({ spoolDir })).map((update) => update.updateId),
      ).toEqual([11]);
    });
  });

  it("claims active updates so they are hidden from pending drain lists", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 20, message: { text: "active" } },
      });
      const update = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!update) {
        throw new Error("Expected a spooled update");
      }

      const claimed = await claimTelegramSpooledUpdate(update);

      expect(claimed?.updateId).toBe(20);
      expect(claimed?.path.endsWith(".json.processing")).toBe(true);
      expect(await listTelegramSpooledUpdates({ spoolDir })).toEqual([]);
      expect(
        (await listTelegramSpooledUpdateClaims({ spoolDir })).map((claim) => claim.updateId),
      ).toEqual([20]);

      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 20, message: { text: "duplicate" } },
      });
      expect(await listTelegramSpooledUpdates({ spoolDir })).toEqual([]);

      if (!claimed) {
        throw new Error("Expected a claimed update");
      }
      await completeTelegramSpooledUpdate(claimed);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir })).toEqual([]);

      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 20, message: { text: "refetched handled update" } },
      });
      expect(await listTelegramSpooledUpdates({ spoolDir })).toEqual([]);
    });
  });

  it("does not tombstone a claim after its token loses ownership", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 21, message: { text: "claimed" } },
      });
      const pending = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!pending) {
        throw new Error("Expected a spooled update");
      }
      const firstClaim = await claimTelegramSpooledUpdate(pending);
      if (!firstClaim) {
        throw new Error("Expected the first claim");
      }
      await releaseTelegramSpooledUpdateClaim(firstClaim);
      const retryPending = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!retryPending) {
        throw new Error("Expected the released update");
      }
      const secondClaim = await claimTelegramSpooledUpdate(retryPending);
      if (!secondClaim) {
        throw new Error("Expected the replacement claim");
      }

      await expect(completeTelegramSpooledUpdateWithRetry({ update: firstClaim })).rejects.toThrow(
        "lost claim ownership",
      );
      expect(
        (await listTelegramSpooledUpdateClaims({ spoolDir })).map((claim) => ({
          updateId: claim.updateId,
          claimToken: claim.claim?.claimToken,
        })),
      ).toEqual([
        {
          updateId: 21,
          claimToken: secondClaim.claim?.claimToken,
        },
      ]);
    });
  });

  it("claims next update through the native ingress queue in update id order", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 101, message: { chat: { id: 1 }, message_id: 1, text: "second" } },
        now: 1,
      });
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 100, message: { chat: { id: 1 }, message_id: 2, text: "first" } },
        now: 2,
      });

      const claimed = await claimNextTelegramSpooledUpdate({ spoolDir });

      expect(claimed?.updateId).toBe(100);
      expect(await listTelegramSpooledUpdates({ spoolDir })).toHaveLength(1);
      expect(
        (await listTelegramSpooledUpdateClaims({ spoolDir })).map((claim) => claim.updateId),
      ).toEqual([100]);
    });
  });

  it("derives lane keys while claiming legacy rows without stored lane keys", async () => {
    await withTempSpool(async (spoolDir) => {
      const stateDir = path.dirname(path.dirname(spoolDir));
      const queue = createChannelIngressQueue<{
        version: 1;
        updateId: number;
        receivedAt: number;
        update: unknown;
      }>({
        channelId: "telegram",
        accountId: "test",
        stateDir,
      });
      await queue.enqueue(
        "0000000000000042",
        {
          version: 1,
          updateId: 42,
          receivedAt: 1,
          update: {
            update_id: 42,
            message: {
              chat: { id: 100, type: "supergroup", is_forum: true },
              is_topic_message: true,
              message_id: 1,
              message_thread_id: 10,
              text: "blocked topic",
            },
          },
        },
        { receivedAt: 1 },
      );
      await queue.enqueue(
        "0000000000000043",
        {
          version: 1,
          updateId: 43,
          receivedAt: 2,
          update: {
            update_id: 43,
            message: {
              chat: { id: 100, type: "supergroup", is_forum: true },
              is_topic_message: true,
              message_id: 2,
              message_thread_id: 11,
              text: "open topic",
            },
          },
        },
        { receivedAt: 2 },
      );

      const claimed = await claimNextTelegramSpooledUpdate({
        spoolDir,
        blockedLaneKeys: ["telegram:100:topic:10"],
      });

      expect(claimed?.updateId).toBe(43);
      expect(claimed?.claim?.claimToken).toEqual(expect.any(String));
      expect(
        (await listTelegramSpooledUpdates({ spoolDir })).map((update) => update.updateId),
      ).toEqual([42]);
    });
  });

  it("does not claim outside the provided candidate update ids", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 200, message: { chat: { id: 1 }, message_id: 1, text: "first" } },
        now: 1,
      });
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 201, message: { chat: { id: 2 }, message_id: 1, text: "later" } },
        now: 2,
      });

      const claimed = await claimNextTelegramSpooledUpdate({
        spoolDir,
        blockedLaneKeys: ["telegram:1"],
        candidateUpdateIds: [200],
      });

      expect(claimed).toBeNull();
      expect(
        (await listTelegramSpooledUpdates({ spoolDir })).map((update) => update.updateId),
      ).toEqual([200, 201]);
    });
  });

  it("releases failed claims back to the pending spool", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 30, message: { text: "retry me" } },
      });
      const update = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!update) {
        throw new Error("Expected a spooled update");
      }
      const claimed = await claimTelegramSpooledUpdate(update);
      if (!claimed) {
        throw new Error("Expected a claimed update");
      }

      await releaseTelegramSpooledUpdateClaim(claimed);

      const updates = await listTelegramSpooledUpdates({ spoolDir });
      expect(updates.map((entry) => entry.updateId)).toEqual([30]);
      expect(updates[0]?.path.endsWith(".json")).toBe(true);
    });
  });

  it("refreshes active claim timestamps through the Telegram spool queue", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 31, message: { text: "refresh me" } },
      });
      const update = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!update) {
        throw new Error("Expected a spooled update");
      }
      const claimed = await claimTelegramSpooledUpdate(update);
      if (!claimed) {
        throw new Error("Expected a claimed update");
      }

      await expect(refreshTelegramSpooledUpdateClaim(claimed, { refreshedAt: 123 })).resolves.toBe(
        true,
      );

      const claims = await listTelegramSpooledUpdateClaims({ spoolDir });
      expect(claims).toHaveLength(1);
      expect(claims[0]?.updateId).toBe(31);
      expect(claims[0]?.claim?.claimedAt).toBe(123);
    });
  });

  it("marks timed out claims failed without requeueing them", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 32, message: { text: "poison" } },
      });
      const update = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!update) {
        throw new Error("Expected a spooled update");
      }
      const claimed = await claimTelegramSpooledUpdate(update);
      if (!claimed) {
        throw new Error("Expected a claimed update");
      }

      await expect(
        failTelegramSpooledUpdateClaim({
          update: claimed,
          reason: "handler-timeout",
          message: "timed out",
          now: 123,
        }),
      ).resolves.toBe(true);

      expect(await listTelegramSpooledUpdates({ spoolDir })).toEqual([]);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir })).toEqual([]);

      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 32, message: { text: "redelivered poison" } },
        now: 124,
      });
      expect(await listTelegramSpooledUpdates({ spoolDir })).toEqual([]);

      await expect(recoverStaleTelegramSpooledUpdateClaims({ spoolDir })).resolves.toBe(0);
      expect(await listTelegramSpooledUpdates({ spoolDir })).toEqual([]);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir })).toEqual([]);
    });
  });

  it("does not claim an update after the pending file is gone", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 35, message: { text: "already handled" } },
      });
      const update = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!update) {
        throw new Error("Expected a spooled update");
      }
      await completeTelegramSpooledUpdate(update);

      await expect(claimTelegramSpooledUpdate(update)).resolves.toBeNull();
      expect(await listTelegramSpooledUpdates({ spoolDir })).toEqual([]);
    });
  });

  it("recovers stale processing claims selected by the caller", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 41, message: { text: "stale" } },
      });
      const updates = await listTelegramSpooledUpdates({ spoolDir });
      const stale = updates.find((update) => update.updateId === 41);
      if (!stale) {
        throw new Error("Expected spooled updates");
      }
      const claimedStale = await claimTelegramSpooledUpdate(stale);
      if (!claimedStale) {
        throw new Error("Expected claimed updates");
      }
      const now = Date.now();

      const recovered = await recoverStaleTelegramSpooledUpdateClaims({
        spoolDir,
        now: now + TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS + 1,
      });

      expect(recovered).toBe(1);
      expect(
        (await listTelegramSpooledUpdates({ spoolDir })).map((update) => update.updateId),
      ).toEqual([41]);
    });
  });

  it("lets recovery callers keep a claim in processing", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 45, message: { text: "busy" } },
      });
      const update = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!update) {
        throw new Error("Expected a spooled update");
      }
      const claimed = await claimTelegramSpooledUpdate(update);
      if (!claimed) {
        throw new Error("Expected a claimed update");
      }
      let shouldRecoverCalls = 0;
      const recovered = await recoverStaleTelegramSpooledUpdateClaims({
        spoolDir,
        staleMs: 0,
        shouldRecover: () => {
          shouldRecoverCalls += 1;
          return false;
        },
      });

      expect(recovered).toBe(0);
      expect(shouldRecoverCalls).toBe(1);
      expect(
        (await listTelegramSpooledUpdateClaims({ spoolDir })).map((claim) => claim.updateId),
      ).toEqual([45]);
    });
  });

  it("does not treat stale claims with reused pids as live-owned", () => {
    const now = Date.now();
    expect(
      isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess({
        updateId: 50,
        path: path.join(os.tmpdir(), "50.json.processing"),
        pendingPath: path.join(os.tmpdir(), "50.json"),
        update: { update_id: 50 },
        receivedAt: now,
        claim: {
          processId: "other-process",
          processPid: process.pid,
          claimedAt: now - TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS - 1,
        },
      }),
    ).toBe(false);
  });

  it("does not treat fresh claims with the current pid and a different owner id as foreign", () => {
    const now = Date.now();
    expect(
      isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess({
        updateId: 50,
        path: path.join(os.tmpdir(), "50.json.processing"),
        pendingPath: path.join(os.tmpdir(), "50.json"),
        update: { update_id: 50 },
        receivedAt: now,
        claim: {
          processId: "other-process",
          processPid: process.pid,
          claimedAt: now,
        },
      }),
    ).toBe(false);
  });

  it("treats fresh claims with other live pids as live-owned", () => {
    const now = Date.now();
    const liveOwnerPid = process.ppid > 0 ? process.ppid : 1;
    expect(
      isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess({
        updateId: 51,
        path: path.join(os.tmpdir(), "51.json.processing"),
        pendingPath: path.join(os.tmpdir(), "51.json"),
        update: { update_id: 51 },
        receivedAt: now,
        claim: {
          processId: "other-process",
          processPid: liveOwnerPid,
          claimedAt: now,
        },
      }),
    ).toBe(true);
  });
});
