import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import {
  type MockOpenAiRequestSnapshot,
  createQaGatewayChild,
  startQaMockOpenAiServer,
  writeJson,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

type JsonObject = Record<string, unknown>;
type TelegramCall = { method: string; body: JsonObject };

const BOT_ID = 424242;
const BOT_TOKEN = `${BOT_ID}:${"A".repeat(35)}`;
const CHAT_ID = -1002468135790;
const ROOM_TITLE = "Harbor Conservation Crew";
const ROOM_DESCRIPTION = "organizing shoreline cleanups and monitoring tide-pool habitats";
const UNAVAILABLE_HISTORY_FACT = "Earlier room messages cannot be read on this platform.";

async function readRequest(req: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
  }
  return text;
}

function succeed(res: ServerResponse, result: unknown = true) {
  writeJson(res, 200, { ok: true, result });
}

function joinUpdate() {
  const bot = { id: BOT_ID, is_bot: true, first_name: "QA Harbor", username: "qa_harbor_bot" };
  return {
    update_id: 1,
    my_chat_member: {
      chat: { id: CHAT_ID, type: "supergroup", title: ROOM_TITLE },
      from: { id: 1357, is_bot: false, first_name: "Harbor Organizer" },
      date: 1_754_000_000,
      old_chat_member: { status: "left", user: bot },
      new_chat_member: { status: "member", user: bot },
    },
  };
}

function groundAssistantResponse(payload: string, text: string) {
  let grounded = false;
  let emittedDelta = false;
  const updateOutputItem = (item: unknown) => {
    if (!item || typeof item !== "object") {
      return;
    }
    const content = (item as JsonObject).content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const part of content) {
      if (part && typeof part === "object" && (part as JsonObject).type === "output_text") {
        (part as JsonObject).text = text;
        grounded = true;
      }
    }
  };

  const rewritten = payload
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data: ") || line === "data: [DONE]") {
        return line;
      }
      const event = JSON.parse(line.slice(6)) as JsonObject;
      if (event.type === "response.output_text.delta") {
        event.delta = emittedDelta ? "" : text;
        emittedDelta = true;
        grounded = true;
      } else if (event.type === "response.output_text.done") {
        event.text = text;
        grounded = true;
      } else if (
        event.type === "response.output_item.added" ||
        event.type === "response.output_item.done"
      ) {
        updateOutputItem(event.item);
      } else if (event.type === "response.completed") {
        const output = (event.response as JsonObject | undefined)?.output;
        if (Array.isArray(output)) {
          for (const item of output) {
            updateOutputItem(item);
          }
        }
      }
      return `data: ${JSON.stringify(event)}`;
    })
    .join("\n");

  return { payload: rewritten, grounded };
}

async function settleCleanup(...cleanups: Array<() => Promise<void>>) {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    await cleanup().catch((error: unknown) => failures.push(error));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Telegram join-introduction Gateway cleanup failed");
  }
}

test("introduces itself once when Telegram reports joining an allowed supergroup", async () => {
  const telegramCalls: TelegramCall[] = [];
  const pendingUpdates: unknown[] = [];
  const pendingPolls = new Set<ServerResponse>();
  let groundedModelResponses = 0;
  let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;

  const queueUpdate = (update: unknown) => {
    const pendingPoll = pendingPolls.values().next().value;
    if (pendingPoll) {
      pendingPolls.delete(pendingPoll);
      succeed(pendingPoll, [update]);
      return;
    }
    pendingUpdates.push(update);
  };

  const proxyProviderRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ) => {
    if (!mock) {
      writeJson(res, 503, { error: "mock provider is not ready" });
      return;
    }
    const raw = await readRequest(req);
    const upstream = await fetch(`${mock.baseUrl}${pathname}`, {
      method: req.method,
      ...(raw ? { body: raw } : {}),
      headers: { "content-type": "application/json" },
    });
    let payload = await upstream.text();
    if (
      pathname === "/v1/responses" &&
      raw.includes(ROOM_TITLE) &&
      raw.includes(ROOM_DESCRIPTION) &&
      raw.includes(UNAVAILABLE_HISTORY_FACT)
    ) {
      const groundedResponse = groundAssistantResponse(
        payload,
        `${ROOM_TITLE} is ${ROOM_DESCRIPTION}. I can organize cleanup plans and track habitat observations.`,
      );
      payload = groundedResponse.payload;
      if (groundedResponse.grounded) {
        groundedModelResponses += 1;
      }
    }
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(payload);
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname.startsWith("/v1/")) {
      await proxyProviderRequest(req, res, pathname);
      return;
    }

    const [, token = "", method = ""] = pathname.match(/^\/bot([^/]+)\/([^/]+)$/) ?? [];
    const raw = await readRequest(req);
    const body = raw ? (JSON.parse(raw) as JsonObject) : {};
    telegramCalls.push({ method, body });
    if (token !== BOT_TOKEN) {
      writeJson(res, 401, { ok: false, error_code: 401, description: "Unexpected bot token" });
      return;
    }
    if (method === "getMe") {
      succeed(res, {
        id: BOT_ID,
        is_bot: true,
        first_name: "QA Harbor",
        username: "qa_harbor_bot",
      });
      return;
    }
    if (method === "getUpdates") {
      const update = pendingUpdates.shift();
      if (update) {
        succeed(res, [update]);
      } else {
        pendingPolls.add(res);
        req.on("close", () => pendingPolls.delete(res));
      }
      return;
    }
    if (method === "getChat") {
      succeed(res, {
        id: CHAT_ID,
        type: "supergroup",
        title: ROOM_TITLE,
        description: ROOM_DESCRIPTION,
      });
      return;
    }
    if (method === "sendMessage") {
      succeed(res, {
        message_id: 9001,
        date: 1_754_000_000,
        chat: { id: CHAT_ID, type: "supergroup", title: ROOM_TITLE },
        text: body.text,
      });
      return;
    }
    succeed(res);
  };

  await withServer(
    (req, res) => {
      void handleRequest(req, res).catch((error: unknown) => {
        writeJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    async (apiRoot) =>
      await withTempDir("openclaw-telegram-join-intro-", async (workspace) => {
        const gatewayOwner = createQaGatewayChild();
        let gateway: QaGatewayChild | undefined;
        try {
          mock = await startQaMockOpenAiServer();
          gateway = await gatewayOwner.start({
            repoRoot: path.resolve(import.meta.dirname, "../../../.."),
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
                    groupPolicy: "open",
                    accounts: {
                      proof: {
                        enabled: true,
                        botToken: BOT_TOKEN,
                        apiRoot,
                        groupPolicy: "open",
                        commands: { native: false },
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
              cfg.bindings = [
                ...(cfg.bindings ?? []),
                { agentId: "qa", match: { channel: "telegram", accountId: "proof" } },
              ];
              return cfg;
            },
          });

          queueUpdate(joinUpdate());
          await expect
            .poll(
              () => ({
                deliveries: telegramCalls
                  .filter((call) => call.method === "sendMessage")
                  .map((call) => ({
                    chatId: String(call.body.chat_id),
                    text: call.body.text,
                  })),
                groundedModelResponses,
                telegramMethods: telegramCalls.map((call) => call.method),
              }),
              { interval: 50, timeout: 30_000 },
            )
            .toMatchObject({
              deliveries: [
                {
                  chatId: String(CHAT_ID),
                  text: expect.stringContaining(ROOM_TITLE),
                },
              ],
              groundedModelResponses: 1,
            })
            .catch((error: unknown) => {
              const diagnostics = {
                telegramCalls,
                groundedModelResponses,
                pendingUpdateCount: pendingUpdates.length,
                pendingPollCount: pendingPolls.size,
                gatewayLogs: gateway?.logs().slice(-12_000),
              };
              throw new Error(
                `Telegram join introduction did not reach its native delivery boundary:\n${JSON.stringify(diagnostics, null, 2)}`,
                { cause: error },
              );
            });

          const deliveries = telegramCalls.filter((call) => call.method === "sendMessage");
          expect(deliveries).toHaveLength(1);
          expect(String(deliveries[0]?.body.chat_id)).toBe(String(CHAT_ID));
          expect(deliveries[0]?.body.text).toEqual(expect.stringContaining(ROOM_TITLE));
          expect(deliveries[0]?.body.text).toEqual(expect.stringContaining(ROOM_DESCRIPTION));
          expect(
            telegramCalls.filter(
              (call) => call.method === "getChat" && String(call.body.chat_id) === String(CHAT_ID),
            ),
          ).toHaveLength(1);

          const requestResponse = await fetch(`${mock.baseUrl}/debug/requests`);
          expect(requestResponse.ok).toBe(true);
          const modelRequests = (await requestResponse.json()) as MockOpenAiRequestSnapshot[];
          const introRequest = modelRequests.find((request) =>
            request.allInputText.includes(ROOM_TITLE),
          );
          expect(introRequest?.allInputText).toEqual(expect.stringContaining(ROOM_DESCRIPTION));
          expect(introRequest?.allInputText).toEqual(
            expect.stringContaining(UNAVAILABLE_HISTORY_FACT),
          );
        } finally {
          await settleCleanup(
            async () => await stopQaGatewayFixture(gatewayOwner),
            async () => await mock?.stop(),
          );
        }
      }),
  );
}, 120_000);
