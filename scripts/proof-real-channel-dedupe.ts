import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  startQaGatewayChild,
  startQaMockOpenAiServer,
  TINY_PNG_BASE64,
} from "../extensions/qa-lab/api.js";
import { sendMessageTelegram } from "../extensions/telegram/runtime-api.js";
import { telegramPlugin } from "../extensions/telegram/src/channel.js";
import { buildReplyPayloads } from "../src/auto-reply/reply/agent-runner-payloads.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { resolveSendableOutboundReplyParts } from "../src/plugin-sdk/reply-payload.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";

const BOT_TOKEN = "000000:REDACTED-PROOF-TOKEN";
const CHAT_ID = "12345";

type TelegramCall = { method: string; path: string };

async function drainRequest(req: IncomingMessage): Promise<void> {
  for await (const chunk of req) {
    // The production Telegram client may use JSON or multipart/form-data.
    void chunk;
  }
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function startTelegramApi() {
  const calls: TelegramCall[] = [];
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    await drainRequest(req);
    const match = requestUrl.pathname.match(/^\/bot[^/]+\/(.+)$/);
    const method = match?.[1] ?? "unknown";
    calls.push({ method, path: requestUrl.pathname });
    if (method === "getMe") {
      writeJson(res, 200, { ok: true, result: { id: 999, is_bot: true, username: "qa_bot" } });
      return;
    }
    if (method === "getUpdates" || method === "deleteWebhook") {
      writeJson(res, 200, { ok: true, result: method === "getUpdates" ? [] : true });
      return;
    }
    if (method === "sendMessage" || method === "sendPhoto") {
      writeJson(res, 200, {
        ok: true,
        result: {
          message_id: 1000 + calls.filter((call) => call.method === method).length,
          date: 1_754_000_000,
          chat: { id: Number(CHAT_ID), type: "private" },
          text: "duplicate text",
        },
      });
      return;
    }
    writeJson(res, 200, { ok: true, result: true });
  };
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Telegram proof API did not bind a TCP port");
  }
  return {
    apiRoot: `http://127.0.0.1:${address.port}`,
    calls,
    stop: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

async function waitForGatewayRun(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  providerBaseUrl: string,
): Promise<{ providerRequests: number }> {
  const started = (await gateway.call("chat.send", {
    sessionKey: "agent:qa:telegram-dedupe-proof",
    message: "Telegram dedupe Gateway proof. Reply exactly TELEGRAM_DEDUPE_GATEWAY_OK.",
    deliver: false,
    idempotencyKey: "telegram-dedupe-gateway-proof",
  })) as { runId?: string; status?: string };
  if (started.status !== "started" || !started.runId) {
    throw new Error(`QA Gateway chat.send did not start: ${JSON.stringify(started)}`);
  }
  const terminal = (await gateway.call(
    "agent.wait",
    { runId: started.runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  )) as { status?: string };
  if (terminal.status !== "ok") {
    throw new Error(`QA Gateway agent.wait failed: ${JSON.stringify(terminal)}`);
  }
  const response = await fetch(`${providerBaseUrl}/debug/requests`);
  if (!response.ok) {
    throw new Error(`mock provider debug endpoint failed: ${response.status}`);
  }
  const requests = (await response.json()) as unknown[];
  return { providerRequests: requests.length };
}

const record = createPluginRecord({
  id: "telegram",
  name: "Telegram",
  source: "extensions/telegram/src/channel.ts",
  origin: "bundled",
  enabled: true,
  configSchema: true,
});

const registryBuilder = createPluginRegistry({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  runtime: {} as PluginRuntime,
  activateGlobalSideEffects: false,
});
registryBuilder.registerChannel(
  record,
  telegramPlugin as unknown as Parameters<typeof registryBuilder.registerChannel>[1],
);
registryBuilder.registry.plugins.push(record);
setActivePluginRegistry(registryBuilder.registry, "pr-128580-real-channel-proof");

async function build(payload: { text: string; mediaUrl?: string; mediaUrls?: string[] }) {
  return await buildReplyPayloads({
    isHeartbeat: false,
    didLogHeartbeatStrip: false,
    blockStreamingEnabled: false,
    blockReplyPipeline: null,
    replyToMode: "off",
    payloads: [payload],
    messageProvider: "telegram",
    originatingChannel: "telegram",
    originatingTo: "12345",
    messagingToolSentTexts: ["duplicate text"],
  });
}

const api = await startTelegramApi();
const mock = await startQaMockOpenAiServer();
const workspace = await mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-dedupe-proof-"));
let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
try {
  const cfg = {
    channels: {
      telegram: {
        enabled: true,
        botToken: BOT_TOKEN,
        apiRoot: api.apiRoot,
        dmPolicy: "disabled",
        groupPolicy: "disabled",
        network: { dangerouslyAllowPrivateNetwork: true },
      },
    },
  } as OpenClawConfig;
  gateway = await startQaGatewayChild({
    repoRoot: path.resolve(import.meta.dirname, ".."),
    useRepoCli: true,
    providerBaseUrl: `${mock.baseUrl}/v1`,
    transportBaseUrl: api.apiRoot,
    transport: {
      requiredPluginIds: ["telegram"],
      createGatewayConfig: () => ({ channels: cfg.channels }),
    },
    controlUiEnabled: false,
    runtimeEnvPatch: {
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
    },
    mutateConfig: (current) => {
      current.agents!.defaults!.workspace = workspace;
      return current;
    },
  });
  const gatewayProof = await waitForGatewayRun(gateway, mock.baseUrl);
  setActivePluginRegistry(registryBuilder.registry, "pr-128580-real-channel-proof");
  const blankPayload: { text: string; mediaUrl?: string; mediaUrls?: string[] } = {
    text: "duplicate text",
    mediaUrl: "   ",
  };
  const realMediaPath = path.join(workspace, "report.png");
  const realPayload: { text: string; mediaUrl?: string; mediaUrls?: string[] } = {
    text: "duplicate text",
    mediaUrl: realMediaPath,
  };
  await writeFile(realMediaPath, Buffer.from(TINY_PNG_BASE64, "base64"));
  const blankResult = await build(blankPayload);
  const realResult = await build(realPayload);
  const sendPayload = telegramPlugin.outbound?.sendPayload;
  if (!sendPayload) {
    throw new Error("Telegram production plugin has no outbound.sendPayload");
  }
  const telegramCallsBeforeBlank = api.calls.length;
  for (const payload of blankResult.replyPayloads) {
    await sendPayload({
      cfg,
      to: CHAT_ID,
      text: payload.text ?? "",
      payload,
      deps: { telegram: sendMessageTelegram },
      mediaAccess: { localRoots: [workspace] },
    });
  }
  const telegramCallsBeforeRealMedia = api.calls.length;
  for (const payload of realResult.replyPayloads) {
    await sendPayload({
      cfg,
      to: CHAT_ID,
      text: payload.text ?? "",
      payload,
      deps: { telegram: sendMessageTelegram },
      mediaAccess: { localRoots: [workspace] },
    });
  }
  const blankParts = resolveSendableOutboundReplyParts(blankPayload);
  const realParts = resolveSendableOutboundReplyParts(realPayload);
  const blankApiCalls = api.calls.slice(telegramCallsBeforeBlank, telegramCallsBeforeRealMedia);
  const telegramSendCalls = api.calls.filter((call) => call.method === "sendMessage");
  const telegramMediaCalls = api.calls.filter((call) => call.method === "sendPhoto");
  const blankSendCalls = blankApiCalls.filter((call) => call.method === "sendMessage");
  const blankMediaCalls = blankApiCalls.filter((call) => call.method === "sendPhoto");
  const passed =
    gatewayProof.providerRequests > 0 &&
    !blankParts.hasMedia &&
    blankResult.replyPayloads.length === 0 &&
    realParts.hasMedia &&
    realResult.replyPayloads.length === 1 &&
    blankSendCalls.length === 0 &&
    blankMediaCalls.length === 0 &&
    telegramSendCalls.length === 0 &&
    telegramMediaCalls.length === 1;
  console.log(
    JSON.stringify(
      {
        verdict: passed ? "PASS" : "FAIL",
        gateway: { started: true, providerRequests: gatewayProof.providerRequests },
        productionEntry:
          "buildReplyPayloads -> telegramPlugin.outbound.sendPayload -> sendMessageTelegram -> Telegram Bot API",
        blankMedia: {
          legacyPredicateHasMedia: Boolean(blankPayload.mediaUrl || blankPayload.mediaUrls?.length),
          canonicalHasMedia: blankParts.hasMedia,
          retainedPayloads: blankResult.replyPayloads.length,
          botApiSendMessageCalls: blankSendCalls.length,
          botApiSendPhotoCalls: blankMediaCalls.length,
        },
        realMedia: {
          canonicalHasMedia: realParts.hasMedia,
          retainedPayloads: realResult.replyPayloads.length,
          botApiSendPhotoCalls: telegramMediaCalls.length,
          mediaSource: "workspace/report.png",
        },
        registry: {
          channelId: registryBuilder.registry.channels[0]?.plugin.id,
          source: registryBuilder.registry.channels[0]?.source,
        },
      },
      null,
      2,
    ),
  );
  if (!passed) {
    process.exitCode = 1;
  }
} finally {
  await gateway?.stop().catch(() => undefined);
  await mock.stop().catch(() => undefined);
  await api.stop().catch(() => undefined);
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
}
