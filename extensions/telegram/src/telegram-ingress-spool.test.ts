// Telegram tests cover telegram ingress spool plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest as clearTelegramRuntime } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import { isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess } from "./telegram-ingress-claim-owner.js";
import {
  claimNextTelegramSpooledUpdate,
  completeTelegramSpooledUpdateWithRetry,
  failTelegramSpooledUpdateClaim,
  listTelegramSpooledUpdateClaims,
  listTelegramSpooledUpdates,
  recoverStaleTelegramSpooledUpdateClaims,
  refreshTelegramSpooledUpdateClaim,
  releaseTelegramSpooledUpdateClaim,
  writeTelegramSpooledUpdate,
} from "./telegram-ingress-spool.js";
import type { TelegramSpooledUpdate } from "./telegram-ingress-spool.types.js";

// Mirrors the production stale-claim default; callers may override it explicitly.
const telegramSpooledUpdateProcessingStaleMs = 6 * 60 * 60 * 1000;

async function claimSpooledUpdate(update: TelegramSpooledUpdate) {
  return await claimNextTelegramSpooledUpdate({
    spoolDir: path.dirname(update.path),
    candidateUpdateIds: [update.updateId],
  });
}

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
      const claimed = await claimSpooledUpdate(updates[0]);
      if (!claimed) {
        throw new Error("Expected a claimed update");
      }
      await completeTelegramSpooledUpdateWithRetry({ update: claimed });

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

      const claimed = await claimSpooledUpdate(update);

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
      await completeTelegramSpooledUpdateWithRetry({ update: claimed });
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
      const firstClaim = await claimSpooledUpdate(pending);
      if (!firstClaim) {
        throw new Error("Expected the first claim");
      }
      await releaseTelegramSpooledUpdateClaim(firstClaim);
      const retryPending = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!retryPending) {
        throw new Error("Expected the released update");
      }
      const secondClaim = await claimSpooledUpdate(retryPending);
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
      const claimed = await claimSpooledUpdate(update);
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
      const claimed = await claimSpooledUpdate(update);
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
      const claimed = await claimSpooledUpdate(update);
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
      const claimed = await claimSpooledUpdate(update);
      if (!claimed) {
        throw new Error("Expected a claimed update");
      }
      await completeTelegramSpooledUpdateWithRetry({ update: claimed });

      await expect(claimSpooledUpdate(update)).resolves.toBeNull();
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
      const claimedStale = await claimSpooledUpdate(stale);
      if (!claimedStale) {
        throw new Error("Expected claimed updates");
      }
      const now = Date.now();

      const recovered = await recoverStaleTelegramSpooledUpdateClaims({
        spoolDir,
        now: now + telegramSpooledUpdateProcessingStaleMs + 1,
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
      const claimed = await claimSpooledUpdate(update);
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
          processId: `${process.pid}:1:other-process`,
          processPid: process.pid,
          claimedAt: now - telegramSpooledUpdateProcessingStaleMs - 1,
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
          processId: `${process.pid}:1:other-process`,
          processPid: process.pid,
          claimedAt: now,
        },
      }),
    ).toBe(false);
  });

  it("does not treat a fresh foreign claim as live-owned when its pid is only a thread of this process", () => {
    const now = Date.now();
    // Incident shape: dead owner PID 9 is reused as a Linux TID of the new process.
    // process.kill(9, 0) succeeds, but starttime no longer matches the claim owner.
    expect(
      isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(
        {
          updateId: 52,
          path: path.join(os.tmpdir(), "52.json.processing"),
          pendingPath: path.join(os.tmpdir(), "52.json"),
          update: { update_id: 52 },
          receivedAt: now,
          claim: {
            processId: "9:1000:dead-owner",
            processPid: 9,
            claimedAt: now,
          },
        },
        {
          processExists: (pid) => pid === 9,
          readProcessStartTime: (pid) => (pid === 9 ? 2000 : null),
        },
      ),
    ).toBe(false);
  });

  it("does not treat a fresh foreign claim as live-owned when its pid was reused by an unrelated process", () => {
    const now = Date.now();
    expect(
      isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(
        {
          updateId: 53,
          path: path.join(os.tmpdir(), "53.json.processing"),
          pendingPath: path.join(os.tmpdir(), "53.json"),
          update: { update_id: 53 },
          receivedAt: now,
          claim: {
            processId: "4242:1000:dead-owner",
            processPid: 4242,
            claimedAt: now,
          },
        },
        {
          processExists: (pid) => pid === 4242,
          readProcessStartTime: (pid) => (pid === 4242 ? 9999 : null),
        },
      ),
    ).toBe(false);
  });

  it("treats fresh claims with other live process instances as live-owned", () => {
    const now = Date.now();
    const liveOwnerPid = process.ppid > 0 ? process.ppid : 1;
    expect(
      isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(
        {
          updateId: 51,
          path: path.join(os.tmpdir(), "51.json.processing"),
          pendingPath: path.join(os.tmpdir(), "51.json"),
          update: { update_id: 51 },
          receivedAt: now,
          claim: {
            processId: `${liveOwnerPid}:5555:other-process`,
            processPid: liveOwnerPid,
            claimedAt: now,
          },
        },
        {
          processExists: (pid) => pid === liveOwnerPid,
          readProcessStartTime: (pid) => (pid === liveOwnerPid ? 5555 : null),
        },
      ),
    ).toBe(true);
  });

  it("keeps existence-based lease protection for fresh legacy two-part owner ids", () => {
    const now = Date.now();
    const liveOwnerPid = process.ppid > 0 ? process.ppid : 1;
    // Rolling upgrade: a live pre-starttime worker still holds pid:uuid claims.
    // Stealing them while the owner process exists would double-dispatch.
    expect(
      isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(
        {
          updateId: 54,
          path: path.join(os.tmpdir(), "54.json.processing"),
          pendingPath: path.join(os.tmpdir(), "54.json"),
          update: { update_id: 54 },
          receivedAt: now,
          claim: {
            processId: `${liveOwnerPid}:legacy-owner`,
            processPid: liveOwnerPid,
            claimedAt: now,
          },
        },
        {
          processExists: () => true,
          readProcessStartTime: () => 1,
        },
      ),
    ).toBe(true);
  });

  it("does not treat malformed owner ids as live-owned", () => {
    const now = Date.now();
    const liveOwnerPid = process.ppid > 0 ? process.ppid : 1;
    expect(
      isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(
        {
          updateId: 55,
          path: path.join(os.tmpdir(), "55.json.processing"),
          pendingPath: path.join(os.tmpdir(), "55.json"),
          update: { update_id: 55 },
          receivedAt: now,
          claim: {
            processId: `${liveOwnerPid}:not-a-starttime:owner-uuid`,
            processPid: liveOwnerPid,
            claimedAt: now,
          },
        },
        {
          processExists: () => true,
          readProcessStartTime: () => 1,
        },
      ),
    ).toBe(false);
  });

  it("treats explicit x start tokens as existence-only live owners", () => {
    const now = Date.now();
    const liveOwnerPid = process.ppid > 0 ? process.ppid : 1;
    // win32 writers emit pid:x:uuid when starttime is unavailable; keep the
    // pre-starttime processExists multi-instance lease contract.
    expect(
      isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(
        {
          updateId: 55,
          path: path.join(os.tmpdir(), "55.json.processing"),
          pendingPath: path.join(os.tmpdir(), "55.json"),
          update: { update_id: 55 },
          receivedAt: now,
          claim: {
            processId: `${liveOwnerPid}:x:win32-owner`,
            processPid: liveOwnerPid,
            claimedAt: now,
          },
        },
        {
          processExists: (pid) => pid === liveOwnerPid,
          readProcessStartTime: () => null,
        },
      ),
    ).toBe(true);
    expect(
      isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(
        {
          updateId: 56,
          path: path.join(os.tmpdir(), "56.json.processing"),
          pendingPath: path.join(os.tmpdir(), "56.json"),
          update: { update_id: 56 },
          receivedAt: now,
          claim: {
            processId: "99999:x:dead-win32-owner",
            processPid: 99999,
            claimedAt: now,
          },
        },
        {
          processExists: () => false,
          readProcessStartTime: () => null,
        },
      ),
    ).toBe(false);
  });
});
