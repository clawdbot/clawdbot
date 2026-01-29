import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";

async function withTempStateDir<T>(fn: (dir: string) => Promise<T>) {
  const previous = process.env.CLAWDBOT_STATE_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-telegram-"));
  process.env.CLAWDBOT_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.CLAWDBOT_STATE_DIR;
    else process.env.CLAWDBOT_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("telegram update offset store", () => {
  it("persists and reloads the last update id", async () => {
    await withTempStateDir(async () => {
      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBeNull();

      await writeTelegramUpdateOffset({
        accountId: "primary",
        updateId: 421,
      });

      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBe(421);
    });
  });

  it("ignores invalid persisted update ids", async () => {
    await withTempStateDir(async (dir) => {
      const filePath = path.join(dir, "telegram", "update-offset-primary.json");
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      const writeRaw = async (lastUpdateId: unknown) => {
        await fs.writeFile(
          filePath,
          `${JSON.stringify({ version: 1, lastUpdateId }, null, 2)}\n`,
          "utf-8",
        );
      };

      await writeRaw(2_147_483_648);
      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBeNull();

      const backupFiles = (await fs.readdir(path.dirname(filePath))).filter((name) =>
        name.includes("update-offset-primary.json.bak.invalid."),
      );
      expect(backupFiles.length).toBe(1);

      await writeRaw(-1);
      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBeNull();

      await writeRaw(1.25);
      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBeNull();
    });
  });
});
