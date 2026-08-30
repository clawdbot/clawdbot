// Real behavior proof for PR #133267: Telegram callback_query -> real callback
// router -> generic interactive dispatcher -> temporary handler, proving that
// updateId and messageDate arrive verbatim from the authoritative ingress.
//
// The proof uses a real grammY Bot with a loopback HTTP Bot API (127.0.0.1, no
// live Telegram), the real Telegram callback router, and the real generic
// interactive dispatcher with a temporary registered handler. It never touches
// owner approvals, the supervisor, or any live channel.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { registerPluginInteractiveHandler } from "../../src/plugins/interactive.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../src/plugins/runtime.js";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import type { TelegramCallbackMessageRuntime } from "./bot-handlers.callback-router-controls.js";
import { createTelegramCallbackRouter } from "./bot-handlers.callback-router.js";
import type { TelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { resetTelegramClientOptionsCacheForTests, sendMessageTelegram } from "./send.js";

const TOKEN = "123456…proof-token";
const CHAT_ID = 1234;

// Authoritative ingress values used by the proof.
const EXPECTED_UPDATE_ID = 424242;
const EXPECTED_MESSAGE_DATE = 1_710_000_000;

type TelegramApiRequest = { method: string; payload: Record<string, unknown> };

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, result: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, result }));
}

describe("Telegram interactive handler ingress metadata loopback proof", () => {
  afterEach(() => {
    resetTelegramClientOptionsCacheForTests();
    resetPluginRuntimeStateForTest();
  });

  it("forwards updateId and messageDate verbatim through the real callback path", async () => {
    // Temporary plugin registry with one registered generic interactive
    // handler for namespace "proof".
    const active = createEmptyPluginRegistry();
    setActivePluginRegistry(active);
    const received: Array<{ updateId: unknown; messageDate: unknown }> = [];
    const registration = registerPluginInteractiveHandler("proof-plugin", {
      channel: "telegram",
      namespace: "proof",
      handler: async (ctx: { updateId: unknown; messageDate: unknown }) => {
        received.push({ updateId: ctx.updateId, messageDate: ctx.messageDate });
        return { handled: true };
      },
    });
    expect(registration.ok).toBe(true);

    const stateDir = await mkdtemp(join(tmpdir(), "openclaw-telegram-proof-"));
    const requests: TelegramApiRequest[] = [];

    const handleApiRequest = async (request: IncomingMessage, response: ServerResponse) => {
      const method = request.url?.split("/").at(-1) ?? "";
      const payload = await readJsonBody(request);
      requests.push({ method, payload });

      if (method === "sendMessage") {
        sendJson(response, {
          message_id: 88,
          date: EXPECTED_MESSAGE_DATE,
          chat: { id: CHAT_ID, type: "private", first_name: "Operator" },
          from: telegramBotInfoForTest,
          text: payload.text,
          reply_markup: payload.reply_markup,
        });
      } else if (method === "answerCallbackQuery") {
        sendJson(response, true);
      } else if (method === "editMessageText") {
        sendJson(response, { ok: true });
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
            models: { "anthropic/claude-opus-4-6": {} },
          },
        },
        channels: {
          telegram: { apiRoot, botToken: TOKEN, dmPolicy: "open", allowFrom: ["*"] },
        },
        session: { store: storePath },
      };
      await sendMessageTelegram(String(CHAT_ID), "Proof prompt", {
        cfg: config,
        token: TOKEN,
        buttons: [],
      });

      const bot = new Bot(TOKEN, { botInfo: telegramBotInfoForTest, client: { apiRoot } });
      const telegramDeps = {
        ...defaultTelegramBotDeps,
        getRuntimeConfig: () => config,
      };
      const authorization = {
        resolveTelegramEventAuthorizationContext: async () => ({
          threadSpec: { scope: "none" },
          dmThreadId: undefined,
          storeAllowFrom: [],
          groupConfig: undefined,
        }),
        authorizeTelegramEventSender: async () => true,
        isTelegramModelCallbackAuthorized: async () => false,
      } as unknown as TelegramHandlerAuthorization;
      const message = {
        buildSyntheticTextMessage: () => {
          throw new Error("proof callback must not enter generic message dispatch");
        },
        buildSyntheticContext: () => {
          throw new Error("proof callback must not enter generic message dispatch");
        },
        processMessageWithReplyChain: async () => {
          throw new Error("proof callback must not enter generic message dispatch");
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

      // Real grammY ingress update with the authoritative values.
      await bot.handleUpdate({
        update_id: EXPECTED_UPDATE_ID,
        callback_query: {
          id: "proof-callback",
          chat_instance: "proof-chat",
          data: "proof:ingress-metadata",
          from: { id: 9, is_bot: false, first_name: "Operator", username: "operator" },
          message: {
            message_id: 88,
            date: EXPECTED_MESSAGE_DATE,
            chat: { id: CHAT_ID, type: "private", first_name: "Operator" },
            text: "Proof prompt",
          },
        },
      });

      // The temporary handler must have received the verbatim values.
      expect(received).toHaveLength(1);
      expect(received[0].updateId).toBe(EXPECTED_UPDATE_ID);
      expect(received[0].messageDate).toBe(EXPECTED_MESSAGE_DATE);
    } finally {
      server.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
