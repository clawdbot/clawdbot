/**
 * Exercises the real message-tool and Telegram outbound path against a local
 * Bot API boundary. No Telegram credentials or external network are needed.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramPlugin } from "../extensions/telegram/channel-plugin-api.js";
import { subscribeEmbeddedAgentSession } from "../src/agents/embedded-agent-subscribe.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import { buildReplyPayloads } from "../src/auto-reply/reply/agent-runner-payloads.js";
import { routeReply } from "../src/auto-reply/reply/route-reply.js";
import type { ChannelPlugin } from "../src/channels/plugins/types.public.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";

type RecordedRequest = {
  method: string;
  body: Record<string, unknown>;
};

type RecordedMultipartFile = {
  filename: string;
  contentType: string;
  byteLength: number;
  contentSha256: string;
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, "base64");
const TINY_PNG_SHA256 = createHash("sha256").update(TINY_PNG_BYTES).digest("hex");
const PROOF_CHAT_ID = "12345";
const PROOF_MEDIA_FILENAME = "report.png";

function parseMultipartFormData(body: Buffer, contentType: string): Record<string, unknown> {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]?.trim();
  if (!boundary) {
    throw new Error("multipart request is missing its boundary");
  }

  const parts = body.toString("latin1").split(`--${boundary}`);
  const fields: Record<string, unknown> = {};
  for (const rawPart of parts.slice(1)) {
    if (rawPart.startsWith("--")) {
      break;
    }
    const part = rawPart.startsWith("\r\n") ? rawPart.slice(2) : rawPart;
    const separator = part.indexOf("\r\n\r\n");
    if (separator < 0) {
      continue;
    }
    const headers = part.slice(0, separator);
    let value = part.slice(separator + 4);
    if (value.endsWith("\r\n")) {
      value = value.slice(0, -2);
    }
    const disposition = /(?:^|\r\n)content-disposition:[^\r\n]+/i.exec(headers)?.[0];
    const nameMatch = /\bname=(?:"([^"]+)"|([^;\s]+))/i.exec(disposition ?? "");
    const name = nameMatch?.[1] ?? nameMatch?.[2];
    if (!name) {
      continue;
    }
    const filenameMatch = /\bfilename=(?:"([^"]*)"|([^;\s]+))/i.exec(headers);
    const filename = filenameMatch?.[1] ?? filenameMatch?.[2];
    if (filename !== undefined) {
      const fileBytes = Buffer.from(value, "latin1");
      fields[name] = {
        filename,
        contentType: /(?:^|\r\n)content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? "",
        byteLength: fileBytes.length,
        contentSha256: createHash("sha256").update(fileBytes).digest("hex"),
      } satisfies RecordedMultipartFile;
    } else {
      fields[name] = value;
    }
  }
  return fields;
}

function validatePhotoRequest(body: Record<string, unknown>): string | undefined {
  if (body.chat_id !== PROOF_CHAT_ID) {
    return `unexpected sendPhoto chat_id: ${String(body.chat_id)}`;
  }
  const photo = body.photo;
  if (typeof photo !== "string" || !photo.startsWith("attach://")) {
    return "sendPhoto is missing its multipart photo attachment reference";
  }
  const attachmentName = photo.slice("attach://".length);
  const attachment = body[attachmentName];
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
    return "sendPhoto attachment reference has no multipart file part";
  }
  const file = attachment as Partial<RecordedMultipartFile>;
  if (file.filename !== PROOF_MEDIA_FILENAME) {
    return `unexpected photo filename: ${String(file.filename)}`;
  }
  if (!file.contentType) {
    return "multipart photo file is missing its content type";
  }
  if (file.byteLength !== TINY_PNG_BYTES.length) {
    return `unexpected photo byte length: ${String(file.byteLength)}`;
  }
  if (file.contentSha256 !== TINY_PNG_SHA256) {
    return `unexpected photo sha256: ${String(file.contentSha256)}`;
  }
  return undefined;
}

async function createBotApiRecorder() {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks);
      const contentType = request.headers["content-type"] ?? "";
      let body: Record<string, unknown> = {};
      let parseError: string | undefined;
      if (rawBody.length > 0) {
        try {
          body = contentType.includes("application/json")
            ? JSON.parse(rawBody.toString("utf8"))
            : contentType.includes("multipart/form-data")
              ? parseMultipartFormData(rawBody, contentType)
              : Object.fromEntries(new URLSearchParams(rawBody.toString("utf8")).entries());
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
        }
      }
      const method = (request.url ?? "/").split("/").at(-1) ?? "unknown";
      requests.push({ method, body });
      const validationError =
        parseError ?? (method === "sendPhoto" ? validatePhotoRequest(body) : undefined);
      const chatId = Number(body.chat_id) || Number(PROOF_CHAT_ID);
      response.writeHead(validationError ? 400 : 200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          validationError
            ? { ok: false, error_code: 400, description: validationError }
            : {
                ok: true,
                result: {
                  message_id: 50000 + requests.length,
                  date: Math.floor(Date.now() / 1000),
                  chat: { id: chatId, type: "private" },
                  ...(typeof body.text === "string" ? { text: body.text } : {}),
                },
              },
        ),
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
  let unsubscribe: (() => void) | undefined;
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
    const sessionManager = {};
    const session = {
      sessionManager,
      subscribe: () => () => {},
      isCompacting: false,
      abortCompaction() {},
    } as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"];
    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "pr-128580-proof-run",
      messageChannel: "telegram",
      config: cfg,
      sessionKey: "agent:main:main",
      currentChannelId: PROOF_CHAT_ID,
      currentMessagingTarget: PROOF_CHAT_ID,
      currentAccountId: "default",
      replyToMode: "off",
    });
    unsubscribe = subscription.unsubscribe;
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
    const toolResult = await subscription.runToolLifecycle({
      toolName: "message",
      toolCallId: "proof-message-tool-call",
      args: { action: "send", to: PROOF_CHAT_ID, message: text },
      execute: async (onImplementationStart) => {
        onImplementationStart();
        return await tool.execute("proof-message-tool-call", {
          action: "send",
          to: PROOF_CHAT_ID,
          message: text,
        });
      },
    });
    const runResultDeliveryFacts = {
      messagingToolSentTexts: subscription.getMessagingToolSentTexts(),
      messagingToolSentMediaUrls: subscription.getMessagingToolSentMediaUrls(),
      messagingToolSentTargets: subscription.getMessagingToolSentTargets(),
    };
    const common = {
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off" as const,
      messageProvider: "telegram",
      originatingChannel: "telegram",
      originatingTo: PROOF_CHAT_ID,
      ...runResultDeliveryFacts,
    };
    const blank = await buildReplyPayloads({
      ...common,
      payloads: [{ text, mediaUrl: "   " }],
    });
    const realMedia = await buildReplyPayloads({
      ...common,
      payloads: [{ text, mediaUrl: join(tempStateDir, "report.png") }],
    });
    writeFileSync(join(tempStateDir, PROOF_MEDIA_FILENAME), TINY_PNG_BYTES);
    const deliverFinalPayloads = async (
      payloads: Awaited<ReturnType<typeof buildReplyPayloads>>["replyPayloads"],
    ) => {
      const results = [];
      for (const payload of payloads) {
        results.push(
          await routeReply({
            payload,
            channel: "telegram",
            to: PROOF_CHAT_ID,
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
    const photoValidationError =
      sendPhotoRequests.length === 1
        ? validatePhotoRequest(sendPhotoRequests[0].body)
        : "expected one sendPhoto request";
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
      photoValidationError === undefined;
    console.log(
      JSON.stringify(
        {
          verdict: passed ? "PASS" : "FAIL",
          productionPath:
            "createMessageTool -> runMessageAction -> Telegram durable send; buildReplyPayloads -> routeReply -> sendDurableMessageBatchCore -> Telegram Bot API adapter",
          toolResult: toolResult.content?.[0],
          runResultDeliveryFacts,
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
            photoRequestValidation: photoValidationError ?? "PASS",
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
    unsubscribe?.();
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
