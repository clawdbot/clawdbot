import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import {
  type MockOpenAiRequestSnapshot,
  createQaGatewayChild,
  startQaMockOpenAiServer,
  writeJson,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

type JsonObject = Record<string, unknown>;
type TelegramCall = { pathname: string; method: string; body: JsonObject };

const BOT_TOKEN = `424242:${"A".repeat(35)}`;
const CURRENT_CHAT_ID = 2468;
const FOREIGN_CHAT_ID = 97531;
const CUSTOM_EMOJI_ID = "5368324170671202286";
const CURRENT_CHAT_SCENARIO = "TELEGRAM_EMOJI_LIST_CURRENT_CHAT";
const FOREIGN_CHAT_SCENARIO = "TELEGRAM_EMOJI_LIST_FOREIGN_CHAT";
const CONVERSATION_BINDING_ERROR =
  "Delegated Telegram conversation read requires the exact current chat and account.";

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

function inboundUpdate(updateId: number, scenario: string) {
  return {
    update_id: updateId,
    message: {
      message_id: 9000 + updateId,
      date: 1_754_000_000,
      chat: { id: CURRENT_CHAT_ID, type: "private" },
      from: { id: CURRENT_CHAT_ID, is_bot: false, first_name: "QA" },
      text: `QA group visible reply tool check: ${scenario}`,
    },
  };
}

function scriptMessageToolCall(payload: string, args: JsonObject) {
  let scripted = false;
  const argumentsText = JSON.stringify(args);
  const finishAssistantMessage = (item: JsonObject | undefined) => {
    if (item?.type !== "message" || !Array.isArray(item.content)) {
      return;
    }
    for (const part of item.content as JsonObject[]) {
      if (part.type === "output_text" && part.text === "") {
        // The shared group-reply fixture ends empty; finish the turn so recovery never repeats discovery.
        part.text = "Emoji discovery complete.";
      }
    }
  };
  const scriptedPayload = payload
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data: ") || line === "data: [DONE]") {
        return line;
      }
      const event = JSON.parse(line.slice(6)) as JsonObject;
      if (
        event.type === "response.output_item.added" ||
        event.type === "response.output_item.done"
      ) {
        const item = event.item as JsonObject | undefined;
        if (item?.name === "message") {
          scripted = true;
          if (item.arguments !== "") {
            item.arguments = argumentsText;
          }
        }
        finishAssistantMessage(item);
      } else if (event.type === "response.function_call_arguments.delta" && scripted) {
        event.delta = argumentsText;
      } else if (event.type === "response.completed") {
        const response = event.response as JsonObject | undefined;
        const output = response?.output;
        if (Array.isArray(output)) {
          for (const item of output as JsonObject[]) {
            if (item.name === "message") {
              item.arguments = argumentsText;
              scripted = true;
            }
            finishAssistantMessage(item);
          }
        }
      }
      return `data: ${JSON.stringify(event)}`;
    })
    .join("\n");
  return { payload: scriptedPayload, scripted };
}

async function settleCleanup(...cleanups: Array<() => Promise<void>>) {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    await cleanup().catch((error: unknown) => failures.push(error));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Telegram emoji-list gateway cleanup failed");
  }
}

test("binds Telegram emoji discovery to the current conversation before Bot API I/O", async () => {
  const telegramCalls: TelegramCall[] = [];
  const pendingUpdates: unknown[] = [];
  const pendingPolls = new Set<ServerResponse>();
  const scriptedCalls: Array<{ scenario: string; arguments: JsonObject }> = [];
  let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;

  const queueUpdate = (update: unknown) => {
    const poll = pendingPolls.values().next().value;
    if (poll) {
      pendingPolls.delete(poll);
      succeed(poll, [update]);
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
    const currentScenarioIndex = raw.lastIndexOf(CURRENT_CHAT_SCENARIO);
    const foreignScenarioIndex = raw.lastIndexOf(FOREIGN_CHAT_SCENARIO);
    const scenario =
      foreignScenarioIndex > currentScenarioIndex
        ? FOREIGN_CHAT_SCENARIO
        : currentScenarioIndex >= 0
          ? CURRENT_CHAT_SCENARIO
          : undefined;

    if (pathname === "/v1/responses" && scenario) {
      const args = {
        action: "emoji-list",
        ...(scenario === FOREIGN_CHAT_SCENARIO ? { chatId: String(FOREIGN_CHAT_ID) } : {}),
      };
      const scripted = scriptMessageToolCall(payload, args);
      payload = scripted.payload;
      if (scripted.scripted) {
        scriptedCalls.push({ scenario, arguments: args });
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
    telegramCalls.push({ pathname, method, body });

    if (token !== BOT_TOKEN) {
      writeJson(res, 401, { ok: false, error_code: 401, description: "Unexpected bot token" });
      return;
    }
    if (method === "getMe") {
      succeed(res, {
        id: 424242,
        is_bot: true,
        first_name: "QA Emoji",
        username: "qa_emoji_bot",
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
        id: Number(body.chat_id),
        type: "private",
        first_name: "QA",
        available_reactions: [
          { type: "emoji", emoji: "👍" },
          { type: "custom_emoji", custom_emoji_id: CUSTOM_EMOJI_ID },
        ],
      });
      return;
    }
    if (method === "sendMessage") {
      succeed(res, {
        message_id: 10_000 + telegramCalls.length,
        date: 1_754_000_000,
        chat: { id: Number(body.chat_id), type: "private" },
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
      await withTempDir("openclaw-telegram-emoji-list-", async (workspace) => {
        const gatewayOwner = createQaGatewayChild();
        try {
          const repoRoot = path.resolve(import.meta.dirname, "../../../..");
          mock = await startQaMockOpenAiServer();
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
                        dmPolicy: "open",
                        allowFrom: ["*"],
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
              cfg.agents!.entries!.qa!.tools = { profile: "full" };
              cfg.tools = { ...cfg.tools, profile: "full", toolSearch: false, codeMode: false };
              cfg.bindings = [
                ...(cfg.bindings ?? []),
                { agentId: "qa", match: { channel: "telegram", accountId: "proof" } },
              ];
              return cfg;
            },
          });

          const findToolResult = async (scenario: string) => {
            const response = await fetch(`${mock!.baseUrl}/debug/requests`);
            expect(response.ok).toBe(true);
            const requests = (await response.json()) as MockOpenAiRequestSnapshot[];
            return requests.find(
              (request) => request.prompt.includes(scenario) && request.toolOutput.length > 0,
            );
          };

          queueUpdate(inboundUpdate(1, CURRENT_CHAT_SCENARIO));
          await expect
            .poll(
              async () => ({
                request: await findToolResult(CURRENT_CHAT_SCENARIO),
                scriptedCalls,
                telegramMethods: telegramCalls.map((call) => call.method),
              }),
              {
                interval: 50,
                timeout: 30_000,
              },
            )
            .toMatchObject({
              request: { toolOutput: expect.stringContaining(CUSTOM_EMOJI_ID) },
              scriptedCalls: [
                { scenario: CURRENT_CHAT_SCENARIO, arguments: { action: "emoji-list" } },
              ],
            });

          const currentChatResult = await findToolResult(CURRENT_CHAT_SCENARIO);
          expect(JSON.parse(currentChatResult!.toolOutput)).toMatchObject({
            ok: true,
            emojis: [
              { name: "👍", identifier: "👍" },
              { identifier: CUSTOM_EMOJI_ID, type: "custom_emoji" },
            ],
          });
          expect(
            telegramCalls.filter(
              (call) =>
                call.method === "getChat" && String(call.body.chat_id) === String(CURRENT_CHAT_ID),
            ),
          ).toHaveLength(1);

          queueUpdate(inboundUpdate(2, FOREIGN_CHAT_SCENARIO));
          await expect
            .poll(() => findToolResult(FOREIGN_CHAT_SCENARIO), {
              interval: 50,
              timeout: 30_000,
            })
            .toMatchObject({ toolOutput: expect.stringContaining(CONVERSATION_BINDING_ERROR) });

          const foreignChatResult = await findToolResult(FOREIGN_CHAT_SCENARIO);
          expect(foreignChatResult!.toolOutput).toContain(CONVERSATION_BINDING_ERROR);
          expect(
            telegramCalls.filter((call) => JSON.stringify(call).includes(String(FOREIGN_CHAT_ID))),
          ).toEqual([]);
          expect(scriptedCalls).toEqual([
            { scenario: CURRENT_CHAT_SCENARIO, arguments: { action: "emoji-list" } },
            {
              scenario: FOREIGN_CHAT_SCENARIO,
              arguments: { action: "emoji-list", chatId: String(FOREIGN_CHAT_ID) },
            },
          ]);
        } finally {
          await settleCleanup(
            async () => await stopQaGatewayFixture(gatewayOwner),
            async () => await mock?.stop(),
          );
        }
      }),
  );
}, 120_000);
