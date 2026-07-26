// Telegram tests cover update offset store plugin behavior.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";
import {
  TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
  TELEGRAM_UPDATE_OFFSET_NAMESPACE,
  deleteTelegramUpdateOffset,
  listTelegramLegacyUpdateOffsetEntries,
  readTelegramUpdateOffset,
  shouldReplaceTelegramUpdateOffsetEntry,
  writeTelegramUpdateOffset,
} from "./update-offset-store.js";

type TelegramUpdateOffsetState = Awaited<
  ReturnType<typeof listTelegramLegacyUpdateOffsetEntries>
>[number]["value"];

describe("deleteTelegramUpdateOffset", () => {
  let updateOffsetStore: PluginStateKeyedStore<TelegramUpdateOffsetState>;

  function installStore(store: PluginStateKeyedStore<TelegramUpdateOffsetState>): void {
    updateOffsetStore = store;
    setTelegramRuntime({
      state: {
        openKeyedStore: (() => updateOffsetStore) as TelegramRuntime["state"]["openKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);
  }

  beforeEach(async () => {
    installStore(
      createPluginStateKeyedStoreForTests<TelegramUpdateOffsetState>("telegram", {
        namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
        maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
      }),
    );
    await updateOffsetStore.clear();
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
  });

  it("removes the offset row so a new bot starts fresh", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({ accountId: "default", updateId: 432_000_000 });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBe(432_000_000);

      await deleteTelegramUpdateOffset({ accountId: "default" });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
    });
  });

  it("keeps a missing offset row absent after delete", async () => {
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

  it("surfaces plugin-state write failures", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      installStore({
        ...createPluginStateKeyedStoreForTests<TelegramUpdateOffsetState>("telegram", {
          namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
          maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
        }),
        async register() {
          throw new Error("store write failed");
        },
      });

      await expect(
        writeTelegramUpdateOffset({ accountId: "default", updateId: 808 }),
      ).rejects.toThrow("store write failed");
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

  it("invokes onRotationDetected for imported legacy offsets without bot identity", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await updateOffsetStore.register("default", {
        version: 1,
        lastUpdateId: 777,
      } as TelegramUpdateOffsetState);

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

  it("returns null when the plugin-state read fails", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      installStore({
        ...createPluginStateKeyedStoreForTests<TelegramUpdateOffsetState>("telegram", {
          namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
          maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
        }),
        async lookup() {
          throw new Error("store unavailable");
        },
      });

      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBeNull();
    });
  });

  it("lets migration replace stale plugin-state with a higher compatible imported offset", () => {
    const token = "111111:current";
    expect(
      shouldReplaceTelegramUpdateOffsetEntry({
        botToken: token,
        existingValue: {
          version: 3,
          lastUpdateId: 10,
          botId: "111111",
          tokenFingerprint: fingerprintTelegramBotToken(token),
        },
        incomingValue: {
          version: 3,
          lastUpdateId: 20,
          botId: "111111",
          tokenFingerprint: fingerprintTelegramBotToken(token),
        },
      }),
    ).toBe(true);
  });

  it("keeps plugin-state when the imported offset belongs to another bot", () => {
    const token = "111111:current";
    expect(
      shouldReplaceTelegramUpdateOffsetEntry({
        botToken: token,
        existingValue: {
          version: 3,
          lastUpdateId: 10,
          botId: "111111",
          tokenFingerprint: fingerprintTelegramBotToken(token),
        },
        incomingValue: {
          version: 3,
          lastUpdateId: 999,
          botId: "222222",
          tokenFingerprint: "stale",
        },
      }),
    ).toBe(false);
  });

  it("keeps plugin-state across persisted bot-id conflicts when no token is available", () => {
    expect(
      shouldReplaceTelegramUpdateOffsetEntry({
        existingValue: {
          version: 3,
          lastUpdateId: 10,
          botId: "111111",
          tokenFingerprint: "current-fingerprint",
        },
        incomingValue: {
          version: 3,
          lastUpdateId: 999,
          botId: "222222",
          tokenFingerprint: "stale-fingerprint",
        },
      }),
    ).toBe(false);
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

  it("treats imported v2 bot-id-only offsets as stale when token identity cannot be verified", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await updateOffsetStore.register("default", {
        version: 2,
        lastUpdateId: 999,
        botId: "111111",
      } as TelegramUpdateOffsetState);

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
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          cleaned = true;
        },
      });

      expect(offset).toBeNull();
      expect(cleaned).toBe(true);
    });
  });

  it("treats imported legacy offset records without bot identity as stale when token is provided", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await updateOffsetStore.register("default", {
        version: 1,
        lastUpdateId: 777,
      } as TelegramUpdateOffsetState);

      expect(
        await readTelegramUpdateOffset({
          accountId: "default",
          botToken: "333333:token-c",
        }),
      ).toBeNull();
    });
  });

  it("ignores invalid persisted update IDs from plugin-state", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await updateOffsetStore.register("default", {
        version: 2,
        lastUpdateId: -1,
        botId: "111111",
      } as TelegramUpdateOffsetState);
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();

      await updateOffsetStore.register("default", {
        version: 2,
        lastUpdateId: "not-a-number",
        botId: "111111",
      } as unknown as TelegramUpdateOffsetState);
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
