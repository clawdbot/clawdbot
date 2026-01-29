import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { acquireTelegramPollLock, TelegramPollLockError } from "./poll-lock.js";

async function withTempStateDir<T>(fn: (dir: string) => Promise<T>) {
  const previous = process.env.CLAWDBOT_STATE_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-telegram-lock-"));
  process.env.CLAWDBOT_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.CLAWDBOT_STATE_DIR;
    else process.env.CLAWDBOT_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("telegram poll lock", () => {
  it("prevents multiple concurrent pollers for same account+token", async () => {
    await withTempStateDir(async () => {
      const lock1 = await acquireTelegramPollLock({
        token: "123:abc",
        accountId: "default",
        timeoutMs: 50,
        pollIntervalMs: 5,
        staleMs: 10_000,
      });

      await expect(
        acquireTelegramPollLock({
          token: "123:abc",
          accountId: "default",
          timeoutMs: 30,
          pollIntervalMs: 5,
          staleMs: 10_000,
        }),
      ).rejects.toBeInstanceOf(TelegramPollLockError);

      await lock1.release();

      const lock2 = await acquireTelegramPollLock({
        token: "123:abc",
        accountId: "default",
        timeoutMs: 50,
        pollIntervalMs: 5,
        staleMs: 10_000,
      });
      await lock2.release();
    });
  });
});
