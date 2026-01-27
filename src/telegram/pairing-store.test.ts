import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  approveTelegramPairingCode,
  listTelegramPairingRequests,
  readTelegramAllowFromStore,
  upsertTelegramPairingRequest,
} from "./pairing-store.js";

async function withTempStateDir<T>(fn: (stateDir: string) => Promise<T>) {
  const previous = process.env.CLAWDBOT_STATE_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-pairing-"));
  process.env.CLAWDBOT_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.CLAWDBOT_STATE_DIR;
    else process.env.CLAWDBOT_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("telegram pairing store", () => {
  it("creates pairing request and approves it into allow store", async () => {
    await withTempStateDir(async () => {
      const created = await upsertTelegramPairingRequest({
        chatId: "123456789",
        username: "ada",
      });
      expect(created.code).toBeTruthy();

      const list = await listTelegramPairingRequests();
      expect(list).toHaveLength(1);
      expect(list[0]?.chatId).toBe("123456789");
      expect(list[0]?.code).toBe(created.code);

      const approved = await approveTelegramPairingCode({ code: created.code });
      expect(approved?.chatId).toBe("123456789");

      const listAfter = await listTelegramPairingRequests();
      expect(listAfter).toHaveLength(0);

      const allow = await readTelegramAllowFromStore();
      expect(allow).toContain("123456789");
    });
  });
});
