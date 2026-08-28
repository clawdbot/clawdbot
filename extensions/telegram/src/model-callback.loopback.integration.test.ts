// A real grammY bot and HTTP Bot API prove model callbacks across the active router.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { listSessionEntries } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import type { TelegramCallbackMessageRuntime } from "./bot-handlers.callback-router-controls.js";
import { createTelegramCallbackRouter } from "./bot-handlers.callback-router.js";
import type { TelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { buildModelsKeyboard } from "./model-buttons.js";
import { resetTelegramClientOptionsCacheForTests, sendMessageTelegram } from "./send.js";

const TOKEN = "123456:loopback-token";
const CHAT_ID = 1234;
const PROVIDER = "ollama";
const MODEL = "xentriom/gemma-4-12B-agentic-fable5-composer2.5-v2:latest";

type TelegramApiRequest = { method: string; payload: Record<string, unknown> };

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, result: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, result }));
}

describe("Telegram model callback loopback", () => {
  afterEach(() => {
    resetTelegramClientOptionsCacheForTests();
  });

  it("sends, authorizes, resolves, persists, answers, and edits an opaque callback", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "openclaw-telegram-model-loopback-"));
    const requests: TelegramApiRequest[] = [];
    let sentMessage: Record<string, unknown> | undefined;

    const handleApiRequest = async (request: IncomingMessage, response: ServerResponse) => {
      const method = request.url?.split("/").at(-1) ?? "";
      const payload = await readJsonBody(request);
      requests.push({ method, payload });

      if (method === "sendMessage") {
        const replyMarkup = payload.reply_markup as
          | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
          | undefined;
        for (const button of replyMarkup?.inline_keyboard?.flat() ?? []) {
          if (
            typeof button.callback_data !== "string" ||
            Buffer.byteLength(button.callback_data, "utf8") > 64
          ) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ ok: false, error_code: 400, description: "BUTTON_DATA_INVALID" }),
            );
            return;
          }
        }
        sentMessage = {
          message_id: 88,
          date: 1_786_404_800,
          chat: { id: CHAT_ID, type: "private", first_name: "Operator" },
          from: telegramBotInfoForTest,
          text: payload.text,
          reply_markup: replyMarkup,
        };
        sendJson(response, sentMessage);
      } else if (method === "answerCallbackQuery") {
        sendJson(response, true);
      } else if (method === "editMessageText") {
        sendJson(response, {
          ...sentMessage,
          text: payload.text,
          reply_markup: payload.reply_markup,
        });
      } else {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error_code: 404, description: method }));
      }
    };

    const server = createServer((request, response) => {
      void handleApiRequest(request, response).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const storePath = join(stateDir, "sessions.json");
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              [`${PROVIDER}/${MODEL}`]: {},
            },
          },
        },
        channels: {
          telegram: { apiRoot, botToken: TOKEN, dmPolicy: "open", allowFrom: ["*"] },
        },
        session: { store: storePath },
      };
      const buttons = buildModelsKeyboard({
        provider: PROVIDER,
        models: [MODEL],
        currentPage: 1,
        totalPages: 1,
      });
      await sendMessageTelegram(String(CHAT_ID), "Select a model:", {
        cfg: config,
        token: TOKEN,
        buttons,
      });

      const callbackData = (
        sentMessage?.reply_markup as {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        }
      )?.inline_keyboard?.[0]?.[0]?.callback_data;
      expect(callbackData).toMatch(/^mdl1~m:[A-Za-z0-9_-]{43}$/);
      expect(Buffer.byteLength(callbackData ?? "", "utf8")).toBeLessThanOrEqual(64);

      const callbackSteps: string[] = [];
      const bot = new Bot(TOKEN, { botInfo: telegramBotInfoForTest, client: { apiRoot } });
      const telegramDeps = {
        ...defaultTelegramBotDeps,
        buildModelsProviderData: async () => {
          callbackSteps.push("catalog");
          return {
            byProvider: new Map([
              ["anthropic", new Set(["claude-opus-4-6"])],
              [PROVIDER, new Set([MODEL])],
            ]),
            providers: ["anthropic", PROVIDER],
            resolvedDefault: { provider: "anthropic", model: "claude-opus-4-6" },
            modelNames: new Map<string, string>(),
          };
        },
        getRuntimeConfig: () => config,
      };
      const authorization = {
        resolveTelegramEventAuthorizationContext: async () => {
          callbackSteps.push("context");
          return {
            threadSpec: { scope: "none" },
            dmThreadId: undefined,
            storeAllowFrom: [],
            groupConfig: undefined,
          };
        },
        authorizeTelegramEventSender: async () => {
          callbackSteps.push("sender");
          return true;
        },
        isTelegramModelCallbackAuthorized: async () => {
          callbackSteps.push("model");
          return true;
        },
      } as unknown as TelegramHandlerAuthorization;
      const message = {
        buildSyntheticTextMessage: () => {
          throw new Error("model callback must not enter generic callback dispatch");
        },
        buildSyntheticContext: () => {
          throw new Error("model callback must not enter generic callback dispatch");
        },
        processMessageWithReplyChain: async () => {
          throw new Error("model callback must not enter generic callback dispatch");
        },
        resolveTelegramSessionState: () => ({
          agentId: "main",
          sessionEntry: undefined,
          sessionKey: "agent:main:telegram:direct:1234",
          storePath,
          model: undefined,
        }),
      } as unknown as TelegramCallbackMessageRuntime;
      const router = createTelegramCallbackRouter({
        params: {
          accountId: "default",
          bot,
          runtime: {},
          telegramDeps,
          shouldSkipUpdate: () => false,
        } as unknown as RegisterTelegramHandlerParams,
        message,
        authorization,
      });
      bot.on("callback_query", async (context) => {
        await router.route(context);
      });
      await bot.handleUpdate({
        update_id: 1,
        callback_query: {
          id: "loopback-callback",
          chat_instance: "loopback-chat",
          data: callbackData,
          from: { id: 9, is_bot: false, first_name: "Operator", username: "operator" },
          message: sentMessage as never,
        },
      });

      expect(requests.map(({ method }) => method)).toEqual([
        "sendMessage",
        "answerCallbackQuery",
        "editMessageText",
      ]);
      expect(callbackSteps).toEqual(["context", "sender", "model", "catalog"]);
      expect(listSessionEntries({ storePath })[0]?.entry).toMatchObject({
        providerOverride: PROVIDER,
        modelOverride: MODEL,
        modelOverrideSource: "user",
        liveModelSwitchPending: true,
      });
      expect(requests.at(-1)?.payload.text).toContain(
        `Model changed to <b>${PROVIDER}/${MODEL}</b>`,
      );
    } finally {
      server.close();
      server.closeAllConnections();
      server.unref();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
