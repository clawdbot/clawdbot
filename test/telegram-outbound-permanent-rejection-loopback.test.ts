// Root-owned integration may combine the public Telegram plugin with the durable queue runtime.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  resetGlobalHookRunner,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDeliveryQueueEntryStatus } from "../src/infra/delivery-queue-sqlite.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../src/infra/outbound/delivery-queue-media-staging.js";

const MIGRATION_DESCRIPTION = "Bad Request: group chat was upgraded to a supergroup chat";
const DELIVERY_INTENT_ID = "telegram-loopback-permanent-rejection";

type TelegramLoopback = {
  apiRoot: string;
  requests: Array<{ body: string; method: string | undefined; url: string }>;
  close: () => Promise<void>;
};

function readQueueTerminal(stateDir: string): { retryCount: number; status: string } | undefined {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const row = db
    // sqlite-allow-raw: The proof reads one exact queue owner after terminalization.
    .prepare(
      "SELECT status, retry_count FROM delivery_queue_entries WHERE queue_name = ? AND id = ?",
    )
    .get(OUTBOUND_DELIVERY_QUEUE_NAME, DELIVERY_INTENT_ID) as
    | { retry_count: number; status: string }
    | undefined;
  return row ? { retryCount: row.retry_count, status: row.status } : undefined;
}

async function startTelegramMigrationLoopback(): Promise<TelegramLoopback> {
  const requests: TelegramLoopback["requests"] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        body: Buffer.concat(chunks).toString("utf8"),
        method: request.method,
        url: request.url ?? "",
      });
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: MIGRATION_DESCRIPTION,
          parameters: { migrate_to_chat_id: -1_001_234_567_890 },
        }),
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("Telegram permanent rejection over real Bot API transport", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("dead-letters one real migration rejection and never replays it after restart", async () => {
    const loopback = await startTelegramMigrationLoopback();
    try {
      const { telegramPlugin } = await import("../extensions/telegram/api.js");
      const cfg = {
        channels: {
          telegram: {
            botToken: "123456:loopback",
            apiRoot: loopback.apiRoot,
          },
        },
      } satisfies OpenClawConfig;
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
      );

      await withStateDirEnv("openclaw-telegram-permanent-loopback-", async ({ stateDir }) => {
        try {
          const staged = await sendDurableMessageBatch({
            cfg,
            channel: "telegram",
            to: "123",
            accountId: "default",
            durability: "required",
            deliveryIntentId: DELIVERY_INTENT_ID,
            completionRetention: {
              idPrefix: "telegram-loopback-",
              maxAgeMs: 60_000,
              maxEntries: 10,
            },
            maxRetries: 10,
            payloads: [{ text: "real transport permanent rejection" }],
            deps: {
              telegram: async () => {
                throw new PlatformMessageNotDispatchedError(
                  "staged before transport for recovery proof",
                  { cause: new Error("loopback transport not released yet") },
                );
              },
            },
          });
          expect(staged.status).toBe("failed");
          expect(loopback.requests).toHaveLength(0);
          expect(
            getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, DELIVERY_INTENT_ID, stateDir),
          ).toBe("pending");

          const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
          await drainPendingDeliveries({
            drainKey: "telegram:default",
            logLabel: "Telegram loopback permanent rejection recovery",
            cfg,
            stateDir,
            log,
            selectEntry: (entry) => ({
              match: entry.channel === "telegram",
              bypassBackoff: true,
            }),
          });

          expect(loopback.requests).toHaveLength(1);
          expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining(
              "Telegram rejected send: group migrated to supergroup -1001234567890",
            ),
          );
          expect(loopback.requests[0]).toMatchObject({ method: "POST" });
          expect(loopback.requests[0]?.url).toMatch(/\/sendMessage$/u);
          expect(loopback.requests[0]?.body).toContain("real transport permanent rejection");
          expect(readQueueTerminal(stateDir)).toEqual({ retryCount: 1, status: "failed" });

          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabaseForTest();
          expect(
            getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, DELIVERY_INTENT_ID, stateDir),
          ).toBe("failed");

          await drainPendingDeliveries({
            drainKey: "telegram:default",
            logLabel: "Telegram loopback post-restart recovery",
            cfg,
            stateDir,
            log,
            selectEntry: (entry) => ({
              match: entry.channel === "telegram",
              bypassBackoff: true,
            }),
          });
          expect(loopback.requests).toHaveLength(1);
          expect(
            getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, DELIVERY_INTENT_ID, stateDir),
          ).toBe("failed");

          console.log(
            `[telegram permanent-rejection proof] ${JSON.stringify({
              queueTerminal: "failed",
              restartReplayCount: 0,
              providerStatus: 400,
              classification: "typed non-retryable",
              transport: "grammY Bot API HTTP to 127.0.0.1:<redacted>",
            })}`,
          );
        } finally {
          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabaseForTest();
        }
      });
    } finally {
      await loopback.close();
    }
  });
});
