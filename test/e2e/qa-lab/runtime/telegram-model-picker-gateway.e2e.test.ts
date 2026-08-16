import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import {
  startQaGatewayChild,
  startQaMockOpenAiServer,
  writeJson,
} from "../../../../extensions/qa-lab/api.js";

// Real-behavior proof for PR #124222 / issue #123886: a rich-enabled Telegram
// `/models` final confirmation must replace the picker through the rich edit
// path (grammY's `api.raw.editMessageText` carrying `rich_message`), not the
// legacy plain-text `editMessageText` call. This exercises the real callback
// router (`bot-handlers.callback-router.ts`) -> model callback handler
// (`bot-handlers.model-callback.ts`) -> callback actions
// (`bot-handlers.callback-actions.ts`) chain against a real ephemeral Gateway
// and a local mock Telegram Bot API HTTP server -- the mock/harness-only proof
// gap ClawSweeper's review flagged as still missing.
const TOKEN = "100001:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CHAT_ID = 555_444;
const PICKER_MESSAGE_ID = 42;

type EditMessageTextBody = {
  chat_id?: number;
  message_id?: number;
  text?: string;
  parse_mode?: string;
  rich_message?: { blocks?: unknown[] };
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const succeed = (res: ServerResponse, result: unknown = true) =>
  writeJson(res, 200, { ok: true, result });

async function settleCleanup(...cleanups: Array<() => Promise<void>>) {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    await cleanup().catch((error: unknown) => failures.push(error));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Telegram model-picker gateway cleanup failed");
  }
}

test("routes the /models final confirmation through the rich edit funnel on a real Gateway", async () => {
  const editMessageTextCalls: EditMessageTextBody[] = [];
  let polled = false;
  let callbackDelivered = false;
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const [, token = "", method = ""] =
      new URL(req.url ?? "/", "http://127.0.0.1").pathname.match(/^\/bot([^/]+)\/([^/]+)$/) ?? [];
    if (token !== TOKEN) {
      writeJson(res, 404, { ok: false, error_code: 404, description: "Not Found" });
      return;
    }
    if (method === "getMe") {
      succeed(res, { id: 100001, is_bot: true, first_name: "QA" });
      return;
    }
    if (method === "getUpdates") {
      // First poll returns empty so the harness observes a completed short poll
      // before the synthetic callback is injected on the next poll, matching
      // grammY's own confirm-before-long-poll ingress contract
      // (telegram-ingress-worker.runtime.ts's `pollingConfirmed` gate).
      if (!polled) {
        polled = true;
        succeed(res, []);
        return;
      }
      if (!callbackDelivered) {
        callbackDelivered = true;
        succeed(res, [
          {
            update_id: 1,
            callback_query: {
              id: "qa-model-select-1",
              from: { id: 777, is_bot: false, first_name: "QA" },
              // Required by grammY's CallbackQuery type; unused by the router but
              // must be present for the update to deserialize correctly.
              chat_instance: "qa-chat-instance-1",
              message: {
                message_id: PICKER_MESSAGE_ID,
                date: Math.floor(Date.now() / 1000),
                chat: { id: CHAT_ID, type: "private" },
              },
              data: "mdl_sel_mock-openai/gpt-5.6-luna-alt",
            },
          },
        ]);
        return;
      }
      succeed(res, []);
      return;
    }
    const body = await readJson(req);
    if (method === "editMessageText") {
      editMessageTextCalls.push(body as EditMessageTextBody);
      succeed(res, { message_id: PICKER_MESSAGE_ID });
      return;
    }
    if (method === "answerCallbackQuery" || method === "deleteWebhook") {
      succeed(res);
      return;
    }
    writeJson(res, 404, { ok: false, error_code: 404, description: "Not Found" });
  };
  await withServer(
    (req, res) => {
      void handleRequest(req, res);
    },
    async (apiRoot) =>
      await withTempDir("openclaw-telegram-model-picker-", async (workspace) => {
        let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
        let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
        try {
          const repoRoot = path.resolve(import.meta.dirname, "../../../..");
          mock = await startQaMockOpenAiServer();
          gateway = await startQaGatewayChild({
            repoRoot,
            useRepoCli: true,
            providerBaseUrl: `${mock.baseUrl}/v1`,
            transportBaseUrl: apiRoot,
            transport: {
              requiredPluginIds: ["telegram"],
              createGatewayConfig: () => ({
                channels: {
                  telegram: {
                    defaultAccount: "main",
                    accounts: {
                      main: {
                        enabled: true,
                        botToken: TOKEN,
                        apiRoot,
                        dmPolicy: "open",
                        allowFrom: ["*"],
                        richMessages: true,
                      },
                    },
                  },
                },
              }),
            },
            controlUiEnabled: false,
            mutateConfig: (cfg) => {
              cfg.agents!.defaults!.workspace = workspace;
              return cfg;
            },
          });
          await expect
            .poll(() => editMessageTextCalls.length > 0, { interval: 50, timeout: 30_000 })
            .toBe(true);
          const [confirmationCall] = editMessageTextCalls;
          expect(confirmationCall?.chat_id).toBe(CHAT_ID);
          expect(confirmationCall?.message_id).toBe(PICKER_MESSAGE_ID);
          // Proves the rich-edit funnel was taken (bot-handlers.callback-actions.ts's
          // getTelegramRichRawApi(bot.api).editMessageText call): the request body
          // carries a rich_message.blocks payload, not the legacy positional
          // text/parse_mode shape editMessageText would otherwise send.
          expect(confirmationCall?.rich_message?.blocks).toBeDefined();
          expect(Array.isArray(confirmationCall?.rich_message?.blocks)).toBe(true);
          expect(confirmationCall?.rich_message?.blocks?.length).toBeGreaterThan(0);
          expect(confirmationCall?.text).toBeUndefined();
          expect(confirmationCall?.parse_mode).toBeUndefined();
          // Exactly one edit: no legacy-funnel edit was also sent for this callback.
          expect(editMessageTextCalls).toHaveLength(1);
        } finally {
          await settleCleanup(
            async () => await gateway?.stop(),
            async () => await mock?.stop(),
          );
        }
      }),
  );
}, 120_000);
