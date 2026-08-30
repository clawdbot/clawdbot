// Root-owned integration may combine the public Slack plugin with the durable queue runtime.
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

const CLASSIFIED_CODES = ["messages_tab_disabled", "account_inactive"] as const;
const DELIVERY_INTENT_PREFIX = "slack-loopback-permanent-rejection";

type SlackPermanentRejectionCode = (typeof CLASSIFIED_CODES)[number];

type SlackLoopbackRequest = {
  body: string;
  code?: SlackPermanentRejectionCode;
  method: string | undefined;
  text: string;
  url: string;
};

type SlackLoopback = {
  apiUrl: string;
  requests: SlackLoopbackRequest[];
  close: () => Promise<void>;
};

function readQueueTerminal(
  stateDir: string,
  intentId: string,
): { retryCount: number; status: string } | undefined {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const row = db
    // sqlite-allow-raw: The proof reads one exact queue owner after terminalization.
    .prepare(
      "SELECT status, retry_count FROM delivery_queue_entries WHERE queue_name = ? AND id = ?",
    )
    .get(OUTBOUND_DELIVERY_QUEUE_NAME, intentId) as
    | { retry_count: number; status: string }
    | undefined;
  return row ? { retryCount: row.retry_count, status: row.status } : undefined;
}

async function startSlackPermanentRejectionLoopback(): Promise<SlackLoopback> {
  const requests: SlackLoopbackRequest[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const text = new URLSearchParams(body).get("text") ?? "";
      const code = CLASSIFIED_CODES.find((candidate) => text.includes(candidate));
      requests.push({
        body,
        ...(code ? { code } : {}),
        method: request.method,
        text,
        url: request.url ?? "",
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: code ?? "unexpected_test_request" }));
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
    apiUrl: `http://127.0.0.1:${port}/api/`,
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

describe("Slack permanent rejections over real Web API transport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("dead-letters both real platform rejections and never replays them after restart", async () => {
    const loopback = await startSlackPermanentRejectionLoopback();
    vi.stubEnv("SLACK_API_URL", loopback.apiUrl);
    try {
      const { slackPlugin } = await import("../extensions/slack/api.js");
      const cfg = {
        channels: { slack: { botToken: "xoxb-loopback" } },
      } satisfies OpenClawConfig;
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "slack", plugin: slackPlugin, source: "test" }]),
      );

      await withStateDirEnv("openclaw-slack-permanent-loopback-", async ({ stateDir }) => {
        try {
          const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
          for (const [index, code] of CLASSIFIED_CODES.entries()) {
            const intentId = `${DELIVERY_INTENT_PREFIX}-${code}`;
            const text = `real transport permanent rejection: ${code}`;
            const staged = await sendDurableMessageBatch({
              cfg,
              channel: "slack",
              to: "channel:C123",
              accountId: "default",
              durability: "required",
              deliveryIntentId: intentId,
              completionRetention: {
                idPrefix: "slack-loopback-",
                maxAgeMs: 60_000,
                maxEntries: 10,
              },
              maxRetries: 10,
              payloads: [{ text }],
              deps: {
                slack: async () => {
                  throw new PlatformMessageNotDispatchedError(
                    "staged before transport for recovery proof",
                    { cause: new Error("loopback transport not released yet") },
                  );
                },
              },
            });
            expect(staged.status).toBe("failed");
            expect(loopback.requests).toHaveLength(index);
            expect(
              getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, intentId, stateDir),
            ).toBe("pending");

            log.warn.mockClear();
            await drainPendingDeliveries({
              drainKey: `slack:default:${code}`,
              logLabel: `Slack loopback ${code} recovery`,
              cfg,
              stateDir,
              log,
              selectEntry: (entry) => ({
                match: entry.id === intentId,
                bypassBackoff: true,
              }),
            });

            expect(loopback.requests).toHaveLength(index + 1);
            expect(loopback.requests[index]).toMatchObject({
              code,
              method: "POST",
              text,
              url: "/api/chat.postMessage",
            });
            expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(code));
            expect(readQueueTerminal(stateDir, intentId)).toEqual({
              retryCount: 1,
              status: "failed",
            });
          }

          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabaseForTest();
          for (const code of CLASSIFIED_CODES) {
            expect(
              getDeliveryQueueEntryStatus(
                OUTBOUND_DELIVERY_QUEUE_NAME,
                `${DELIVERY_INTENT_PREFIX}-${code}`,
                stateDir,
              ),
            ).toBe("failed");
          }

          await drainPendingDeliveries({
            drainKey: "slack:default:post-restart",
            logLabel: "Slack loopback post-restart recovery",
            cfg,
            stateDir,
            log,
            selectEntry: (entry) => ({
              match: entry.channel === "slack",
              bypassBackoff: true,
            }),
          });
          expect(loopback.requests).toHaveLength(CLASSIFIED_CODES.length);

          console.log(
            `[slack permanent-rejection proof] ${JSON.stringify({
              queueTerminal: "failed",
              restartReplayCount: 0,
              providerStatus: 200,
              classifiedCodes: CLASSIFIED_CODES,
              classification: "typed non-retryable",
              transport: "@slack/web-api HTTP to 127.0.0.1:<redacted>",
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
