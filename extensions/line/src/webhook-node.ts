import type { IncomingMessage, ServerResponse } from "node:http";
import type { webhook } from "@line/bot-sdk";
import { danger, logVerbose, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-request-guards";
import { parseLineWebhookBody, validateLineSignature } from "./webhook-utils.js";

const LINE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const LINE_WEBHOOK_PREAUTH_MAX_BODY_BYTES = 64 * 1024;
const LINE_WEBHOOK_PREAUTH_BODY_TIMEOUT_MS = 5_000;

export async function readLineWebhookRequestBody(
  req: IncomingMessage,
  maxBytes = LINE_WEBHOOK_MAX_BODY_BYTES,
  timeoutMs = LINE_WEBHOOK_PREAUTH_BODY_TIMEOUT_MS,
): Promise<string> {
  return await readRequestBodyWithLimit(req, {
    maxBytes,
    timeoutMs,
  });
}

type ReadBodyFn = (req: IncomingMessage, maxBytes: number, timeoutMs?: number) => Promise<string>;

export function createLineNodeWebhookHandler(params: {
  channelSecret: string;
  bot: { handleWebhook: (body: webhook.CallbackRequest) => Promise<void> };
  runtime: RuntimeEnv;
  readBody?: ReadBodyFn;
  maxBodyBytes?: number;
  onRequestAuthenticated?: () => void;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBodyBytes = params.maxBodyBytes ?? LINE_WEBHOOK_MAX_BODY_BYTES;
  const readBody = params.readBody ?? readLineWebhookRequestBody;

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" || req.method === "HEAD") {
      if (req.method === "HEAD") {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("OK");
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD, POST");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    try {
      const signatureHeader = req.headers["x-line-signature"];
      const signature =
        typeof signatureHeader === "string"
          ? signatureHeader.trim()
          : Array.isArray(signatureHeader)
            ? (signatureHeader[0] ?? "").trim()
            : "";

      if (!signature) {
        logVerbose("line: webhook missing X-Line-Signature header");
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Missing X-Line-Signature header" }));
        return;
      }

      const rawBody = await readBody(
        req,
        Math.min(maxBodyBytes, LINE_WEBHOOK_PREAUTH_MAX_BODY_BYTES),
        LINE_WEBHOOK_PREAUTH_BODY_TIMEOUT_MS,
      );

      if (!validateLineSignature(rawBody, signature, params.channelSecret)) {
        logVerbose("line: webhook signature validation failed");
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid signature" }));
        return;
      }

      const body = parseLineWebhookBody(rawBody);

      if (!body) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid webhook payload" }));
        return;
      }

      params.onRequestAuthenticated?.();

      if (body.events && body.events.length > 0) {
        logVerbose(`line: received ${body.events.length} webhook events`);
        await params.bot.handleWebhook(body);
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
    } catch (err) {
      if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
        res.statusCode = 413;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
      if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
        res.statusCode = 408;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: requestBodyErrorToText("REQUEST_BODY_TIMEOUT") }));
        return;
      }
      params.runtime.error?.(danger(`line webhook error: ${String(err)}`));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  };
}
