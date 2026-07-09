// Qa Lab plugin module implements bus server behavior.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-ingress";
import { normalizeAccountId, resolveQaBusPollStartCursor } from "./bus-queries.js";
import type { QaBusState } from "./bus-state.js";
import type {
  QaBusCreateThreadInput,
  QaBusDeleteMessageInput,
  QaBusEditMessageInput,
  QaBusInboundMessageInput,
  QaBusOutboundMessageInput,
  QaBusPollInput,
  QaBusReactToMessageInput,
  QaBusReadMessageInput,
  QaBusSearchMessagesInput,
  QaBusWaitForInput,
} from "./runtime-api.js";

const QA_HTTP_JSON_MAX_BODY_BYTES = 1024 * 1024;
const QA_HTTP_JSON_BODY_TIMEOUT_MS = 5_000;
const QA_BUS_POLL_TIMEOUT_MAX_MS = 30_000;
const QA_BUS_POLL_LIMIT_MAX = 500;
const QA_BUS_SEARCH_LIMIT_MAX = 100;
const QA_MALFORMED_JSON_BODY_MESSAGE = "Malformed JSON body";

class QaMalformedJsonBodyError extends Error {
  constructor() {
    super(QA_MALFORMED_JSON_BODY_MESSAGE);
    this.name = "QaMalformedJsonBodyError";
  }
}

export function isQaMalformedJsonBodyError(error: unknown): error is Error {
  return error instanceof QaMalformedJsonBodyError;
}

export async function readQaJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = (
    await readRequestBodyWithLimit(req, {
      maxBytes: QA_HTTP_JSON_MAX_BODY_BYTES,
      timeoutMs: QA_HTTP_JSON_BODY_TIMEOUT_MS,
    })
  ).trim();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new QaMalformedJsonBodyError();
  }
}

export function writeJson(res: ServerResponse, statusCode: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function writeError(res: ServerResponse, statusCode: number, error: unknown) {
  writeJson(res, statusCode, {
    error: formatErrorMessage(error),
  });
}

export function writeQaRequestBodyLimitError(res: ServerResponse, error: unknown): boolean {
  if (!isRequestBodyLimitError(error)) {
    return false;
  }
  writeError(res, error.statusCode, requestBodyErrorToText(error.code));
  return true;
}

function readOptionalIntegerField(
  input: Record<string, unknown>,
  field: string,
  opts: {
    label: string;
    max?: number;
    min: number;
  },
): number | undefined {
  const value = input[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || value < opts.min) {
    throw new Error(`${opts.label} must be an integer at least ${opts.min}.`);
  }
  if (opts.max !== undefined && value > opts.max) {
    return opts.max;
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${opts.label} must be an integer at least ${opts.min}.`);
  }
  return opts.max === undefined ? value : Math.min(value, opts.max);
}

function normalizeQaBusPollInput(input: Record<string, unknown>): QaBusPollInput {
  const cursor = readOptionalIntegerField(input, "cursor", {
    label: "poll cursor",
    min: 0,
  });
  const limit = readOptionalIntegerField(input, "limit", {
    label: "poll limit",
    max: QA_BUS_POLL_LIMIT_MAX,
    min: 1,
  });
  const timeoutMs = readOptionalIntegerField(input, "timeoutMs", {
    label: "poll timeoutMs",
    max: QA_BUS_POLL_TIMEOUT_MAX_MS,
    min: 0,
  });
  return {
    ...input,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  } as QaBusPollInput;
}

function normalizeQaBusSearchInput(input: Record<string, unknown>): QaBusSearchMessagesInput {
  const limit = readOptionalIntegerField(input, "limit", {
    label: "search limit",
    max: QA_BUS_SEARCH_LIMIT_MAX,
    min: 1,
  });
  return {
    ...input,
    ...(limit !== undefined ? { limit } : {}),
  } as QaBusSearchMessagesInput;
}

export async function closeQaHttpServer(server: Server): Promise<void> {
  let forceCloseTimer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections?.();
      forceCloseTimer = setTimeout(() => {
        server.closeAllConnections?.();
      }, 250);
      forceCloseTimer.unref();
    });
  } finally {
    if (forceCloseTimer) {
      clearTimeout(forceCloseTimer);
    }
  }
}

export async function handleQaBusRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  state: QaBusState;
}): Promise<boolean> {
  const method = params.req.method ?? "GET";
  const url = new URL(params.req.url ?? "/", "http://127.0.0.1");

  if (method === "GET" && url.pathname === "/health") {
    writeJson(params.res, 200, { ok: true });
    return true;
  }

  if (method === "GET" && url.pathname === "/v1/state") {
    writeJson(params.res, 200, params.state.getSnapshot());
    return true;
  }

  if (!url.pathname.startsWith("/v1/")) {
    return false;
  }

  if (method !== "POST") {
    writeError(params.res, 405, "method not allowed");
    return true;
  }

  try {
    const body = (await readQaJsonBody(params.req)) as Record<string, unknown>;
    switch (url.pathname) {
      case "/v1/reset":
        params.state.reset();
        writeJson(params.res, 200, { ok: true });
        return true;
      case "/v1/inbound/message":
        writeJson(params.res, 200, {
          message: params.state.addInboundMessage(body as unknown as QaBusInboundMessageInput),
        });
        return true;
      case "/v1/outbound/message":
        writeJson(params.res, 200, {
          message: params.state.addOutboundMessage(body as unknown as QaBusOutboundMessageInput),
        });
        return true;
      case "/v1/actions/thread-create":
        writeJson(params.res, 200, {
          thread: params.state.createThread(body as unknown as QaBusCreateThreadInput),
        });
        return true;
      case "/v1/actions/react":
        writeJson(params.res, 200, {
          message: params.state.reactToMessage(body as unknown as QaBusReactToMessageInput),
        });
        return true;
      case "/v1/actions/edit":
        writeJson(params.res, 200, {
          message: params.state.editMessage(body as unknown as QaBusEditMessageInput),
        });
        return true;
      case "/v1/actions/delete":
        writeJson(params.res, 200, {
          message: params.state.deleteMessage(body as unknown as QaBusDeleteMessageInput),
        });
        return true;
      case "/v1/actions/read":
        writeJson(params.res, 200, {
          message: params.state.readMessage(body as unknown as QaBusReadMessageInput),
        });
        return true;
      case "/v1/actions/search":
        writeJson(params.res, 200, {
          messages: params.state.searchMessages(normalizeQaBusSearchInput(body)),
        });
        return true;
      case "/v1/poll": {
        const input = normalizeQaBusPollInput(body);
        const timeoutMs = input.timeoutMs ?? 0;
        const accountId = normalizeAccountId(input.accountId);
        const initial = params.state.poll(input);
        const effectiveStartCursor = resolveQaBusPollStartCursor({
          currentCursor: initial.cursor,
          requestedCursor: input.cursor,
        });
        if (initial.events.length > 0 || timeoutMs === 0) {
          writeJson(params.res, 200, initial);
          return true;
        }
        try {
          await params.state.waitForCursorAdvance(effectiveStartCursor, timeoutMs, (snapshot) => {
            return snapshot.events.some(
              (event) => event.accountId === accountId && event.cursor > effectiveStartCursor,
            );
          });
        } catch {
          // timeout ok for long-poll
        }
        writeJson(params.res, 200, params.state.poll(input));
        return true;
      }
      case "/v1/wait":
        writeJson(params.res, 200, {
          match: await params.state.waitFor(body as unknown as QaBusWaitForInput),
        });
        return true;
      default:
        writeError(params.res, 404, "not found");
        return true;
    }
  } catch (error) {
    if (writeQaRequestBodyLimitError(params.res, error)) {
      return true;
    }
    writeError(params.res, 400, error);
    return true;
  }
}

export function createQaBusServer(state: QaBusState): Server {
  return createServer((req, res) => {
    void (async () => {
      const handled = await handleQaBusRequest({ req, res, state });
      if (!handled) {
        writeError(res, 404, "not found");
      }
    })();
  });
}

export async function startQaBusServer(params: { state: QaBusState; port?: number }) {
  const server = createQaBusServer(params.state);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("qa-bus failed to bind");
  }
  return {
    server,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      await closeQaHttpServer(server);
    },
  };
}
