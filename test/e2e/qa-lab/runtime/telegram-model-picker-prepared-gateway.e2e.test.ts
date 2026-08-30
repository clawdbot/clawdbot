import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import { createQaGatewayChild, writeJson } from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

type JsonObject = Record<string, unknown>;
type TelegramCall = { method: string; body: JsonObject };

const BOT_TOKEN = "424242:telegram-model-picker-proof";
const CHAT_ID = 2468;
const MESSAGE_ID = 9001;
const PREPARED_MODEL = "prepared-model";

async function readJson(req: IncomingMessage): Promise<JsonObject> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
  }
  return text ? (JSON.parse(text) as JsonObject) : {};
}

function succeed(res: ServerResponse, result: unknown = true) {
  writeJson(res, 200, { ok: true, result });
}

function callbackUpdate(updateId: number, callbackId: string, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: { id: 1357, is_bot: false, first_name: "QA" },
      chat_instance: "telegram-model-picker-proof",
      data,
      message: {
        message_id: MESSAGE_ID,
        date: 1_754_000_000,
        chat: { id: CHAT_ID, type: "private" },
        from: { id: 424242, is_bot: true, first_name: "QA", username: "qa_picker_bot" },
        text: "Select a provider:",
        reply_markup: { inline_keyboard: [] },
      },
    },
  };
}

function initialModelsUpdate() {
  return {
    update_id: 1,
    message: {
      message_id: 8999,
      date: 1_754_000_000,
      chat: { id: CHAT_ID, type: "private" },
      from: { id: 1357, is_bot: false, first_name: "QA" },
      text: "/models",
      entities: [{ offset: 0, length: 7, type: "bot_command" }],
    },
  };
}

function inlineKeyboard(call: TelegramCall): Array<Array<JsonObject>> {
  const markup = call.body.reply_markup;
  if (!markup || typeof markup !== "object") {
    return [];
  }
  const keyboard = (markup as JsonObject).inline_keyboard;
  return Array.isArray(keyboard)
    ? (keyboard.filter((row): row is Array<JsonObject> => Array.isArray(row)) as Array<
        Array<JsonObject>
      >)
    : [];
}

function keyboardCallbackData(call: TelegramCall): string[] {
  return inlineKeyboard(call).flatMap((row) =>
    row.flatMap((button) =>
      typeof button.callback_data === "string" ? [button.callback_data] : [],
    ),
  );
}

function hasCallback(call: TelegramCall, callbackData: string) {
  return keyboardCallbackData(call).includes(callbackData);
}

async function settleCleanup(...cleanups: Array<() => Promise<void>>) {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    await cleanup().catch((error: unknown) => failures.push(error));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Telegram model-picker gateway cleanup failed");
  }
}

test("keeps Telegram model-picker callbacks on the prepared Gateway catalog", async () => {
  const telegramCalls: TelegramCall[] = [];
  const pendingUpdates: unknown[] = [];
  let nextUpdateId = 2;
  let pickerStage:
    | "initial"
    | "providers"
    | "models"
    | "repeated-providers"
    | "repeated-providers-second"
    | "done" = "initial";
  let discoveryFrozen = false;
  let discoveryRequests = 0;
  let postWarmDiscoveryAttempts = 0;

  const queueCallback = (data: string) => {
    const callbackNumber = nextUpdateId - 1;
    pendingUpdates.push(callbackUpdate(nextUpdateId, `picker-callback-${callbackNumber}`, data));
    nextUpdateId += 1;
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

    if (pathname === "/ollama/api/tags") {
      discoveryRequests += 1;
      if (discoveryFrozen) {
        postWarmDiscoveryAttempts += 1;
        writeJson(res, 503, { ok: false, error: "provider discovery frozen after warmup" });
        return;
      }
      succeed(res, {
        models: [
          {
            name: PREPARED_MODEL,
            modified_at: "2026-08-16T00:00:00Z",
            digest: "prepared-model-digest",
            size: 1,
          },
        ],
      });
      return;
    }

    if (pathname === "/ollama/api/show") {
      discoveryRequests += 1;
      if (discoveryFrozen) {
        postWarmDiscoveryAttempts += 1;
        writeJson(res, 503, { ok: false, error: "provider discovery frozen after warmup" });
        return;
      }
      succeed(res, {
        model_info: { "general.context_length": 8192 },
        capabilities: ["completion", "tools"],
      });
      return;
    }

    const telegramMatch = pathname.match(/^\/bot([^/]+)\/([^/]+)$/);
    if (!telegramMatch) {
      writeJson(res, 404, { ok: false, error: "not found" });
      return;
    }
    const [, token = "", method = ""] = telegramMatch;
    const body = await readJson(req);
    if (token !== BOT_TOKEN) {
      writeJson(res, 401, { ok: false, error: "unexpected bot token" });
      return;
    }

    if (method === "getMe") {
      succeed(res, {
        id: 424242,
        is_bot: true,
        first_name: "QA Picker",
        username: "qa_picker_bot",
      });
      return;
    }
    if (method === "getUpdates") {
      const update = pendingUpdates.shift();
      succeed(res, update ? [update] : []);
      return;
    }

    telegramCalls.push({ method, body });
    if (method === "sendMessage" && pickerStage === "initial") {
      expect(typeof body.text).toBe("string");
      pickerStage = "providers";
    } else if (
      method === "editMessageText" &&
      pickerStage === "providers" &&
      typeof body.text === "string" &&
      body.text.includes("Select a provider:")
    ) {
      expect(hasCallback({ method, body }, "mdl_list_ollama_1")).toBe(true);
      pickerStage = "models";
      queueCallback("mdl_list_ollama_1");
    } else if (
      method === "editMessageText" &&
      pickerStage === "models" &&
      hasCallback({ method, body }, `mdl_sel_ollama/${PREPARED_MODEL}`)
    ) {
      pickerStage = "repeated-providers";
      queueCallback("mdl_prov");
    } else if (
      method === "editMessageText" &&
      pickerStage === "repeated-providers" &&
      typeof body.text === "string" &&
      body.text.includes("Select a provider:")
    ) {
      expect(hasCallback({ method, body }, "mdl_list_ollama_1")).toBe(true);
      pickerStage = "repeated-providers-second";
      queueCallback("mdl_prov");
    } else if (
      method === "editMessageText" &&
      pickerStage === "repeated-providers-second" &&
      typeof body.text === "string" &&
      body.text.includes("Select a provider:")
    ) {
      expect(hasCallback({ method, body }, "mdl_list_ollama_1")).toBe(true);
      pickerStage = "done";
    }

    if (method === "answerCallbackQuery") {
      expect(typeof body.callback_query_id).toBe("string");
    }
    succeed(res);
  };

  await withServer(
    (req, res) => {
      void handleRequest(req, res);
    },
    async (apiRoot) =>
      await withTempDir("openclaw-telegram-model-picker-", async () => {
        const gatewayOwner = createQaGatewayChild();
        try {
          const repoRoot = path.resolve(import.meta.dirname, "../../../..");
          await gatewayOwner.start({
            repoRoot,
            useRepoCli: true,
            transportBaseUrl: apiRoot,
            transport: {
              requiredPluginIds: ["telegram"],
              createGatewayConfig: () => ({
                channels: {
                  telegram: {
                    enabled: true,
                    defaultAccount: "picker",
                    accounts: {
                      picker: {
                        enabled: true,
                        botToken: BOT_TOKEN,
                        apiRoot,
                        dmPolicy: "open",
                        allowFrom: ["*"],
                        commands: { native: true },
                      },
                    },
                  },
                },
              }),
            },
            controlUiEnabled: false,
            enabledPluginIds: ["ollama"],
            primaryModel: `ollama/${PREPARED_MODEL}`,
            alternateModel: `ollama/${PREPARED_MODEL}`,
            runtimeEnvPatch: {
              OPENCLAW_SKIP_CHANNELS: undefined,
              OPENCLAW_SKIP_PROVIDERS: undefined,
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
              TELEGRAM_BOT_TOKEN: undefined,
            },
            mutateConfig: (cfg) => ({
              ...cfg,
              agents: {
                ...cfg.agents,
                defaults: {
                  ...cfg.agents?.defaults,
                  model: `ollama/${PREPARED_MODEL}`,
                  modelPolicy: { allow: ["ollama/*"] },
                  models: {
                    ...cfg.agents?.defaults?.models,
                    [`ollama/${PREPARED_MODEL}`]: {},
                  },
                },
                entries: {
                  ...cfg.agents?.entries,
                  qa: {
                    ...cfg.agents?.entries?.qa,
                    model: `ollama/${PREPARED_MODEL}`,
                  },
                },
              },
              models: {
                ...cfg.models,
                mode: "merge",
                providers: {
                  ...cfg.models?.providers,
                  ollama: {
                    baseUrl: `${apiRoot}/ollama`,
                    api: "ollama",
                    models: [],
                  },
                },
              },
            }),
          });

          const startupDiscoveryRequests = discoveryRequests;
          expect(startupDiscoveryRequests).toBe(0);
          pendingUpdates.push(initialModelsUpdate());

          await expect
            .poll(() => ({ stage: pickerStage, discoveryRequests }), {
              interval: 50,
              timeout: 30_000,
            })
            .toEqual({ stage: "providers", discoveryRequests: 2 });
          const warmDiscoveryRequests = discoveryRequests;
          discoveryFrozen = true;
          queueCallback("mdl_prov");

          await expect
            .poll(
              () => ({
                stage: pickerStage,
                answers: telegramCalls.filter((call) => call.method === "answerCallbackQuery")
                  .length,
              }),
              { interval: 50, timeout: 30_000 },
            )
            .toMatchObject({ stage: "done", answers: 4 });

          const sendMessage = telegramCalls.find((call) => call.method === "sendMessage");
          expect(sendMessage).toBeDefined();
          expect(hasCallback(sendMessage!, "mdl_list_ollama_1")).toBe(true);

          const pickerEdits = telegramCalls.filter(
            (call) => call.method === "editMessageText" && inlineKeyboard(call).length > 0,
          );
          expect(pickerEdits).toHaveLength(4);
          expect(hasCallback(pickerEdits[0]!, "mdl_list_ollama_1")).toBe(true);
          expect(hasCallback(pickerEdits[2]!, "mdl_list_ollama_1")).toBe(true);
          expect(
            pickerEdits[1] &&
              keyboardCallbackData(pickerEdits[1]).includes(`mdl_sel_ollama/${PREPARED_MODEL}`),
          ).toBe(true);
          expect(pickerEdits[3] && hasCallback(pickerEdits[3], "mdl_list_ollama_1")).toBe(true);

          expect(
            telegramCalls.filter((call) => call.method === "answerCallbackQuery"),
          ).toHaveLength(4);
          expect(discoveryRequests).toBe(warmDiscoveryRequests);
          expect(postWarmDiscoveryAttempts).toBe(0);
        } finally {
          await settleCleanup(async () => await stopQaGatewayFixture(gatewayOwner));
        }
      }),
  );
}, 120_000);
