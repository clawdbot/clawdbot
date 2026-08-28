// Qa Lab plugin module implements bus server behavior.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-ingress";
import { sendHttpRequestRejection } from "openclaw/plugin-sdk/webhook-request-guards";
import { z } from "zod";
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
const QA_HTTP_MEDIA_JSON_MAX_BODY_BYTES = 16 * 1024 * 1024;
const QA_HTTP_JSON_BODY_TIMEOUT_MS = 5_000;
const QA_BUS_POLL_TIMEOUT_MAX_MS = 30_000;
const QA_BUS_POLL_LIMIT_MAX = 500;
const QA_BUS_SEARCH_LIMIT_MAX = 100;
const QA_MALFORMED_JSON_BODY_MESSAGE = "Malformed JSON body";

const qaBusConversationSchema = z
  .object({
    id: z.string(),
    kind: z.preprocess(
      (kind) => (kind === "dm" ? "direct" : kind),
      z.enum(["direct", "channel", "group"]),
    ),
    title: z.string().optional(),
  })
  .passthrough();
const qaBusAttachmentSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["image", "video", "audio", "file"]),
    mimeType: z.string(),
    mediaFactCarrier: z.enum(["path", "media-store-url"]).optional(),
    fileName: z.string().optional(),
    inline: z.boolean().optional(),
    url: z.string().optional(),
    contentBase64: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    durationMs: z.number().optional(),
    altText: z.string().optional(),
    transcript: z.string().optional(),
  })
  .passthrough();
const qaBusToolCallSchema = z
  .object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const qaBusMessageOptionalFields = {
  accountId: z.string().optional(),
  senderName: z.string().optional(),
  timestamp: z.number().optional(),
  threadId: z.string().optional(),
  replyToId: z.string().optional(),
  attachments: z.array(qaBusAttachmentSchema).optional(),
  toolCalls: z.array(qaBusToolCallSchema).optional(),
};

const qaBusRequestBodySchemas = {
  "/v1/inbound/message": z
    .object({
      ...qaBusMessageOptionalFields,
      conversation: qaBusConversationSchema,
      senderId: z.string(),
      text: z.string(),
      threadTitle: z.string().optional(),
      nativeCommand: z.object({ name: z.string() }).passthrough().optional(),
    })
    .passthrough(),
  "/v1/outbound/message": z
    .object({
      ...qaBusMessageOptionalFields,
      to: z.string(),
      senderId: z.string().optional(),
      text: z.string(),
      isError: z.boolean().optional(),
    })
    .passthrough(),
  "/v1/actions/thread-create": z
    .object({
      accountId: z.string().optional(),
      conversationId: z.string(),
      title: z.string(),
      createdBy: z.string().optional(),
      timestamp: z.number().optional(),
    })
    .passthrough(),
  "/v1/actions/react": z
    .object({
      accountId: z.string().optional(),
      messageId: z.string(),
      emoji: z.string(),
      senderId: z.string().optional(),
      timestamp: z.number().optional(),
    })
    .passthrough(),
  "/v1/actions/edit": z
    .object({
      accountId: z.string().optional(),
      messageId: z.string(),
      text: z.string(),
      timestamp: z.number().optional(),
    })
    .passthrough(),
  "/v1/actions/delete": z
    .object({
      accountId: z.string().optional(),
      messageId: z.string(),
      timestamp: z.number().optional(),
    })
    .passthrough(),
  "/v1/actions/read": z
    .object({
      accountId: z.string().optional(),
      messageId: z.string(),
    })
    .passthrough(),
  "/v1/wait": z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("event-kind"),
      eventKind: z.enum([
        "inbound-message",
        "outbound-message",
        "thread-created",
        "message-edited",
        "message-deleted",
        "reaction-added",
      ]),
      timeoutMs: z.number().optional(),
    }),
    z.object({
      kind: z.literal("message-text"),
      textIncludes: z.string(),
      direction: z.enum(["inbound", "outbound"]).optional(),
      timeoutMs: z.number().optional(),
    }),
    z.object({
      kind: z.literal("thread-id"),
      threadId: z.string(),
      timeoutMs: z.number().optional(),
    }),
  ]),
} satisfies {
  "/v1/inbound/message": z.ZodType<QaBusInboundMessageInput>;
  "/v1/outbound/message": z.ZodType<QaBusOutboundMessageInput>;
  "/v1/actions/thread-create": z.ZodType<QaBusCreateThreadInput>;
  "/v1/actions/react": z.ZodType<QaBusReactToMessageInput>;
  "/v1/actions/edit": z.ZodType<QaBusEditMessageInput>;
  "/v1/actions/delete": z.ZodType<QaBusDeleteMessageInput>;
  "/v1/actions/read": z.ZodType<QaBusReadMessageInput>;
  "/v1/wait": z.ZodType<QaBusWaitForInput>;
};

class QaMalformedJsonBodyError extends Error {
  constructor() {
    super(QA_MALFORMED_JSON_BODY_MESSAGE);
    this.name = "QaMalformedJsonBodyError";
  }
}

export function isQaMalformedJsonBodyError(error: unknown): error is Error {
  return error instanceof QaMalformedJsonBodyError;
}

export async function readQaJsonBody(
  req: IncomingMessage,
  options?: { maxBytes?: number },
): Promise<unknown> {
  const text = (
    await readRequestBodyWithLimit(req, {
      maxBytes: options?.maxBytes ?? QA_HTTP_JSON_MAX_BODY_BYTES,
      timeoutMs: QA_HTTP_JSON_BODY_TIMEOUT_MS,
      // Defer destruction so writeQaRequestBodyLimitError can answer before the close.
      destroyOnLimit: false,
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

export function dispatchQaHttpRequest(res: ServerResponse, task: () => Promise<void>): void {
  // Node does not observe promises returned by request listeners. Own rejection here so
  // every admitted request receives an HTTP failure or an explicit connection close.
  void task().catch((error: unknown) => {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : new Error(formatErrorMessage(error)));
      return;
    }
    writeError(res, 500, error);
  });
}

export async function writeQaRequestBodyLimitError(
  req: IncomingMessage,
  res: ServerResponse,
  error: unknown,
): Promise<boolean> {
  if (!isRequestBodyLimitError(error)) {
    return false;
  }
  await sendHttpRequestRejection(
    req,
    res,
    error.statusCode,
    JSON.stringify({ error: requestBodyErrorToText(error.code) }),
    "application/json; charset=utf-8",
  );
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
  const acknowledgedCursor = readOptionalIntegerField(input, "acknowledgedCursor", {
    label: "acknowledged poll cursor",
    min: 0,
  });
  if (acknowledgedCursor !== undefined && acknowledgedCursor > (cursor ?? 0)) {
    throw new Error("acknowledged poll cursor must not exceed the requested poll cursor.");
  }
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
    ...(acknowledgedCursor !== undefined ? { acknowledgedCursor } : {}),
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

export async function closeQaHttpServer(server: Server, state?: QaBusState): Promise<void> {
  let forceCloseTimer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      state?.reset(true); // Fence first so late request bodies cannot add waiter timers.
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
    const body = (await readQaJsonBody(
      params.req,
      url.pathname === "/v1/inbound/message" || url.pathname === "/v1/outbound/message"
        ? { maxBytes: QA_HTTP_MEDIA_JSON_MAX_BODY_BYTES }
        : undefined,
    )) as Record<string, unknown>;
    switch (url.pathname) {
      case "/v1/reset":
        params.state.reset();
        writeJson(params.res, 200, { ok: true });
        return true;
      case "/v1/inbound/message":
        writeJson(params.res, 200, {
          message: params.state.addInboundMessage(
            qaBusRequestBodySchemas["/v1/inbound/message"].parse(body),
          ),
        });
        return true;
      case "/v1/outbound/message":
        writeJson(params.res, 200, {
          message: params.state.addOutboundMessage(
            qaBusRequestBodySchemas["/v1/outbound/message"].parse(body),
          ),
        });
        return true;
      case "/v1/actions/thread-create":
        writeJson(params.res, 200, {
          thread: params.state.createThread(
            qaBusRequestBodySchemas["/v1/actions/thread-create"].parse(body),
          ),
        });
        return true;
      case "/v1/actions/react":
        writeJson(params.res, 200, {
          message: params.state.reactToMessage(
            qaBusRequestBodySchemas["/v1/actions/react"].parse(body),
          ),
        });
        return true;
      case "/v1/actions/edit":
        writeJson(params.res, 200, {
          message: params.state.editMessage(
            qaBusRequestBodySchemas["/v1/actions/edit"].parse(body),
          ),
        });
        return true;
      case "/v1/actions/delete":
        writeJson(params.res, 200, {
          message: params.state.deleteMessage(
            qaBusRequestBodySchemas["/v1/actions/delete"].parse(body),
          ),
        });
        return true;
      case "/v1/actions/read":
        writeJson(params.res, 200, {
          message: params.state.readMessage(
            qaBusRequestBodySchemas["/v1/actions/read"].parse(body),
          ),
        });
        return true;
      case "/v1/actions/search":
        writeJson(params.res, 200, {
          messages: params.state.searchMessages(normalizeQaBusSearchInput(body)),
        });
        return true;
      case "/v1/poll": {
        const input = normalizeQaBusPollInput(body);
        const pollInput = {
          ...input,
          cursor: params.state.resolvePollCursor(input),
        };
        const timeoutMs = input.timeoutMs ?? 0;
        const accountId = normalizeAccountId(input.accountId);
        const initial = params.state.poll(pollInput);
        const effectiveStartCursor = resolveQaBusPollStartCursor({
          currentCursor: initial.cursor,
          requestedCursor: pollInput.cursor,
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
        writeJson(params.res, 200, params.state.poll(pollInput));
        return true;
      }
      case "/v1/wait":
        writeJson(params.res, 200, {
          match: await params.state.waitFor(qaBusRequestBodySchemas["/v1/wait"].parse(body)),
        });
        return true;
      default:
        writeError(params.res, 404, "not found");
        return true;
    }
  } catch (error) {
    if (await writeQaRequestBodyLimitError(params.req, params.res, error)) {
      return true;
    }
    writeError(params.res, 400, error);
    return true;
  }
}

export function createQaBusServer(state: QaBusState): Server {
  return createServer((req, res) => {
    dispatchQaHttpRequest(res, async () => {
      const handled = await handleQaBusRequest({ req, res, state });
      if (!handled) {
        writeError(res, 404, "not found");
      }
    });
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
      await closeQaHttpServer(server, params.state);
    },
  };
}
