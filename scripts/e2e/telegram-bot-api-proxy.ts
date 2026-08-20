#!/usr/bin/env -S node --import tsx

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;

const MAX_API_BODY_BYTES = 1024 * 1024;
const MAX_MEDIA_BODY_BYTES = 110 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_NON_POLL_REQUESTS = 2048;
const MAX_SENDS = 64;
const GROUP_UPDATE_TYPES = [
  "message",
  "edited_message",
  "callback_query",
  "message_reaction",
  "message_reaction_count",
];
const SEND_METHODS = new Set([
  "sendAnimation",
  "sendAudio",
  "sendDocument",
  "sendLocation",
  "sendMessage",
  "sendPhoto",
  "sendPoll",
  "sendSticker",
  "sendVenue",
  "sendVideo",
  "sendVideoNote",
  "sendVoice",
]);
const MEDIA_SEND_METHODS = new Set([
  "sendAnimation",
  "sendAudio",
  "sendDocument",
  "sendPhoto",
  "sendVideo",
  "sendVideoNote",
  "sendVoice",
]);
const OWN_MESSAGE_METHODS = new Set([
  "deleteMessage",
  "editMessageCaption",
  "editMessageReplyMarkup",
  "editMessageText",
]);

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function forwardedHeaders(headers: IncomingMessage["headers"]): http.OutgoingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => value !== undefined && !hopByHopHeaders.has(name),
    ),
  );
}

async function readBody(stream: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(stream.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("request body exceeds the proof limit");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error("request body exceeds the proof limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function parseJsonObject(body: Buffer): JsonObject {
  const value: unknown = JSON.parse(body.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value as JsonObject;
}

function requireJson(body: Buffer, contentType: string): JsonObject {
  if (!/^application\/json(?:\s*;.*)?$/iu.test(contentType)) {
    throw new Error("Bot API request must use JSON");
  }
  return parseJsonObject(body);
}

async function requireChatScope(body: Buffer, contentType: string, chatId: string): Promise<void> {
  let chatIds: unknown[];
  let replyParameters: unknown;
  if (/^multipart\/form-data\s*;/iu.test(contentType)) {
    const bodyBytes =
      body.buffer instanceof ArrayBuffer
        ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
        : Uint8Array.from(body);
    const form = await new Response(bodyBytes, {
      headers: { "content-type": contentType },
    }).formData();
    chatIds = form.getAll("chat_id");
    const replies = form.getAll("reply_parameters");
    if (replies.length > 1 || (replies[0] !== undefined && typeof replies[0] !== "string")) {
      throw new Error("invalid reply_parameters");
    }
    replyParameters = replies[0] === undefined ? undefined : JSON.parse(replies[0]);
  } else {
    const payload = requireJson(body, contentType);
    chatIds = [payload.chat_id];
    replyParameters = payload.reply_parameters;
  }
  if (chatIds.length !== 1 || String(chatIds[0]) !== chatId) {
    throw new Error("Bot API request is outside the leased proof chat");
  }
  if (replyParameters !== undefined) {
    if (!replyParameters || typeof replyParameters !== "object" || Array.isArray(replyParameters)) {
      throw new Error("invalid reply_parameters");
    }
    const replyChatId = (replyParameters as JsonObject).chat_id;
    if (replyChatId !== undefined) {
      if (
        (typeof replyChatId !== "string" && typeof replyChatId !== "number") ||
        String(replyChatId) !== chatId
      ) {
        throw new Error("Bot API reply is outside the leased proof chat");
      }
    }
  }
}

function requireStringField(payload: JsonObject, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function requireMessageId(payload: JsonObject): number {
  const value = payload.message_id;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("invalid message_id");
  }
  return value as number;
}

function chatIdFromUpdate(update: JsonObject): unknown {
  const containers: unknown[] = [
    update.message,
    update.edited_message,
    update.message_reaction,
    update.message_reaction_count,
  ];
  const callback = update.callback_query;
  if (callback && typeof callback === "object" && !Array.isArray(callback)) {
    containers.push((callback as JsonObject).message);
  }
  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) {
      continue;
    }
    const chat = (container as JsonObject).chat;
    if (chat && typeof chat === "object" && !Array.isArray(chat)) {
      return (chat as JsonObject).id;
    }
  }
  return undefined;
}

function collectFileIds(value: unknown, fileIds: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFileIds(item, fileIds);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as JsonObject;
  if (typeof record.file_id === "string" && record.file_id.length <= 512) {
    fileIds.add(record.file_id);
  }
  for (const nested of Object.values(record)) {
    collectFileIds(nested, fileIds);
  }
}

function collectUpdateCapabilities(
  update: JsonObject,
  observedMessageIds: Set<number>,
  fileIds: Set<string>,
  callbackQueryIds: Set<string>,
): void {
  for (const value of [update.message, update.edited_message]) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const messageId = (value as JsonObject).message_id;
      if (Number.isSafeInteger(messageId) && (messageId as number) > 0) {
        observedMessageIds.add(messageId as number);
      }
    }
  }
  const reaction = update.message_reaction ?? update.message_reaction_count;
  if (reaction && typeof reaction === "object" && !Array.isArray(reaction)) {
    const messageId = (reaction as JsonObject).message_id;
    if (Number.isSafeInteger(messageId) && (messageId as number) > 0) {
      observedMessageIds.add(messageId as number);
    }
  }
  const callback = update.callback_query;
  if (callback && typeof callback === "object" && !Array.isArray(callback)) {
    const callbackRecord = callback as JsonObject;
    if (typeof callbackRecord.id === "string") {
      callbackQueryIds.add(callbackRecord.id);
    }
    const message = callbackRecord.message;
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const messageId = (message as JsonObject).message_id;
      if (Number.isSafeInteger(messageId) && (messageId as number) > 0) {
        observedMessageIds.add(messageId as number);
      }
    }
  }
  collectFileIds(update, fileIds);
}

function collectSentMessageIds(value: unknown, messageIds: Set<number>): void {
  for (const message of Array.isArray(value) ? value : [value]) {
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const messageId = (message as JsonObject).message_id;
      if (Number.isSafeInteger(messageId) && (messageId as number) > 0) {
        messageIds.add(messageId as number);
      }
    }
  }
}

function writeError(response: ServerResponse, statusCode: number, description: string): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify({ description, error_code: statusCode, ok: false }));
}

function writeSuccess(response: ServerResponse, result: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, result }));
}

async function forwardApiRequest(params: {
  body: Buffer;
  headers: IncomingMessage["headers"];
  path: string;
  transport: typeof http | typeof https;
  upstreamOrigin: URL;
}): Promise<{ body: Buffer; headers: IncomingMessage["headers"]; statusCode: number }> {
  return await new Promise((resolve, reject) => {
    const upstream = params.transport.request(
      {
        headers: {
          ...forwardedHeaders(params.headers),
          "accept-encoding": "identity",
          "content-length": String(params.body.length),
          host: params.upstreamOrigin.host,
        },
        hostname: params.upstreamOrigin.hostname,
        method: "POST",
        path: params.path,
        port: params.upstreamOrigin.port || undefined,
        protocol: params.upstreamOrigin.protocol,
      },
      (upstreamResponse) => {
        readBody(upstreamResponse, MAX_RESPONSE_BYTES).then(
          (body) =>
            resolve({
              body,
              headers: upstreamResponse.headers,
              statusCode: upstreamResponse.statusCode ?? 502,
            }),
          (error: unknown) =>
            reject(error instanceof Error ? error : new Error("Telegram response read failed")),
        );
      },
    );
    upstream.setTimeout(90_000, () => upstream.destroy(new Error("Telegram Bot API timed out")));
    upstream.on("error", reject);
    upstream.end(params.body);
  });
}

export function createTelegramBotApiProxy(params: {
  aliasToken: string;
  chatId: string;
  upstreamOrigin?: URL;
  upstreamToken: string;
}): http.Server {
  const upstreamOrigin = params.upstreamOrigin ?? new URL("https://api.telegram.org");
  const transport = upstreamOrigin.protocol === "https:" ? https : http;
  const alias = escapeRegExp(params.aliasToken);
  const methodPattern = new RegExp(`^/bot${alias}/([A-Za-z][A-Za-z0-9_]{0,63})$`, "u");
  const filePattern = new RegExp(`^/file/bot${alias}/([^?#]+)$`, "u");
  const callbackQueryIds = new Set<string>();
  const fileIds = new Set<string>();
  const filePaths = new Set<string>();
  const observedMessageIds = new Set<number>();
  const sentMessageIds = new Set<number>();
  let nextUpdateOffset: number | undefined;
  let polling = false;
  let nonPollRequestCount = 0;
  let sendCount = 0;

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const requestPath = request.url ?? "";
    const method = methodPattern.exec(requestPath)?.[1];
    let callbackQueryId: string | undefined;
    let ownsPoll = false;
    try {
      if (method !== "getUpdates" && ++nonPollRequestCount > MAX_NON_POLL_REQUESTS) {
        throw new Error("Mantis Telegram request limit reached");
      }
      const filePath = filePattern.exec(requestPath)?.[1];
      if (filePath) {
        if (request.method !== "GET" || !filePaths.has(filePath)) {
          throw new Error("Telegram file is outside this proof attempt");
        }
        const upstream = transport.request(
          {
            headers: { ...forwardedHeaders(request.headers), host: upstreamOrigin.host },
            hostname: upstreamOrigin.hostname,
            method: "GET",
            path: `/file/bot${params.upstreamToken}/${filePath}`,
            port: upstreamOrigin.port || undefined,
            protocol: upstreamOrigin.protocol,
          },
          (upstreamResponse) => {
            response.writeHead(
              upstreamResponse.statusCode ?? 502,
              forwardedHeaders(upstreamResponse.headers),
            );
            upstreamResponse.pipe(response);
          },
        );
        upstream.setTimeout(90_000, () => upstream.destroy(new Error("Telegram file timed out")));
        upstream.on("error", () => response.destroy());
        upstream.end();
        return;
      }
      if (!method || request.method !== "POST") {
        throw new Error("Telegram Bot API operation is not allowed");
      }

      const body = await readBody(
        request,
        MEDIA_SEND_METHODS.has(method) ? MAX_MEDIA_BODY_BYTES : MAX_API_BODY_BYTES,
      );
      const contentType = request.headers["content-type"] ?? "";
      let forwardedBody = body;
      if (method === "getMe") {
        if (Object.keys(requireJson(body, contentType)).length !== 0) {
          throw new Error("getMe payload must be empty");
        }
      } else if (method === "deleteWebhook") {
        const payload = requireJson(body, contentType);
        if (
          Object.keys(payload).some((key) => key !== "drop_pending_updates") ||
          payload.drop_pending_updates === true
        ) {
          throw new Error("deleteWebhook is limited to safe polling startup");
        }
        writeSuccess(response, true);
        return;
      } else if (method === "getUpdates") {
        if (polling) {
          writeError(response, 503, "Only one Telegram poll is allowed");
          return;
        }
        const payload = requireJson(body, contentType);
        const allowedKeys = new Set(["allowed_updates", "limit", "offset", "timeout"]);
        if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
          throw new Error("unsupported getUpdates payload");
        }
        const timeout =
          typeof payload.timeout === "number" && Number.isInteger(payload.timeout)
            ? Math.max(0, Math.min(30, payload.timeout))
            : 30;
        forwardedBody = Buffer.from(
          JSON.stringify({
            allowed_updates: GROUP_UPDATE_TYPES,
            limit: 100,
            ...(nextUpdateOffset === undefined ? {} : { offset: nextUpdateOffset }),
            timeout,
          }),
        );
        polling = true;
        ownsPoll = true;
      } else if (SEND_METHODS.has(method)) {
        if (++sendCount > MAX_SENDS) {
          throw new Error("Mantis Telegram send limit reached");
        }
        await requireChatScope(body, contentType, params.chatId);
      } else if (OWN_MESSAGE_METHODS.has(method)) {
        const payload = requireJson(body, contentType);
        await requireChatScope(body, contentType, params.chatId);
        if (!sentMessageIds.has(requireMessageId(payload))) {
          throw new Error("message is outside this proof attempt");
        }
      } else if (method === "sendChatAction" || method === "setMessageReaction") {
        const payload = requireJson(body, contentType);
        await requireChatScope(body, contentType, params.chatId);
        if (method === "setMessageReaction") {
          const messageId = requireMessageId(payload);
          if (!observedMessageIds.has(messageId) && !sentMessageIds.has(messageId)) {
            throw new Error("message is outside this proof attempt");
          }
        }
      } else if (method === "answerCallbackQuery") {
        callbackQueryId = requireStringField(requireJson(body, contentType), "callback_query_id");
        if (!callbackQueryIds.has(callbackQueryId)) {
          throw new Error("callback query is outside this proof attempt");
        }
      } else if (method === "getFile") {
        const id = requireStringField(requireJson(body, contentType), "file_id");
        if (!fileIds.has(id)) {
          throw new Error("file is outside this proof attempt");
        }
      } else {
        throw new Error("Telegram Bot API operation is not allowed");
      }

      const upstream = await forwardApiRequest({
        body: forwardedBody,
        headers: { ...request.headers, "content-type": contentType },
        path: `/bot${params.upstreamToken}/${method}`,
        transport,
        upstreamOrigin,
      });
      let responseBody = upstream.body;
      if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
        const payload = parseJsonObject(upstream.body);
        const result = payload.result;
        if (payload.ok === true) {
          if (method === "getUpdates" && Array.isArray(result)) {
            const scoped = result.filter(
              (update): update is JsonObject =>
                Boolean(update) &&
                typeof update === "object" &&
                !Array.isArray(update) &&
                String(chatIdFromUpdate(update as JsonObject)) === params.chatId,
            );
            if (scoped.length !== result.length) {
              throw new Error("QA bot has pending updates outside the leased proof chat");
            }
            for (const update of scoped) {
              if (Number.isSafeInteger(update.update_id)) {
                nextUpdateOffset = Math.max(
                  nextUpdateOffset ?? 0,
                  (update.update_id as number) + 1,
                );
              }
              collectUpdateCapabilities(update, observedMessageIds, fileIds, callbackQueryIds);
            }
            responseBody = Buffer.from(JSON.stringify({ ...payload, result: scoped }));
          } else if (SEND_METHODS.has(method)) {
            collectSentMessageIds(result, sentMessageIds);
          } else if (method === "getFile" && result && typeof result === "object") {
            const returnedPath = (result as JsonObject).file_path;
            if (typeof returnedPath === "string" && returnedPath.length <= 512) {
              filePaths.add(returnedPath);
            }
          }
          if (callbackQueryId) {
            callbackQueryIds.delete(callbackQueryId);
          }
        }
      }
      const headers = forwardedHeaders(upstream.headers);
      headers["content-length"] = String(responseBody.length);
      response.writeHead(upstream.statusCode, headers);
      response.end(responseBody);
    } catch (error) {
      if (!response.headersSent) {
        writeError(
          response,
          403,
          error instanceof Error ? error.message : "Telegram Bot API request denied",
        );
      } else {
        response.end();
      }
    } finally {
      if (ownsPoll) {
        polling = false;
      }
    }
  };
  return http.createServer((request, response) => {
    void handleRequest(request, response);
  });
}

function main(): void {
  const server = createTelegramBotApiProxy({
    aliasToken: requiredEnv("TELEGRAM_PROXY_ALIAS_TOKEN"),
    chatId: requiredEnv("TELEGRAM_PROXY_CHAT_ID"),
    upstreamToken: requiredEnv("TELEGRAM_PROXY_UPSTREAM_TOKEN"),
  });
  server.listen(8080, "0.0.0.0", () => console.log("Telegram Bot API proxy listening"));
  const close = () => server.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
