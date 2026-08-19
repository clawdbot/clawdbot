// Matrix tests cover the shared lifecycle with the real SDK, HTTP, and SQLite store.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { matrixOutbound } from "../../outbound.js";
import type { PluginRuntime } from "../../runtime-api.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import type { CoreConfig } from "../../types.js";
import { registerMatrixMonitorEvents } from "../monitor/events.js";
import { resolveMatrixAuth } from "./config.js";
import { SqliteBackedMatrixSyncStore } from "./file-sync-store.js";
import {
  acquireSharedMatrixClient,
  stopSharedClientForAccount,
  type SharedMatrixClientLease,
} from "./shared.js";
import { resolveMatrixStoragePaths } from "./storage.js";

const ROOM_ID = "!room:localhost";
const BOT_USER_ID = "@bot:localhost";
const REMOTE_USER_ID = "@alice:localhost";
const OUTBOUND_EVENT_ID = "$outbound";
const INBOUND_EVENT_IDS = Array.from({ length: 60 }, (_, index) => `$inbound-${index}`);

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function respondJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readRequestJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function buildSync(nextBatch: string, eventIds: string[]) {
  const now = Date.now();
  const member = (userId: string) => ({
    event_id: `$member-${userId}`,
    type: "m.room.member",
    state_key: userId,
    sender: userId,
    origin_server_ts: now,
    content: { membership: "join" },
  });
  return {
    next_batch: nextBatch,
    presence: { events: [] },
    account_data: { events: [] },
    to_device: { events: [] },
    device_lists: { changed: [], left: [] },
    device_one_time_keys_count: {},
    rooms: {
      invite: {},
      leave: {},
      knock: {},
      join: {
        [ROOM_ID]: {
          summary: {
            "m.heroes": [REMOTE_USER_ID],
            "m.joined_member_count": 2,
            "m.invited_member_count": 0,
          },
          state: { events: [member(BOT_USER_ID), member(REMOTE_USER_ID)] },
          timeline: {
            limited: false,
            prev_batch: "p0",
            events: eventIds.map((eventId, index) => ({
              event_id: eventId,
              type: "m.room.message",
              sender: REMOTE_USER_ID,
              origin_server_ts: now + index,
              content: { msgtype: "m.text", body: `inbound before monitor ${index}` },
            })),
          },
          ephemeral: { events: [] },
          account_data: { events: [] },
          unread_notifications: { highlight_count: 0, notification_count: 0 },
        },
      },
    },
  };
}

describe("shared Matrix lifecycle with the real SDK", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("recovers a transient-first burst from the authoritative cursor after monitor admission", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-shared-real-"));
    const sendRequested = createDeferred<void>();
    const allowSend = createDeferred<void>();
    const pendingSyncResponses = new Set<http.ServerResponse>();
    const unexpectedRequests: string[] = [];
    const syncSinceValues: Array<string | null> = [];
    const sentBodies: unknown[] = [];
    let savedFilter: unknown = {};
    let burstSyncCount = 0;

    const handleRequest = async (
      request: http.IncomingMessage,
      response: http.ServerResponse,
    ): Promise<void> => {
      try {
        const method = request.method ?? "GET";
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const requestLabel = `${method} ${url.pathname}`;
        if (url.pathname === "/_matrix/client/versions") {
          respondJson(response, 200, { versions: ["v1.11"], unstable_features: {} });
          return;
        }
        if (url.pathname.endsWith("/pushrules/")) {
          respondJson(response, 200, {
            global: { override: [], content: [], room: [], sender: [], underride: [] },
          });
          return;
        }
        if (method === "POST" && url.pathname.endsWith("/filter")) {
          savedFilter = await readRequestJson(request);
          respondJson(response, 200, { filter_id: "0" });
          return;
        }
        if (method === "GET" && url.pathname.endsWith("/filter/0")) {
          respondJson(response, 200, savedFilter);
          return;
        }
        if (url.pathname.endsWith("/capabilities")) {
          respondJson(response, 200, { capabilities: {} });
          return;
        }
        if (url.pathname.endsWith("/account_data/m.direct")) {
          respondJson(response, 200, {});
          return;
        }
        if (url.pathname.endsWith("/state/m.room.encryption/")) {
          respondJson(response, 404, { errcode: "M_NOT_FOUND", error: "not encrypted" });
          return;
        }
        if (method === "GET" && url.pathname.endsWith("/sync")) {
          const since = url.searchParams.get("since");
          syncSinceValues.push(since);
          if (since === "s0") {
            burstSyncCount += 1;
            respondJson(
              response,
              200,
              buildSync(burstSyncCount === 1 ? "s1" : "s2", INBOUND_EVENT_IDS),
            );
            return;
          }
          pendingSyncResponses.add(response);
          response.once("close", () => pendingSyncResponses.delete(response));
          return;
        }
        if (method === "PUT" && url.pathname.includes("/send/m.room.message/")) {
          sentBodies.push(await readRequestJson(request));
          sendRequested.resolve();
          await allowSend.promise;
          respondJson(response, 200, { event_id: OUTBOUND_EVENT_ID });
          return;
        }
        unexpectedRequests.push(requestLabel);
        respondJson(response, 404, { errcode: "M_UNRECOGNIZED", error: requestLabel });
      } catch (error) {
        if (!response.headersSent) {
          respondJson(response, 500, { error: String(error) });
        } else {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };
    const server = http.createServer((request, response) => {
      void handleRequest(request, response);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Matrix test server did not bind a TCP port");
    }
    const homeserver = `http://127.0.0.1:${address.port}`;
    const cleanupState: {
      auth?: Awaited<ReturnType<typeof resolveMatrixAuth>>;
      monitorTask?: Promise<unknown>;
      outboundPromise?: Promise<unknown>;
    } = {};
    let monitorLease: SharedMatrixClientLease | undefined;
    cleanup = async () => {
      allowSend.resolve();
      for (const response of pendingSyncResponses) {
        response.destroy();
      }
      const serverClosed = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      server.closeAllConnections();
      await monitorLease?.release({ mode: "persist" }).catch(() => undefined);
      if (cleanupState.auth) {
        await stopSharedClientForAccount(cleanupState.auth).catch(() => undefined);
      }
      await Promise.allSettled([cleanupState.outboundPromise, cleanupState.monitorTask]);
      await serverClosed;
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    };
    const cfg = {
      channels: {
        matrix: {
          homeserver,
          userId: BOT_USER_ID,
          accessToken: "test-access-token",
          encryption: false,
          network: { dangerouslyAllowPrivateNetwork: true },
        },
      },
    } as CoreConfig;
    installMatrixTestRuntime({
      cfg,
      stateDir,
      channel: {
        text: {
          resolveMarkdownTableMode: () => "code",
          resolveTextChunkLimit: () => 4_000,
        },
      } as unknown as PluginRuntime["channel"],
    });
    const auth = await resolveMatrixAuth({ cfg });
    cleanupState.auth = auth;
    const storagePaths = resolveMatrixStoragePaths({
      homeserver: auth.homeserver,
      userId: auth.userId,
      accessToken: auth.accessToken,
      deviceId: auth.deviceId,
      accountId: auth.accountId,
    });
    const seedStore = new SqliteBackedMatrixSyncStore(storagePaths.rootDir);
    await seedStore.setSyncData(buildSync("s0", []));
    seedStore.markCleanShutdown();
    await seedStore.flush();

    const outboundPromise = matrixOutbound.sendText!({
      cfg,
      to: `room:${ROOM_ID}`,
      text: "outbound proof",
      accountId: "default",
    });
    cleanupState.outboundPromise = outboundPromise;
    await Promise.race([
      sendRequested.promise,
      outboundPromise.then(() => {
        throw new Error("Matrix outbound completed before its HTTP send was observed");
      }),
    ]);
    const afterTransientSync = new SqliteBackedMatrixSyncStore(storagePaths.rootDir);
    expect(afterTransientSync.hasSavedSyncFromCleanShutdown()).toBe(true);
    expect(await afterTransientSync.getSavedSyncToken()).toBe("s0");

    const receivedEventIds: string[] = [];
    let acquiredBeforeOutboundCompleted = false;
    let outboundCompleted = false;
    const monitorPromise = acquireSharedMatrixClient({
      auth,
      role: "monitor",
      startClient: false,
    }).then(async (lease) => {
      monitorLease = lease;
      acquiredBeforeOutboundCompleted = !outboundCompleted;
      const monitorNetworkSync = createDeferred<void>();
      const onSyncState = (state: string) => {
        if (state === "SYNCING") {
          monitorNetworkSync.resolve();
        }
      };
      lease.client.on("sync.state", onSyncState);
      const disposeEvents = registerMatrixMonitorEvents({
        cfg,
        client: lease.client,
        auth,
        allowFrom: [],
        dmEnabled: true,
        dmPolicy: "open",
        readStoreAllowFrom: async () => [],
        logVerboseMessage: () => {},
        warnedEncryptedRooms: new Set(),
        warnedCryptoMissingRooms: new Set(),
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        formatNativeDependencyHint: () => "",
        onRoomMessage: (_roomId, event) => {
          if (event.type === "m.room.message") {
            receivedEventIds.push(event.event_id);
          }
        },
        runDetachedTask: async (_label, task) => await task(),
      });
      await lease.start();
      if (!acquiredBeforeOutboundCompleted) {
        await monitorNetworkSync.promise;
      }
      lease.client.off("sync.state", onSyncState);
      return { disposeEvents, lease };
    });
    cleanupState.monitorTask = monitorPromise;

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    allowSend.resolve();
    const outbound = await outboundPromise;
    outboundCompleted = true;
    const monitor = await monitorPromise;

    expect(outbound).toMatchObject({
      channel: "matrix",
      messageId: OUTBOUND_EVENT_ID,
      roomId: ROOM_ID,
    });
    expect(sentBodies).toEqual([
      expect.objectContaining({ msgtype: "m.text", body: "outbound proof" }),
    ]);
    expect(receivedEventIds).toEqual(INBOUND_EVENT_IDS);
    expect(acquiredBeforeOutboundCompleted).toBe(false);
    expect(syncSinceValues.filter((since) => since === "s0")).toEqual(["s0", "s0"]);
    expect(unexpectedRequests).toEqual([]);

    monitor.disposeEvents();
    await monitor.lease.release({ mode: "persist" });
    monitorLease = undefined;
    const reloadedStore = new SqliteBackedMatrixSyncStore(storagePaths.rootDir);
    expect(reloadedStore.hasSavedSyncFromCleanShutdown()).toBe(true);
    expect(await reloadedStore.getSavedSyncToken()).toBe("s2");
  });
});
