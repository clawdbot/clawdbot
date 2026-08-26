import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { telegramPlugin } from "../extensions/telegram/api.js";
import { sendMessageTelegram } from "../extensions/telegram/runtime-api.js";
import type { CliOutput } from "../src/agents/cli-output-contracts.js";
import { createCliToolTracking } from "../src/agents/cli-runner/execute-tool-tracking.js";
import type { PreparedCliRunContext } from "../src/agents/cli-runner/types.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import { buildReplyPayloads } from "../src/auto-reply/reply/agent-runner-payloads.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";

const BOT_TOKEN = "000000:REDACTED-PROOF-TOKEN";
const CHAT_ID = "12345";
const SENT_TEXT = "duplicate text";
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

type TelegramCall = { method: string; path: string };

async function drainRequest(req: IncomingMessage): Promise<void> {
  for await (const chunk of req) {
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
  const server = createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      await drainRequest(req);
      const method = requestUrl.pathname.match(/^\/bot[^/]+\/(.+)$/)?.[1] ?? "unknown";
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
            text: SENT_TEXT,
          },
        });
        return;
      }
      writeJson(res, 200, { ok: true, result: true });
    })().catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
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
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const record = createPluginRecord({
  id: "telegram",
  name: "Telegram",
  source: "extensions/telegram/api.ts",
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

function captureMessageToolEvidence(
  cfg: OpenClawConfig,
  args: Record<string, unknown>,
  result: unknown,
) {
  const tracking = createCliToolTracking({
    params: {
      config: cfg,
      messageChannel: "telegram",
      messageProvider: "telegram",
      currentChannelId: CHAT_ID,
      currentMessagingTarget: CHAT_ID,
      replyToMode: "off",
    },
    preparedBackend: {},
  } as unknown as PreparedCliRunContext);
  const toolCallId = "real-message-tool-proof";
  tracking.handleCliToolUseStart({
    toolCallId,
    name: "message",
    kind: "tool_use",
    args,
  });
  tracking.handleCliToolResult({
    toolCallId,
    name: "message",
    isError: false,
    result,
  });
  return tracking.withExecutionEvidence({ text: "" } as CliOutput);
}

const api = await startTelegramApi();
const workspace = await mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-dedupe-proof-"));
const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
try {
  const cfg = {
    channels: {
      telegram: {
        enabled: true,
        botToken: BOT_TOKEN,
        apiRoot: api.apiRoot,
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        network: { dangerouslyAllowPrivateNetwork: true },
      },
    },
  } as OpenClawConfig;
  const configPath = path.join(workspace, "openclaw.json");
  await writeFile(configPath, JSON.stringify(cfg));
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  const toolArgs = {
    action: "send",
    channel: "telegram",
    to: CHAT_ID,
    message: SENT_TEXT,
  };
  const messageTool = createMessageTool({
    config: cfg,
    currentChannelProvider: "telegram",
    currentChannelId: CHAT_ID,
    currentMessagingTarget: CHAT_ID,
    agentAccountId: "default",
    runId: "telegram-dedupe-proof",
    conversationReadOrigin: "direct-operator",
    getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
    resolveCommandSecretRefsViaGateway: async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }),
  });
  const toolResult = await messageTool.execute("real-message-tool-proof", toolArgs);
  const evidence = captureMessageToolEvidence(cfg, toolArgs, toolResult);
  const sentTexts = evidence.messagingToolSentTexts ?? [];
  const sentTargets = evidence.messagingToolSentTargets ?? [];
  const emittedTarget = sentTargets.at(0);
  if (
    sentTexts.length !== 1 ||
    sentTexts[0] !== SENT_TEXT ||
    sentTargets.length !== 1 ||
    !emittedTarget ||
    emittedTarget.provider !== "telegram" ||
    emittedTarget.to !== `telegram:${CHAT_ID}`
  ) {
    throw new Error(
      `message-tool tracking did not emit route evidence: ${JSON.stringify(evidence)}`,
    );
  }

  const build = async (payload: { text: string; mediaUrl?: string; mediaUrls?: string[] }) =>
    await buildReplyPayloads({
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off",
      payloads: [payload],
      messageProvider: "telegram",
      originatingChannel: "telegram",
      originatingTo: emittedTarget.to,
      messagingToolSentTexts: sentTexts,
      messagingToolSentTargets: sentTargets,
    });

  const sendReplyPayloads = async (
    payloads: Awaited<ReturnType<typeof build>>["replyPayloads"],
  ) => {
    const sendPayload = telegramPlugin.outbound?.sendPayload;
    if (!sendPayload) {
      throw new Error("Telegram production plugin has no outbound.sendPayload");
    }
    for (const payload of payloads) {
      await sendPayload({
        cfg,
        to: CHAT_ID,
        text: payload.text ?? "",
        payload,
        deps: { telegram: sendMessageTelegram },
        mediaAccess: { localRoots: [workspace] },
      });
    }
  };

  const blankPayload = { text: SENT_TEXT, mediaUrls: ["   "] };
  const realMediaPath = path.join(workspace, "report.png");
  await writeFile(realMediaPath, Buffer.from(TINY_PNG_BASE64, "base64"));
  const realPayload = { text: SENT_TEXT, mediaUrls: [realMediaPath] };
  const blankResult = await build(blankPayload);
  const blankCallsBeforeSend = api.calls.length;
  await sendReplyPayloads(blankResult.replyPayloads);
  const blankCalls = api.calls.slice(blankCallsBeforeSend);
  const realResult = await build(realPayload);
  const realCallsBeforeSend = api.calls.length;
  await sendReplyPayloads(realResult.replyPayloads);
  const realCalls = api.calls.slice(realCallsBeforeSend);
  const blankParts = resolveSendableOutboundReplyParts(blankPayload);
  const realParts = resolveSendableOutboundReplyParts(realPayload);
  const telegramSendCalls = api.calls.filter((call) => call.method === "sendMessage");
  const telegramMediaCalls = api.calls.filter((call) => call.method === "sendPhoto");
  const passed =
    !blankParts.hasMedia &&
    blankResult.replyPayloads.length === 0 &&
    blankCalls.length === 0 &&
    realParts.hasMedia &&
    realResult.replyPayloads.length === 1 &&
    realCalls.filter((call) => call.method === "sendPhoto").length === 1 &&
    telegramSendCalls.length === 1 &&
    telegramMediaCalls.length === 1;
  console.log(
    JSON.stringify(
      {
        verdict: passed ? "PASS" : "FAIL",
        productionEntry:
          "createMessageTool -> runMessageAction -> Telegram transport; CLI tracking -> buildReplyPayloads -> telegramPlugin.outbound.sendPayload",
        messageTool: {
          emittedTextEvidence: sentTexts,
          emittedTargetEvidence: sentTargets,
          botApiSendMessageCalls: telegramSendCalls.length,
        },
        blankMedia: {
          canonicalHasMedia: blankParts.hasMedia,
          retainedPayloads: blankResult.replyPayloads.length,
          additionalBotApiCalls: blankCalls.length,
        },
        realMedia: {
          canonicalHasMedia: realParts.hasMedia,
          retainedPayloads: realResult.replyPayloads.length,
          additionalBotApiSendPhotoCalls: realCalls.filter((call) => call.method === "sendPhoto")
            .length,
          totalBotApiSendPhotoCalls: telegramMediaCalls.length,
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
  if (previousConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
  }
  await api.stop().catch(() => undefined);
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
}
