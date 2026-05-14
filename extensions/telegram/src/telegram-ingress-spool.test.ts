import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteTelegramSpooledUpdate,
  listTelegramSpooledUpdates,
  writeTelegramSpooledUpdate,
} from "./telegram-ingress-spool.js";

describe("Telegram ingress spool", () => {
  it("persists updates durably in update_id order and deletes handled entries", async () => {
    const spoolDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    try {
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
    } finally {
      await fs.rm(spoolDir, { recursive: true, force: true });
    }
  });
});
