#!/usr/bin/env -S node --import tsx

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;

const MAX_BODY_BYTES = 110 * 1024 * 1024;
const UPDATE_TYPES = [
  "message",
  "edited_message",
  "callback_query",
  "message_reaction",
  "message_reaction_count",
];
const CHAT_METHODS = new Set([
  "deleteMessage",
  "editMessageCaption",
  "editMessageReplyMarkup",
  "editMessageText",
  "sendAnimation",
  "sendAudio",
  "sendChatAction",
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
  "setMessageReaction",
]);
const CHATLESS_METHODS = new Set(["answerCallbackQuery", "getFile"]);
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

async function readBody(stream: IncomingMessage): Promise<Buffer> {
  const declaredLength = Number(stream.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new Error("request body exceeds the proof limit");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("request body exceeds the proof limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function parseJson(body: Buffer): JsonObject {
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
  return parseJson(body);
}

function requireReplyChatScope(replyParameters: unknown, chatId: string): void {
  if (replyParameters === undefined) {
    return;
  }
  if (!replyParameters || typeof replyParameters !== "object" || Array.isArray(replyParameters)) {
    throw new Error("invalid reply_parameters");
  }
  const replyChatId = (replyParameters as JsonObject).chat_id;
  if (replyChatId !== undefined && String(replyChatId) !== chatId) {
    throw new Error("Bot API reply is outside the leased proof chat");
  }
}

async function requireChatScope(body: Buffer, contentType: string, chatId: string): Promise<void> {
  if (/^multipart\/form-data\s*;/iu.test(contentType)) {
    const bytes =
      body.buffer instanceof ArrayBuffer
        ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
        : Uint8Array.from(body);
    const form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
    const chatIds = form.getAll("chat_id");
    if (chatIds.length !== 1 || String(chatIds[0]) !== chatId) {
      throw new Error("Bot API request is outside the leased proof chat");
    }
    const replies = form.getAll("reply_parameters");
    if (replies.length > 1 || (replies[0] !== undefined && typeof replies[0] !== "string")) {
      throw new Error("invalid reply_parameters");
    }
    requireReplyChatScope(replies[0] === undefined ? undefined : JSON.parse(replies[0]), chatId);
    return;
  }
  const payload = requireJson(body, contentType);
  if (String(payload.chat_id) !== chatId) {
    throw new Error("Bot API request is outside the leased proof chat");
  }
  requireReplyChatScope(payload.reply_parameters, chatId);
}

function updateChatId(update: unknown): unknown {
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return undefined;
  }
  const record = update as JsonObject;
  const callback = record.callback_query;
  const callbackMessage =
    callback && typeof callback === "object" && !Array.isArray(callback)
      ? (callback as JsonObject).message
      : undefined;
  const message =
    record.message ??
    record.edited_message ??
    record.message_reaction ??
    record.message_reaction_count ??
    callbackMessage;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const chat = (message as JsonObject).chat;
  return chat && typeof chat === "object" && !Array.isArray(chat)
    ? (chat as JsonObject).id
    : undefined;
}

function writeError(response: ServerResponse, description: string): void {
  response.writeHead(403, { "content-type": "application/json" });
  response.end(JSON.stringify({ description, error_code: 403, ok: false }));
}

function writeSuccess(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"ok":true,"result":true}');
}

async function forwardApiRequest(params: {
  body: Buffer;
  headers: IncomingMessage["headers"];
  method: string;
  transport: typeof http | typeof https;
  upstreamOrigin: URL;
  upstreamToken: string;
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
        path: `/bot${params.upstreamToken}/${params.method}`,
        port: params.upstreamOrigin.port || undefined,
        protocol: params.upstreamOrigin.protocol,
      },
      async (upstreamResponse) => {
        try {
          resolve({
            body: await readBody(upstreamResponse),
            headers: upstreamResponse.headers,
            statusCode: upstreamResponse.statusCode ?? 502,
          });
        } catch (error) {
          reject(error);
        }
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
  let nextUpdateOffset: number | undefined;
  let polling = false;

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const requestPath = request.url ?? "";
    const filePath = filePattern.exec(requestPath)?.[1];
    if (filePath) {
      if (request.method !== "GET" || filePath.split("/").includes("..")) {
        writeError(response, "Telegram file request is not allowed");
        return;
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
      upstream.on("error", () => response.destroy());
      upstream.end();
      return;
    }

    const method = methodPattern.exec(requestPath)?.[1];
    if (!method || request.method !== "POST") {
      writeError(response, "Telegram Bot API operation is not allowed");
      return;
    }

    let ownsPoll = false;
    try {
      const body = await readBody(request);
      const contentType = request.headers["content-type"] ?? "";
      let forwardedBody = body;
      if (method === "getMe") {
        if (Object.keys(requireJson(body, contentType)).length !== 0) {
          throw new Error("getMe payload must be empty");
        }
      } else if (method === "deleteWebhook") {
        const payload = requireJson(body, contentType);
        if (payload.drop_pending_updates === true) {
          throw new Error("deleteWebhook cannot drop updates");
        }
        writeSuccess(response);
        return;
      } else if (method === "getUpdates") {
        if (polling) {
          throw new Error("Only one Telegram poll is allowed");
        }
        const payload = requireJson(body, contentType);
        const timeout =
          typeof payload.timeout === "number" && Number.isInteger(payload.timeout)
            ? Math.max(0, Math.min(30, payload.timeout))
            : 30;
        forwardedBody = Buffer.from(
          JSON.stringify({
            allowed_updates: UPDATE_TYPES,
            limit: 100,
            ...(nextUpdateOffset === undefined ? {} : { offset: nextUpdateOffset }),
            timeout,
          }),
        );
        polling = true;
        ownsPoll = true;
      } else if (CHAT_METHODS.has(method)) {
        await requireChatScope(body, contentType, params.chatId);
      } else if (!CHATLESS_METHODS.has(method)) {
        throw new Error("Telegram Bot API operation is not allowed");
      }

      const upstream = await forwardApiRequest({
        body: forwardedBody,
        headers: { ...request.headers, "content-type": contentType },
        method,
        transport,
        upstreamOrigin,
        upstreamToken: params.upstreamToken,
      });
      let responseBody = upstream.body;
      if (method === "getUpdates" && upstream.statusCode >= 200 && upstream.statusCode < 300) {
        const payload = parseJson(upstream.body);
        if (payload.ok === true && Array.isArray(payload.result)) {
          if (payload.result.some((update) => String(updateChatId(update)) !== params.chatId)) {
            throw new Error("QA bot has pending updates outside the leased proof chat");
          }
          for (const update of payload.result) {
            if (update && typeof update === "object" && !Array.isArray(update)) {
              const updateId = (update as JsonObject).update_id;
              if (Number.isSafeInteger(updateId)) {
                nextUpdateOffset = Math.max(nextUpdateOffset ?? 0, (updateId as number) + 1);
              }
            }
          }
          responseBody = Buffer.from(JSON.stringify(payload));
        }
      }
      const headers = forwardedHeaders(upstream.headers);
      headers["content-length"] = String(responseBody.length);
      response.writeHead(upstream.statusCode, headers);
      response.end(responseBody);
    } catch (error) {
      writeError(response, error instanceof Error ? error.message : "Telegram request denied");
    } finally {
      if (ownsPoll) {
        polling = false;
      }
    }
  };

  return http.createServer((request, response) => void handle(request, response));
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
