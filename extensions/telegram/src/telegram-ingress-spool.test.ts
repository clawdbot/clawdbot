import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimTelegramSpooledUpdate,
  deleteTelegramSpooledUpdate,
  isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess,
  listTelegramSpooledUpdateClaims,
  listTelegramSpooledUpdates,
  recoverStaleTelegramSpooledUpdateClaims,
  releaseTelegramSpooledUpdateClaim,
  TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS,
  writeTelegramSpooledUpdate,
} from "./telegram-ingress-spool.js";

async function withTempSpool<T>(fn: (spoolDir: string) => Promise<T>): Promise<T> {
  const spoolDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
  try {
    return await fn(spoolDir);
  } finally {
    await fs.rm(spoolDir, { recursive: true, force: true });
  }
}

describe("Telegram ingress spool", () => {
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
      await fs.writeFile(claimed.pendingPath, "duplicate pending race", { mode: 0o600 });
      await deleteTelegramSpooledUpdate(claimed);
      expect(await fs.readdir(spoolDir)).toEqual([]);
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
      expect(await fs.readdir(spoolDir)).toEqual([]);
    });
  });

  it("recovers stale processing claims without replaying fresh claims", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 40, message: { text: "fresh" } },
      });
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 41, message: { text: "stale" } },
      });
      const updates = await listTelegramSpooledUpdates({ spoolDir });
      const fresh = updates.find((update) => update.updateId === 40);
      const stale = updates.find((update) => update.updateId === 41);
      if (!fresh || !stale) {
        throw new Error("Expected spooled updates");
      }
      const claimedFresh = await claimTelegramSpooledUpdate(fresh);
      const claimedStale = await claimTelegramSpooledUpdate(stale);
      if (!claimedFresh || !claimedStale) {
        throw new Error("Expected claimed updates");
      }
      const now = Date.now();
      const oldClaimTime = new Date(now - TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS - 1);
      await fs.utimes(claimedStale.path, oldClaimTime, oldClaimTime);

      const recovered = await recoverStaleTelegramSpooledUpdateClaims({
        spoolDir,
        now,
      });

      expect(recovered).toBe(1);
      expect(
        (await listTelegramSpooledUpdates({ spoolDir })).map((update) => update.updateId),
      ).toEqual([41]);
      expect((await fs.readdir(spoolDir)).toSorted()).toEqual([
        "0000000000000040.json.processing",
        "0000000000000041.json",
      ]);
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
