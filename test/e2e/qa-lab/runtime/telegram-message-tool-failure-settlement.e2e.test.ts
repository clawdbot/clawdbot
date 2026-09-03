import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import { createQaGatewayChild, writeJson } from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

type JsonObject = Record<string, unknown>;

const BOT_TOKEN = `424242:${"A".repeat(35)}`;
const CHAT_ID = -1001234;
const SENDER_ID = 777;
const FAILURE_TEXT =
  "⚠️ mock-openai/gpt-5.6-luna-alt request failed (provider internal error, HTTP 500). This is usually temporary — try again shortly.";
const RAW_ERROR_CANARY = "untrusted-provider-detail-qa-canary";

async function readRequest(req: IncomingMessage): Promise<JsonObject> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
  }
  return text ? (JSON.parse(text) as JsonObject) : {};
}

function succeed(res: ServerResponse, result: unknown = true) {
  writeJson(res, 200, { ok: true, result });
}

test("visibly settles a message-tool-only Telegram turn after a provider failure", async () => {
  const pendingPolls = new Set<ServerResponse>();
  const telegramSends: JsonObject[] = [];
  let providerRequests = 0;
  let updateDelivered = false;

  const update = {
    update_id: 1,
    message: {
      message_id: 456,
      date: 1_754_000_000,
      chat: { id: CHAT_ID, type: "supergroup", title: "QA" },
      from: { id: SENDER_ID, is_bot: false, first_name: "QA" },
      text: "Please investigate this request. This turn should visibly settle even if the agent fails.",
    },
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname.startsWith("/v1/")) {
      providerRequests += 1;
      writeJson(res, 500, { error: { message: `provider returned HTTP 500 ${RAW_ERROR_CANARY}` } });
      return;
    }

    const [, token = "", method = ""] = pathname.match(/^\/bot([^/]+)\/([^/]+)$/) ?? [];
    const body = await readRequest(req);
    if (token !== BOT_TOKEN) {
      writeJson(res, 401, { ok: false, error_code: 401, description: "Unexpected bot token" });
      return;
    }
    if (method === "getMe") {
      succeed(res, {
        id: 424242,
        is_bot: true,
        first_name: "QA Failure",
        username: "qa_failure_bot",
      });
      return;
    }
    if (method === "getUpdates") {
      if (!updateDelivered) {
        updateDelivered = true;
        succeed(res, [update]);
      } else {
        pendingPolls.add(res);
        req.on("close", () => pendingPolls.delete(res));
      }
      return;
    }
    if (method === "sendMessage") {
      telegramSends.push(body);
      succeed(res, {
        message_id: 10_000 + telegramSends.length,
        date: 1_754_000_000,
        chat: { id: CHAT_ID, type: "supergroup" },
        text: body.text,
      });
      return;
    }
    succeed(res);
  };

  await withServer(
    (req, res) => {
      void handleRequest(req, res).catch((error: unknown) => {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    },
    async (apiRoot) =>
      await withTempDir("openclaw-telegram-failure-settlement-", async (workspace) => {
        const gatewayOwner = createQaGatewayChild();
        try {
          const repoRoot = path.resolve(import.meta.dirname, "../../../..");
          await gatewayOwner.start({
            repoRoot,
            useRepoCli: true,
            providerBaseUrl: `${apiRoot}/v1`,
            transportBaseUrl: apiRoot,
            transport: {
              requiredPluginIds: ["telegram"],
              createGatewayConfig: () => ({
                channels: {
                  telegram: {
                    enabled: true,
                    defaultAccount: "proof",
                    accounts: {
                      proof: {
                        enabled: true,
                        botToken: BOT_TOKEN,
                        apiRoot,
                        groupPolicy: "open",
                        silentErrorReplies: true,
                        groups: {
                          [String(CHAT_ID)]: {
                            groupPolicy: "open",
                            requireMention: false,
                          },
                        },
                        streaming: { mode: "off" },
                      },
                    },
                  },
                },
              }),
            },
            controlUiEnabled: false,
            runtimeEnvPatch: {
              OPENCLAW_SKIP_CHANNELS: undefined,
              OPENCLAW_SKIP_PROVIDERS: undefined,
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
              TELEGRAM_BOT_TOKEN: undefined,
            },
            mutateConfig: (cfg) => {
              cfg.agents!.defaults!.workspace = workspace;
              cfg.messages = {
                ...cfg.messages,
                groupChat: { ...cfg.messages?.groupChat, visibleReplies: "message_tool" },
              };
              cfg.bindings = [
                ...(cfg.bindings ?? []),
                { agentId: "qa", match: { channel: "telegram", accountId: "proof" } },
              ];
              return cfg;
            },
          });

          await expect
            .poll(
              () => ({
                providerRequests,
                sends: telegramSends.map((send) => ({
                  chatId: send.chat_id,
                  silent: send.disable_notification,
                  text: send.text,
                })),
              }),
              { interval: 100, timeout: 30_000 },
            )
            .toEqual({
              providerRequests: expect.any(Number),
              sends: [{ chatId: String(CHAT_ID), silent: true, text: FAILURE_TEXT }],
            });
          expect(providerRequests).toBeGreaterThan(0);
          expect(telegramSends.map((send) => send.text).join("\n")).not.toContain(RAW_ERROR_CANARY);
        } finally {
          await stopQaGatewayFixture(gatewayOwner);
          for (const poll of pendingPolls) {
            poll.destroy();
          }
        }
      }),
  );
}, 120_000);
