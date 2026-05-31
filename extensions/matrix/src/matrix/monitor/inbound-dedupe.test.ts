import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../runtime-api.js";
import { setMatrixRuntime } from "../../runtime.js";
import { LogService } from "../sdk/logger.js";
import { createMatrixInboundEventDeduper } from "./inbound-dedupe.js";

describe("Matrix inbound event dedupe", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    setMatrixRuntime({
      state: {
        openKeyedStore: (options: OpenKeyedStoreOptions) =>
          createPluginStateKeyedStoreForTests("matrix", options),
      },
    } as unknown as PluginRuntime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetPluginStateStoreForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createStoragePath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-inbound-dedupe-"));
    tempDirs.push(dir);
    return path.join(dir, "inbound-dedupe.json");
  }

  const auth = {
    accountId: "ops",
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "token",
    deviceId: "DEVICE",
  } as const;

  it("persists committed events across restarts", async () => {
    const storagePath = createStoragePath();
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$event-1" })).toBe(true);
    await first.commitEvent({
      roomId: "!room:example.org",
      eventId: "$event-1",
    });
    await first.stop();

    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });
    expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$event-1" })).toBe(false);
  });

  it("does not persist released pending claims", async () => {
    const storagePath = createStoragePath();
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$event-2" })).toBe(true);
    first.releaseEvent({ roomId: "!room:example.org", eventId: "$event-2" });
    await first.stop();

    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });
    expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$event-2" })).toBe(true);
  });

  it("prunes expired and overflowed entries on load", async () => {
    const storagePath = createStoragePath();
    fs.writeFileSync(
      storagePath,
      JSON.stringify({
        version: 1,
        entries: [
          { key: "!room:example.org|$old", ts: 10 },
          { key: "!room:example.org|$keep-1", ts: 90 },
          { key: "!room:example.org|$keep-2", ts: 95 },
          { key: "!room:example.org|$keep-3", ts: 100 },
        ],
      }),
      "utf8",
    );

    const deduper = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      ttlMs: 20,
      maxEntries: 2,
      nowMs: () => 100,
    });

    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$old" })).toBe(true);
    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$keep-1" })).toBe(true);
    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$keep-2" })).toBe(false);
    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$keep-3" })).toBe(false);
  });

  it("retains replayed backlog events based on processing time", async () => {
    const storagePath = createStoragePath();
    let now = 100;
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      ttlMs: 20,
      nowMs: () => now,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$backlog" })).toBe(true);
    await first.commitEvent({
      roomId: "!room:example.org",
      eventId: "$backlog",
    });
    await first.stop();

    now = 110;
    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      ttlMs: 20,
      nowMs: () => now,
    });
    expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$backlog" })).toBe(false);
  });

  it("imports legacy JSON entries into plugin state", async () => {
    const storagePath = createStoragePath();
    fs.writeFileSync(
      storagePath,
      JSON.stringify({
        version: 1,
        entries: [{ key: "!room:example.org|$legacy", ts: 90 }],
      }),
      "utf8",
    );

    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      ttlMs: 20,
      nowMs: () => 100,
    });
    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$legacy" })).toBe(false);

    fs.rmSync(storagePath, { force: true });
    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      ttlMs: 20,
      nowMs: () => 100,
    });
    expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$legacy" })).toBe(false);
  });

  it("keeps committed events in memory when plugin-state persistence fails", async () => {
    const storagePath = createStoragePath();
    const warnSpy = vi.spyOn(LogService, "warn").mockImplementation(() => {});
    setMatrixRuntime({
      state: {
        openKeyedStore: () => ({
          entries: async () => [],
          register: async () => {
            throw new Error("sqlite unavailable");
          },
          registerIfAbsent: async () => false,
          lookup: async () => undefined,
          consume: async () => undefined,
          delete: async () => false,
          clear: async () => {},
        }),
      },
    } as unknown as PluginRuntime);
    const deduper = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });

    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$best-effort" })).toBe(true);
    await expect(
      deduper.commitEvent({
        roomId: "!room:example.org",
        eventId: "$best-effort",
      }),
    ).resolves.toBeUndefined();
    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$best-effort" })).toBe(
      false,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "MatrixInboundDedupe",
      "Failed persisting Matrix inbound dedupe entry:",
      expect.any(Error),
    );
  });
});
