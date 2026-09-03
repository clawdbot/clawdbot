import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import { createQaGatewayChild, writeJson } from "../../../../extensions/qa-lab/api.js";
import {
  createChannelIngressQueue,
  getChannelIngressKysely,
} from "../../../../src/channels/message/ingress-queue.js";
import type { ModelDefinitionConfig } from "../../../../src/config/types.models.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { executeSqliteQuerySync } from "../../../../src/infra/kysely-sync.js";
import { openExistingOpenClawStateDatabaseReadOnly } from "../../../../src/state/openclaw-state-db.js";
import { withTestTimeout } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

type JsonObject = Record<string, unknown>;
type TelegramCall = { method: string; body: JsonObject };

const BOT_TOKEN = "424242:telegram-model-picker-proof";
const CHAT_ID = 2468;
const MESSAGE_ID = 9001;
const PREPARED_MODEL = "prepared-model";
const DISCOVERED_MODEL = "discovered-model";
const REPLACEMENT_MODEL = "replacement-model";
const REPLACEMENT_PROVIDER = "qa-picker";
const REPLACEMENT_MODEL_REF = `${REPLACEMENT_PROVIDER}/${REPLACEMENT_MODEL}`;
const SOURCE_GATEWAY_TIMEOUT_MS = 120_000;

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

function configuredModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
}

function pickerConfig(apiRoot: string, modelId: string): OpenClawConfig {
  const modelRef = `${REPLACEMENT_PROVIDER}/${modelId}`;
  return {
    gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token: "picker-token" } },
    plugins: {
      enabled: true,
      allow: ["telegram"],
      entries: { telegram: { enabled: true } },
    },
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
    agents: {
      defaults: {
        model: modelRef,
        modelPolicy: { allow: [modelRef] },
        models: { [modelRef]: {} },
      },
      entries: { main: { model: modelRef } },
    },
    models: {
      mode: "merge",
      providers: {
        [REPLACEMENT_PROVIDER]: {
          baseUrl: apiRoot,
          api: "openai-responses",
          apiKey: "picker-key",
          request: { allowPrivateNetwork: true },
          models: [configuredModel(modelId)],
        },
      },
    },
  };
}

async function readTelegramIngressStatuses(stateDir: string, eventIds: string[]) {
  const database = await openExistingOpenClawStateDatabaseReadOnly({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  if (!database) {
    return [];
  }
  try {
    return executeSqliteQuerySync(
      database.db,
      getChannelIngressKysely(database.db)
        .selectFrom("channel_ingress_events")
        .select([
          "account_id as accountId",
          "event_id as eventId",
          "lane_key as laneKey",
          "queue_name as queueName",
          "status",
        ])
        .where("channel_id", "=", "telegram")
        .where("event_id", "in", eventIds)
        .orderBy("event_id", "asc"),
    ).rows;
  } finally {
    database.walMaintenance.close();
  }
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a source Gateway port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  return address.port;
}

async function resolveBuiltModule(params: {
  distDir: string;
  prefix: string;
  exportMarker: string;
}): Promise<string> {
  for (const name of await fs.readdir(params.distDir)) {
    if (!name.startsWith(params.prefix) || !name.endsWith(".js")) {
      continue;
    }
    const filePath = path.join(params.distDir, name);
    if ((await fs.readFile(filePath, "utf8")).includes(params.exportMarker)) {
      return pathToFileURL(filePath).href;
    }
  }
  throw new Error(`Could not resolve built ${params.prefix} module`);
}

async function startControlledSourceGateway(params: {
  configPath: string;
  replacementConfigPath: string;
  fixtureRoot: string;
  repoRoot: string;
}) {
  const bootstrapPath = path.join(params.fixtureRoot, "source-gateway-control.mjs");
  const port = await reservePort();
  const distDir = path.join(params.repoRoot, "dist");
  const [serverUrl, runtimeUrl] = await Promise.all([
    resolveBuiltModule({
      distDir,
      prefix: "server-",
      exportMarker: "resetPreparedModelCatalogForTest, startGatewayServer, truncateCloseReason",
    }),
    resolveBuiltModule({
      distDir,
      prefix: "prepared-model-runtime-",
      exportMarker: "export { PreparedModelRuntimeOwnerNotPublishedError",
    }),
  ]);
  await fs.writeFile(
    bootstrapPath,
    `
import fs from "node:fs/promises";
const [{ startGatewayServer }, preparedRuntime] = await Promise.all([
  import(${JSON.stringify(serverUrl)}),
  import(${JSON.stringify(runtimeUrl)}),
]);
const replacementConfig = JSON.parse(
  await fs.readFile(process.env.OPENCLAW_QA_REPLACEMENT_CONFIG_PATH, "utf8"),
);
const server = await startGatewayServer(Number(process.env.OPENCLAW_GATEWAY_PORT), {
  auth: { mode: "token", token: "picker-token" },
  bind: "loopback",
  controlUiEnabled: false,
});
await server.startupSettled;
let replacementGate;
process.send?.({ type: "ready" });
process.on("message", async (message) => {
  const id = message?.id;
  try {
    if (message?.action === "mark") {
      replacementGate = preparedRuntime.markPreparedModelRuntimeSnapshotsStale(
        "Telegram replacement proof",
        { waitForReplacement: true },
      );
    } else if (message?.action === "replace") {
      await preparedRuntime.refreshPreparedModelRuntimeSnapshots(replacementConfig, {
        gatewayLifecycle: true,
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
      });
    } else if (message?.action === "close") {
      preparedRuntime.rejectPendingPreparedModelRuntimeReplacement(
        replacementGate,
        new Error("Telegram replacement proof cleanup"),
      );
      await server.close({ reason: "Telegram replacement proof complete" });
    } else {
      throw new Error("Unknown source Gateway control action");
    }
    process.send?.({ type: "result", id });
    if (message?.action === "close") process.exit(0);
  } catch (error) {
    process.send?.({ type: "error", id, error: String(error?.stack ?? error) });
  }
});
`,
    "utf8",
  );

  const child = spawn(process.execPath, [bootstrapPath], {
    cwd: params.repoRoot,
    env: {
      ...process.env,
      HOME: params.fixtureRoot,
      OPENCLAW_HOME: params.fixtureRoot,
      OPENCLAW_CONFIG_PATH: params.configPath,
      OPENCLAW_STATE_DIR: path.join(params.fixtureRoot, "state"),
      OPENCLAW_QA_REPLACEMENT_CONFIG_PATH: params.replacementConfigPath,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let nextId = 1;
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Source Gateway exited before ready (${code ?? signal ?? "unknown"}):\n${output}`,
        ),
      );
    });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const value = message as { type?: string; id?: number; error?: string };
      if (value.type === "ready") {
        resolve();
        return;
      }
      if (value.id === undefined) {
        return;
      }
      const request = pending.get(value.id);
      if (!request) {
        return;
      }
      pending.delete(value.id);
      if (value.type === "result") {
        request.resolve();
      } else if (value.type === "error") {
        request.reject(new Error(value.error ?? "Source Gateway control failed"));
      }
    });
  });
  try {
    await withTestTimeout(ready, SOURCE_GATEWAY_TIMEOUT_MS, "Source Gateway did not become ready");
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await withTestTimeout(once(child, "exit"), 10_000, "Source Gateway did not stop");
    }
    throw new Error(`${String(error)}\n${output}`, { cause: error });
  }

  const request = async (action: "mark" | "replace" | "close") => {
    const id = nextId++;
    await withTestTimeout(
      new Promise<void>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ id, action }, (error) => {
          if (!error) {
            return;
          }
          pending.delete(id);
          reject(error);
        });
      }),
      action === "close" ? 10_000 : SOURCE_GATEWAY_TIMEOUT_MS,
      `Source Gateway ${action} control timed out`,
    );
  };
  return {
    request,
    output: () => output,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        await request("close").catch(() => child.kill("SIGTERM"));
      }
      if (child.exitCode === null && child.signalCode === null) {
        await withTestTimeout(once(child, "exit"), 10_000, "Source Gateway did not exit");
      }
    },
  };
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
      writeJson(res, 200, {
        models: [
          {
            name: DISCOVERED_MODEL,
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
      writeJson(res, 200, {
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
      hasCallback({ method, body }, `mdl_sel_ollama/${DISCOVERED_MODEL}`)
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
          const gateway = await gatewayOwner.start({
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
            .poll(() => pickerStage, {
              interval: 50,
              timeout: 30_000,
            })
            .toBe("providers");
          const warmedModels = await gateway.call("models.list", { view: "all" });
          expect(warmedModels).toMatchObject({
            models: expect.arrayContaining([
              expect.objectContaining({ provider: "ollama", id: DISCOVERED_MODEL }),
            ]),
          });
          expect(discoveryRequests).toBeGreaterThan(0);
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
              keyboardCallbackData(pickerEdits[1]).includes(`mdl_sel_ollama/${DISCOVERED_MODEL}`),
          ).toBe(true);
          expect(pickerEdits[3] && hasCallback(pickerEdits[3], "mdl_list_ollama_1")).toBe(true);

          expect(
            telegramCalls.filter((call) => call.method === "answerCallbackQuery"),
          ).toHaveLength(4);
          const preparedModels = await gateway.call("models.list", { view: "default" });
          expect(preparedModels).toMatchObject({
            models: expect.arrayContaining([
              expect.objectContaining({ provider: "ollama", id: DISCOVERED_MODEL }),
            ]),
          });
          expect(discoveryRequests).toBe(warmDiscoveryRequests);
          expect(postWarmDiscoveryAttempts).toBe(0);

          discoveryFrozen = false;
          const refreshedModels = await gateway.call("models.list", {
            view: "default",
            refresh: true,
          });
          expect(refreshedModels).toMatchObject({
            models: expect.arrayContaining([
              expect.objectContaining({ provider: "ollama", id: DISCOVERED_MODEL }),
            ]),
          });
          expect(discoveryRequests).toBeGreaterThan(warmDiscoveryRequests);
        } finally {
          await settleCleanup(async () => await stopQaGatewayFixture(gatewayOwner));
        }
      }),
  );
}, 120_000);

test("recovers a replaced model catalog and drains the following Telegram callback", async () => {
  const telegramCalls: TelegramCall[] = [];
  const pendingUpdates: unknown[] = [];
  const getUpdatesOffsets: Array<number | undefined> = [];
  let telegramPolls = 0;

  const queueCallback = (updateId: number, data: string) => {
    pendingUpdates.push(callbackUpdate(updateId, `replacement-callback-${updateId}`, data));
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
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
      telegramPolls += 1;
      getUpdatesOffsets.push(typeof body.offset === "number" ? body.offset : undefined);
      succeed(res, pendingUpdates.splice(0));
      return;
    }
    telegramCalls.push({ method, body });
    succeed(res);
  };

  await withServer(
    (req, res) => {
      void handleRequest(req, res);
    },
    async (apiRoot) =>
      await withTempDir("openclaw-telegram-model-picker-replacement-", async (fixtureRoot) => {
        const repoRoot = path.resolve(import.meta.dirname, "../../../..");
        const stateDir = path.join(fixtureRoot, "state");
        const configPath = path.join(fixtureRoot, "openclaw.json");
        const replacementConfigPath = path.join(fixtureRoot, "replacement-openclaw.json");
        const initialConfig = pickerConfig(apiRoot, PREPARED_MODEL);
        const replacementConfig = pickerConfig(apiRoot, REPLACEMENT_MODEL);
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
        await fs.writeFile(
          replacementConfigPath,
          `${JSON.stringify(replacementConfig, null, 2)}\n`,
          "utf8",
        );
        const gateway = await startControlledSourceGateway({
          configPath,
          replacementConfigPath,
          fixtureRoot,
          repoRoot,
        });
        const queue = createChannelIngressQueue({
          channelId: "telegram",
          accountId: "picker",
          stateDir,
          access: "read-only",
        });
        const eventIds = ["0000000000000010", "0000000000000011"];

        try {
          try {
            await expect
              .poll(() => telegramPolls, { interval: 25, timeout: 30_000 })
              .toBeGreaterThan(0);
          } catch (error) {
            throw new Error(`${String(error)}\n${gateway.output()}`, { cause: error });
          }
          await gateway.request("mark");
          queueCallback(10, `mdl_list_${REPLACEMENT_PROVIDER}_1`);
          queueCallback(11, "mdl_prov");
          await expect
            .poll(async () => await readTelegramIngressStatuses(stateDir, eventIds), {
              interval: 5,
              timeout: 600,
            })
            .toEqual([
              {
                accountId: "picker",
                eventId: eventIds[0],
                laneKey: `telegram:${CHAT_ID}`,
                queueName: '["telegram","picker"]',
                status: "claimed",
              },
              {
                accountId: "picker",
                eventId: eventIds[1],
                laneKey: `telegram:${CHAT_ID}`,
                queueName: '["telegram","picker"]',
                status: "pending",
              },
            ]);

          await gateway.request("replace");

          await expect
            .poll(
              () =>
                telegramCalls.filter(
                  (call) => call.method === "editMessageText" && inlineKeyboard(call).length > 0,
                ),
              { interval: 50, timeout: 30_000 },
            )
            .toHaveLength(2);
          const firstPickerEdit = telegramCalls.find(
            (call) => call.method === "editMessageText" && inlineKeyboard(call).length > 0,
          );
          expect(firstPickerEdit).toBeDefined();
          expect(hasCallback(firstPickerEdit!, `mdl_sel_${REPLACEMENT_MODEL_REF}`)).toBe(true);
          expect(
            telegramCalls
              .filter((call) => call.method === "answerCallbackQuery")
              .map((call) => call.body.callback_query_id)
              .toSorted((a, b) => String(a).localeCompare(String(b))),
          ).toEqual(["replacement-callback-10", "replacement-callback-11"]);
          expect(getUpdatesOffsets).toContain(12);

          await expect
            .poll(
              async () => ({
                claims: (await queue.listClaims()).length,
                failed: (await queue.listFailed?.({ limit: "all" }))?.length ?? 0,
                pending: (await queue.listPending({ limit: "all" })).length,
                statuses: await readTelegramIngressStatuses(stateDir, eventIds),
              }),
              { interval: 50, timeout: 30_000 },
            )
            .toEqual({
              claims: 0,
              failed: 0,
              pending: 0,
              statuses: eventIds.map((eventId) => ({
                accountId: "picker",
                eventId,
                laneKey: `telegram:${CHAT_ID}`,
                queueName: '["telegram","picker"]',
                status: "completed",
              })),
            });
        } finally {
          await settleCleanup(gateway.close);
        }
      }),
  );
}, 180_000);
