import fs from "node:fs/promises";
import path from "node:path";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  deleteTelegramUpdateOffset,
  readTelegramUpdateOffset,
  writeTelegramUpdateOffset,
} from "./update-offset-store.js";

describe("deleteTelegramUpdateOffset", () => {
  it("removes the offset file so a new bot starts fresh", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({ accountId: "default", updateId: 432_000_000 });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBe(432_000_000);

      await deleteTelegramUpdateOffset({ accountId: "default" });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
    });
  });

  it("keeps a missing offset file absent after delete", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await deleteTelegramUpdateOffset({ accountId: "nonexistent" });
      expect(await readTelegramUpdateOffset({ accountId: "nonexistent" })).toBeNull();
    });
  });

  it("only removes the targeted account offset, leaving others intact", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({ accountId: "default", updateId: 100 });
      await writeTelegramUpdateOffset({ accountId: "alerts", updateId: 200 });

      await deleteTelegramUpdateOffset({ accountId: "default" });

      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
      expect(await readTelegramUpdateOffset({ accountId: "alerts" })).toBe(200);
    });
  });

  it("returns null when stored offset was written by a different bot token", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 321,
        botToken: "111111:token-a",
      });

      expect(
        await readTelegramUpdateOffset({
          accountId: "default",
          botToken: "222222:token-b",
        }),
      ).toBeNull();
      expect(
        await readTelegramUpdateOffset({
          accountId: "default",
          botToken: "111111:token-a",
        }),
      ).toBe(321);
    });
  });

  it("invokes onRotationDetected when the stored bot id no longer matches", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 1500,
        botToken: "111111:token-a",
      });

      const rotations: Array<Record<string, unknown>> = [];
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: "222222:token-b",
        onRotationDetected: (info) => {
          rotations.push({ ...info });
        },
      });

      expect(offset).toBeNull();
      expect(rotations).toEqual([
        {
          reason: "bot-id-changed",
          previousBotId: "111111",
          currentBotId: "222222",
          staleLastUpdateId: 1500,
        },
      ]);
    });
  });

  it("invokes onRotationDetected for legacy offsets without bot identity", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async ({ stateDir }) => {
      const legacyPath = path.join(stateDir, "telegram", "update-offset-default.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 1, lastUpdateId: 777 }, null, 2)}\n`,
        "utf-8",
      );

      const rotations: Array<Record<string, unknown>> = [];
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: "333333:token-c",
        onRotationDetected: (info) => {
          rotations.push({ ...info });
        },
      });

      expect(offset).toBeNull();
      expect(rotations).toEqual([
        {
          reason: "legacy-state",
          previousBotId: null,
          currentBotId: "333333",
          staleLastUpdateId: 777,
        },
      ]);
    });
  });

  it("detects same-bot token rotation via the persisted fingerprint", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      const original = "111111:original-secret";
      const rotated = "111111:rotated-secret";

      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 42,
        botToken: original,
      });

      expect(
        await readTelegramUpdateOffset({
          accountId: "default",
          botToken: original,
        }),
      ).toBe(42);

      const rotations: Array<Record<string, unknown>> = [];
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: rotated,
        onRotationDetected: (info) => {
          rotations.push({ ...info });
        },
      });

      expect(offset).toBeNull();
      expect(rotations).toEqual([
        {
          reason: "token-rotated",
          previousBotId: "111111",
          currentBotId: "111111",
          staleLastUpdateId: 42,
        },
      ]);
    });
  });

  it("treats v2 bot-id-only offsets as stale when token identity cannot be verified", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async ({ stateDir }) => {
      const legacyPath = path.join(stateDir, "telegram", "update-offset-default.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 2, lastUpdateId: 999, botId: "111111" }, null, 2)}\n`,
        "utf-8",
      );

      const rotations: Array<Record<string, unknown>> = [];
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: "111111:any-secret",
        onRotationDetected: (info) => {
          rotations.push({ ...info });
        },
      });

      expect(offset).toBeNull();
      expect(rotations).toEqual([
        {
          reason: "legacy-state",
          previousBotId: "111111",
          currentBotId: "111111",
          staleLastUpdateId: 999,
        },
      ]);
    });
  });

  it("awaits rotation cleanup before returning", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 42,
        botToken: "111111:original",
      });

      let cleaned = false;
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: "111111:rotated",
        onRotationDetected: async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          cleaned = true;
        },
      });

      expect(offset).toBeNull();
      expect(cleaned).toBe(true);
    });
  });

  it("treats legacy offset records without bot identity as stale when token is provided", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async ({ stateDir }) => {
      const legacyPath = path.join(stateDir, "telegram", "update-offset-default.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 1, lastUpdateId: 777 }, null, 2)}\n`,
        "utf-8",
      );

      expect(
        await readTelegramUpdateOffset({
          accountId: "default",
          botToken: "333333:token-c",
        }),
      ).toBeNull();
    });
  });

  it("ignores invalid persisted update IDs from disk", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async ({ stateDir }) => {
      const offsetPath = path.join(stateDir, "telegram", "update-offset-default.json");
      await fs.mkdir(path.dirname(offsetPath), { recursive: true });
      await fs.writeFile(
        offsetPath,
        `${JSON.stringify({ version: 2, lastUpdateId: -1, botId: "111111" }, null, 2)}\n`,
        "utf-8",
      );
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();

      await fs.writeFile(
        offsetPath,
        `${JSON.stringify({ version: 2, lastUpdateId: Number.POSITIVE_INFINITY, botId: "111111" }, null, 2)}\n`,
        "utf-8",
      );
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
    });
  });

  it("rejects writing invalid update IDs", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await expect(
        writeTelegramUpdateOffset({ accountId: "default", updateId: -1 as number }),
      ).rejects.toThrow(/non-negative safe integer/i);
    });
  });
});
