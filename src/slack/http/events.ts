import type { IncomingMessage, ServerResponse } from "node:http";

import type { SubsystemLogger } from "../../logging.js";
import { handleUrlVerification, isUrlVerification } from "./challenge.js";
import { verifySlackSignature } from "./signature.js";

export type SlackHttpEventHandler = (payload: unknown) => void | Promise<void>;

export type SlackHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export type CreateSlackHttpHandlerArgs = {
  signingSecret: string;
  onEvent: SlackHttpEventHandler;
  log?: SubsystemLogger;
};

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      reject(err);
    });
  });
}

function sendText(res: ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

export function createSlackHttpHandler(params: CreateSlackHttpHandlerArgs): SlackHttpHandler {
  const { signingSecret, onEvent, log } = params;

  return async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return;
    }

    let rawBodyBuffer: Buffer;
    try {
      rawBodyBuffer = await readRawBody(req);
    } catch (err) {
      log?.warn("Slack HTTP: failed to read request body", { error: String(err) });
      sendText(res, 400, "Invalid Request");
      return;
    }

    const rawBody = rawBodyBuffer.toString("utf-8");
    const signature = getHeader(req, "x-slack-signature");
    const timestamp = getHeader(req, "x-slack-request-timestamp");

    if (
      !signature ||
      !timestamp ||
      !verifySlackSignature({ signature, timestamp, body: rawBody, signingSecret })
    ) {
      sendText(res, 401, "Unauthorized");
      return;
    }

    let payload: unknown;
    try {
      payload = rawBody ? (JSON.parse(rawBody) as unknown) : {};
    } catch (err) {
      log?.warn("Slack HTTP: invalid JSON payload", { error: String(err) });
      sendText(res, 400, "Invalid JSON");
      return;
    }

    if (isUrlVerification(payload)) {
      sendText(res, 200, handleUrlVerification(payload));
      return;
    }

    // Acknowledge immediately to stay within Slack's timeout window.
    sendText(res, 200, "OK");

    queueMicrotask(() => {
      Promise.resolve(onEvent(payload)).catch((err) => {
        log?.warn("Slack HTTP: event handler failed", { error: String(err) });
      });
    });
  };
}
