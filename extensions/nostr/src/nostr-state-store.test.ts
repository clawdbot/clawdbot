import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import {
  readNostrBusState,
  readNostrProfileState,
  writeNostrBusState,
  writeNostrProfileState,
  computeSinceTimestamp,
} from "./nostr-state-store.js";
import { setNostrRuntime } from "./runtime.js";

async function withTempStateDir<T>(fn: (dir: string) => Promise<T>) {
  const previous = process.env.OPENCLAW_STATE_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-"));
  process.env.OPENCLAW_STATE_DIR = dir;
  setNostrRuntime({
    state: {
      resolveStateDir: (env, homedir) => {
        const stateEnv = env ?? process.env;
        const override = stateEnv.OPENCLAW_STATE_DIR?.trim();
        if (override) {
          return override;
        }
        const resolveHome = homedir ?? os.homedir;
        return path.join(resolveHome(), ".openclaw");
      },
    },
  } as PluginRuntime);
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("nostr bus state store", () => {
  it("persists and reloads state across restarts", async () => {
    await withTempStateDir(async () => {
      // Fresh start - no state
      expect(await readNostrBusState({ accountId: "test-bot" })).toBeNull();

      // Write state
      await writeNostrBusState({
        accountId: "test-bot",
        lastProcessedAt: 1700000000,
        gatewayStartedAt: 1700000100,
      });

      // Read it back
      const state = await readNostrBusState({ accountId: "test-bot" });
      expect(state).toEqual({
        version: 2,
        lastProcessedAt: 1700000000,
        gatewayStartedAt: 1700000100,
        recentEventIds: [],
      });
    });
  });

  it("isolates state by accountId", async () => {
    await withTempStateDir(async () => {
      await writeNostrBusState({
        accountId: "bot-a",
        lastProcessedAt: 1000,
        gatewayStartedAt: 1000,
      });
      await writeNostrBusState({
        accountId: "bot-b",
        lastProcessedAt: 2000,
        gatewayStartedAt: 2000,
      });

      const stateA = await readNostrBusState({ accountId: "bot-a" });
      const stateB = await readNostrBusState({ accountId: "bot-b" });

      expect(stateA?.lastProcessedAt).toBe(1000);
      expect(stateB?.lastProcessedAt).toBe(2000);
    });
  });

  it("upgrades v1 bus state files on read", async () => {
    await withTempStateDir(async (dir) => {
      const filePath = path.join(dir, "nostr", "bus-state-test-bot.json");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          lastProcessedAt: 1700000000,
          gatewayStartedAt: 1700000100,
        }),
        "utf-8",
      );

      const state = await readNostrBusState({ accountId: "test-bot" });
      expect(state).toEqual({
        version: 2,
        lastProcessedAt: 1700000000,
        gatewayStartedAt: 1700000100,
        recentEventIds: [],
      });
    });
  });

  it("drops malformed recent event ids while keeping the state", async () => {
    await withTempStateDir(async (dir) => {
      const filePath = path.join(dir, "nostr", "bus-state-test-bot.json");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: 2,
          lastProcessedAt: 1700000000,
          gatewayStartedAt: 1700000100,
          recentEventIds: ["evt-1", 2, null],
        }),
        "utf-8",
      );

      const state = await readNostrBusState({ accountId: "test-bot" });
      expect(state).toEqual({
        version: 2,
        lastProcessedAt: 1700000000,
        gatewayStartedAt: 1700000100,
        recentEventIds: ["evt-1"],
      });
    });
  });
});

describe("nostr profile state store", () => {
  it("persists and reloads profile publish state", async () => {
    await withTempStateDir(async () => {
      await writeNostrProfileState({
        accountId: "test-bot",
        lastPublishedAt: 1700000000,
        lastPublishedEventId: "evt-1",
        lastPublishResults: {
          "wss://relay.example": "ok",
        },
      });

      const state = await readNostrProfileState({ accountId: "test-bot" });
      expect(state).toEqual({
        version: 1,
        lastPublishedAt: 1700000000,
        lastPublishedEventId: "evt-1",
        lastPublishResults: {
          "wss://relay.example": "ok",
        },
      });
    });
  });

  it("drops malformed relay results while keeping valid state fields", async () => {
    await withTempStateDir(async (dir) => {
      const filePath = path.join(dir, "nostr", "profile-state-test-bot.json");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          lastPublishedAt: 1700000000,
          lastPublishedEventId: "evt-1",
          lastPublishResults: {
            "wss://relay.example": "ok",
            "wss://relay.bad": "unknown",
          },
        }),
        "utf-8",
      );

      const state = await readNostrProfileState({ accountId: "test-bot" });
      expect(state).toEqual({
        version: 1,
        lastPublishedAt: 1700000000,
        lastPublishedEventId: "evt-1",
        lastPublishResults: null,
      });
    });
  });
});

describe("computeSinceTimestamp", () => {
  it("returns now for null state (fresh start)", () => {
    const now = 1700000000;
    expect(computeSinceTimestamp(null, now)).toBe(now);
  });

  it("uses lastProcessedAt when available", () => {
    const state: Parameters<typeof computeSinceTimestamp>[0] = {
      version: 2,
      lastProcessedAt: 1699999000,
      gatewayStartedAt: null,
      recentEventIds: [],
    };
    expect(computeSinceTimestamp(state, 1700000000)).toBe(1699999000);
  });

  it("uses gatewayStartedAt when lastProcessedAt is null", () => {
    const state: Parameters<typeof computeSinceTimestamp>[0] = {
      version: 2,
      lastProcessedAt: null,
      gatewayStartedAt: 1699998000,
      recentEventIds: [],
    };
    expect(computeSinceTimestamp(state, 1700000000)).toBe(1699998000);
  });

  it("uses the max of both timestamps", () => {
    const state: Parameters<typeof computeSinceTimestamp>[0] = {
      version: 2,
      lastProcessedAt: 1699999000,
      gatewayStartedAt: 1699998000,
      recentEventIds: [],
    };
    expect(computeSinceTimestamp(state, 1700000000)).toBe(1699999000);
  });

  it("falls back to now if both are null", () => {
    const state: Parameters<typeof computeSinceTimestamp>[0] = {
      version: 2,
      lastProcessedAt: null,
      gatewayStartedAt: null,
      recentEventIds: [],
    };
    expect(computeSinceTimestamp(state, 1700000000)).toBe(1700000000);
  });
});
