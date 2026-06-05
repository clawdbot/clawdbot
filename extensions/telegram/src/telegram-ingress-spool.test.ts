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
  claimTelegramSpooledUpdate,
  deleteTelegramSpooledUpdate,
  failTelegramSpooledUpdateClaim,
  isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess,
  listTelegramSpooledUpdateClaims,
  listTelegramSpooledUpdates,
  recoverStaleTelegramSpooledUpdateClaims,
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

  it("persists updates durably in update_id order and deletes handled entries", async () => {
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
      await deleteTelegramSpooledUpdate(updates[0]);

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
      await deleteTelegramSpooledUpdate(claimed);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir })).toEqual([]);
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
      await deleteTelegramSpooledUpdate(update);

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
});
