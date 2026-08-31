import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientEvent, createClient, type ISyncResponse } from "matrix-js-sdk/lib/matrix.js";
import { RustCrypto } from "matrix-js-sdk/lib/rust-crypto/rust-crypto.js";
import { SyncState } from "matrix-js-sdk/lib/sync.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import { SqliteBackedMatrixSyncStore } from "./file-sync-store.js";

const userId = "@recipient:example.org";
const roomId = "!verification:example.org";
const cachedEventId = "$completed-verification";
const liveEventId = "$fresh-verification";

function verificationSync(nextBatch: string, eventId: string): ISyncResponse {
  return {
    next_batch: nextBatch,
    rooms: {
      invite: {},
      leave: {},
      knock: {},
      join: {
        [roomId]: {
          summary: { "m.heroes": [] },
          state: { events: [] },
          timeline: {
            prev_batch: "pagination-cursor",
            events: [
              {
                event_id: eventId,
                sender: "@sender:example.org",
                origin_server_ts: 1,
                type: "m.room.message",
                content: {
                  msgtype: "m.key.verification.request",
                  body: "Verification request",
                  to: userId,
                  from_device: "SENDER",
                  methods: ["m.sas.v1"],
                },
              },
            ],
          },
          ephemeral: { events: [] },
          account_data: { events: [] },
          unread_notifications: {},
        },
      },
    },
    account_data: { events: [] },
  };
}

describe("Matrix SDK sync-cache verification routing", () => {
  let storageRoot: string;

  beforeEach(() => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sync-sdk-"));
    // SDK HTTP deadlines leave timers after completed requests. Advance them only
    // after the real sync loop stops, without delaying this contract test by 80s.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetPluginStateStoreForTests();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it.each([false, true])(
    "routes only fresh verification events to crypto (saved sync: %s)",
    async (hasCache) => {
      if (hasCache) {
        const seed = new SqliteBackedMatrixSyncStore(storageRoot);
        await seed.setSyncData(verificationSync("saved-cursor", cachedEventId));
        seed.markCleanShutdown();
        await seed.flush();
        resetPluginStateStoreForTests();
      }
      const store = new SqliteBackedMatrixSyncStore(storageRoot);
      expect(store.hasSavedSyncFromCleanShutdown()).toBe(hasCache);
      await expect(store.getSavedSyncToken()).resolves.toBe(hasCache ? "saved-cursor" : null);

      const cachedPrepared = createDeferred<void>();
      if (!hasCache) {
        cachedPrepared.resolve();
      }
      const stopped = createDeferred<void>();
      const failed = createDeferred<never>();
      const completed = Promise.race([stopped.promise, failed.promise]);
      const events: Array<string | undefined> = [];
      const syncRequests: Array<string | null> = [];
      const unexpectedRequests: string[] = [];
      const fetchFixture: typeof fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        expect(url.origin).toBe("https://example.org");
        const endpoint = url.pathname;
        if (endpoint === "/.well-known/matrix/client") {
          return Response.json({}, { status: 404 });
        }
        if (endpoint.endsWith("/versions")) {
          return Response.json({ versions: ["v1.11"], unstable_features: {} });
        }
        if (endpoint.endsWith("/capabilities")) {
          return Response.json({ capabilities: {} });
        }
        if (endpoint.endsWith("/rtc/transports") || endpoint.endsWith("/room_keys/version")) {
          return Response.json(
            { errcode: "M_NOT_FOUND", error: "Not configured" },
            { status: 404 },
          );
        }
        if (endpoint.endsWith("/pushrules/")) {
          return Response.json({
            global: { override: [], content: [], room: [], sender: [], underride: [] },
          });
        }
        if (endpoint.endsWith("/filter")) {
          return Response.json({ filter_id: "fixture-filter" });
        }
        if (endpoint.endsWith("/keys/upload")) {
          return Response.json({ one_time_key_counts: { signed_curve25519: 100 } });
        }
        if (endpoint.endsWith("/keys/query")) {
          return Response.json({ device_keys: {}, failures: {} });
        }
        if (endpoint.endsWith("/sync")) {
          syncRequests.push(url.searchParams.get("since"));
          await cachedPrepared.promise;
          return Response.json(verificationSync("fresh-cursor", liveEventId));
        }
        unexpectedRequests.push(endpoint);
        const error = new Error(`Unexpected fixture request: ${endpoint}`);
        failed.reject(error);
        throw error;
      };
      // AutoDiscovery uses global fetch independently of the client fetch option.
      vi.stubGlobal("fetch", fetchFixture);
      const client = createClient({
        baseUrl: "https://example.org",
        userId,
        deviceId: "RECIPIENT",
        accessToken: "test-token",
        fetchFn: fetchFixture,
        store,
      });
      // Keep real client, Rust initialization and sync wiring; observe only the
      // verification boundary so the test does not invent peer crypto responses.
      const cryptoInput = vi
        .spyOn(RustCrypto.prototype, "onLiveEventFromSync")
        .mockResolvedValue(undefined);
      client.on(ClientEvent.Event, (event) => events.push(event.getId()));
      client.on(ClientEvent.SyncUnexpectedError, (error) => failed.reject(error));
      client.on(ClientEvent.Sync, (state, _previous, data) => {
        if (state === SyncState.Prepared && data?.fromCache) {
          cachedPrepared.resolve();
        }
        if (state === SyncState.Syncing) {
          client.stopClient();
        }
        if (state === SyncState.Stopped) {
          stopped.resolve();
        }
      });
      let started = false;
      try {
        await client.initRustCrypto({ useIndexedDB: false });
        await client.startClient();
        started = true;
        await completed;
        expect(unexpectedRequests).toEqual([]);
        expect(syncRequests).toEqual([hasCache ? "saved-cursor" : null]);
        expect(events).toEqual(hasCache ? [cachedEventId, liveEventId] : [liveEventId]);
        expect(
          client
            .getRoom(roomId)
            ?.getLiveTimeline()
            .getEvents()
            .map((event) => event.getId()),
        ).toEqual(events);
        expect(store.getSyncToken()).toBe("fresh-cursor");
        expect(cryptoInput.mock.calls.map(([event]) => event.getId())).toEqual([liveEventId]);
      } finally {
        client.stopClient();
        if (started) {
          await stopped.promise;
        }
        await store.flush();
      }
    },
  );
});
