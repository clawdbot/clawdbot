/**
 * Exercises the real message-tool and Telegram outbound path against a local
 * Bot API boundary. No Telegram credentials or external network are needed.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramPlugin } from "../extensions/telegram/src/channel.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import { buildReplyPayloads } from "../src/auto-reply/reply/agent-runner-payloads.js";
import { routeReply } from "../src/auto-reply/reply/route-reply.js";
import type { ChannelPlugin } from "../src/channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";

type RecordedRequest = {
  method: string;
  body: Record<string, unknown>;
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

async function createBotApiRecorder() {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const contentType = request.headers["content-type"] ?? "";
      let body: Record<string, unknown> = {};
      if (rawBody) {
        body = contentType.includes("application/json")
          ? JSON.parse(rawBody)
          : Object.fromEntries(new URLSearchParams(rawBody).entries());
      }
      const method = (request.url ?? "/").split("/").at(-1) ?? "unknown";
      requests.push({ method, body });
      const chatId = Number(body.chat_id) || 12345;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 50000 + requests.length,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: "private" },
            ...(typeof body.text === "string" ? { text: body.text } : {}),
          },
        }),
      );
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("local Bot API recorder did not bind");
  }
  return {
    requests,
    apiRoot: `http://127.0.0.1:${address.port}`,
    close: async () =>
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

async function main() {
  const recorder = await createBotApiRecorder();
  const tempStateDir = mkdtempSync(join(tmpdir(), "openclaw-pr-128580-proof-"));
  const tempConfigPath = join(tempStateDir, "openclaw.json");
  writeFileSync(tempConfigPath, "{}\n", "utf8");
  const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;
  process.env.OPENCLAW_STATE_DIR = tempStateDir;

  try {
    resetPluginRuntimeStateForTest();
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
    registryBuilder.registerChannel(record, telegramPlugin as ChannelPlugin);
    registryBuilder.registry.plugins.push(record);
    setActivePluginRegistry(registryBuilder.registry, "pr-128580-production-path");

    const cfg = {
      agents: { defaults: { workspace: tempStateDir } },
      channels: {
        telegram: {
          botToken: "123456:proof-token",
          apiRoot: recorder.apiRoot,
          dmPolicy: "open",
          allowFrom: ["*"],
          actions: { sendMessage: true },
          network: { dangerouslyAllowPrivateNetwork: true },
        },
      },
    } as OpenClawConfig;
    const tool = createMessageTool({
      config: cfg,
      getRuntimeConfig: () => cfg,
      currentChannelProvider: "telegram",
      currentChannelId: "12345",
      currentMessagingTarget: "12345",
      currentChatType: "direct",
      conversationReadOrigin: "direct-operator",
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: async ({ config }) => ({
        resolvedConfig: config,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
    });
    const text = "MANTIS BLANK-MEDIA DEDUPE — one visible reply expected";
    const toolResult = await tool.execute("proof-message-tool-call", {
      action: "send",
      to: "12345",
      message: text,
    });
    const common = {
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off" as const,
      messageProvider: "telegram",
      originatingChannel: "telegram",
      originatingTo: "12345",
      messagingToolSentTexts: [text],
      messagingToolSentTargets: [{ tool: "telegram", provider: "telegram", to: "12345", text }],
    };
    const blank = await buildReplyPayloads({
      ...common,
      payloads: [{ text, mediaUrl: "   " }],
    });
    const realMedia = await buildReplyPayloads({
      ...common,
      payloads: [{ text, mediaUrl: join(tempStateDir, "report.png") }],
    });
    writeFileSync(join(tempStateDir, "report.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
    const deliverFinalPayloads = async (
      payloads: Awaited<ReturnType<typeof buildReplyPayloads>>["replyPayloads"],
    ) => {
      const results = [];
      for (const payload of payloads) {
        results.push(
          await routeReply({
            payload,
            channel: "telegram",
            to: "12345",
            cfg,
            sessionKey: "agent:main:main",
            mirror: false,
            replyKind: "final",
          }),
        );
      }
      return results;
    };
    const blankApiCallsBefore = recorder.requests.length;
    const blankFinalResults = await deliverFinalPayloads(blank.replyPayloads);
    const blankApiCalls = recorder.requests.slice(blankApiCallsBefore);
    const realMediaApiCallsBefore = recorder.requests.length;
    const realMediaFinalResults = await deliverFinalPayloads(realMedia.replyPayloads);
    const realMediaApiCalls = recorder.requests.slice(realMediaApiCallsBefore);
    const sendMessageRequests = recorder.requests.filter(
      (request) => request.method === "sendMessage",
    );
    const sendPhotoRequests = recorder.requests.filter((request) => request.method === "sendPhoto");
    const passed =
      sendMessageRequests.length === 1 &&
      blank.replyPayloads.length === 0 &&
      blankFinalResults.length === 0 &&
      blankApiCalls.length === 0 &&
      realMedia.replyPayloads.length === 1 &&
      realMediaFinalResults.length === 1 &&
      realMediaFinalResults[0]?.ok === true &&
      realMediaFinalResults[0]?.delivered &&
      realMediaApiCalls.filter((request) => request.method === "sendPhoto").length === 1 &&
      sendPhotoRequests.length === 1;
    console.log(
      JSON.stringify(
        {
          verdict: passed ? "PASS" : "FAIL",
          productionPath:
            "createMessageTool -> runMessageAction -> Telegram durable send; buildReplyPayloads -> routeReply -> sendDurableMessageBatchCore -> Telegram Bot API adapter",
          toolResult: toolResult.content?.[0],
          botApiMethods: recorder.requests.map((request) => request.method),
          messageToolSendMessageCalls: sendMessageRequests.length,
          blankFinal: {
            retainedPayloads: blank.replyPayloads.length,
            routeResults: blankFinalResults.length,
            additionalBotApiCalls: blankApiCalls.length,
          },
          realMediaFinal: {
            retainedPayloads: realMedia.replyPayloads.length,
            routeResults: realMediaFinalResults,
            additionalBotApiMethods: realMediaApiCalls.map((request) => request.method),
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
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await recorder.close();
    rmSync(tempStateDir, { recursive: true, force: true });
  }
}

await main();
