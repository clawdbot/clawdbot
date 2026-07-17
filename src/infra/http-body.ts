// Reads HTTP request and response bodies with timeout and byte limits.
import type { IncomingMessage, ServerResponse } from "node:http";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import { decodeTextPrefix } from "@openclaw/normalization-core";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "./errors.js";
import { readChunkWithIdleTimeout, withResponseBodyTimeout } from "./http-response-body-timeout.js";
import { parseStrictNonNegativeInteger } from "./parse-finite-number.js";

export { readChunkWithIdleTimeout } from "./http-response-body-timeout.js";

export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

export type RequestBodyLimitErrorCode =
  | "PAYLOAD_TOO_LARGE"
  | "REQUEST_BODY_TIMEOUT"
  | "CONNECTION_CLOSED";

type RequestBodyLimitErrorInit = {
  code: RequestBodyLimitErrorCode;
  message?: string;
};

const DEFAULT_ERROR_MESSAGE: Record<RequestBodyLimitErrorCode, string> = {
  PAYLOAD_TOO_LARGE: "PayloadTooLarge",
  REQUEST_BODY_TIMEOUT: "RequestBodyTimeout",
  CONNECTION_CLOSED: "RequestBodyConnectionClosed",
};

const DEFAULT_ERROR_STATUS_CODE: Record<RequestBodyLimitErrorCode, number> = {
  PAYLOAD_TOO_LARGE: 413,
  REQUEST_BODY_TIMEOUT: 408,
  CONNECTION_CLOSED: 400,
};

const DEFAULT_RESPONSE_MESSAGE: Record<RequestBodyLimitErrorCode, string> = {
  PAYLOAD_TOO_LARGE: "Payload too large",
  REQUEST_BODY_TIMEOUT: "Request body timeout",
  CONNECTION_CLOSED: "Connection closed",
};

export class RequestBodyLimitError extends Error {
  readonly code: RequestBodyLimitErrorCode;
  readonly statusCode: number;

  constructor(init: RequestBodyLimitErrorInit) {
    super(init.message ?? DEFAULT_ERROR_MESSAGE[init.code]);
    this.name = "RequestBodyLimitError";
    this.code = init.code;
    this.statusCode = DEFAULT_ERROR_STATUS_CODE[init.code];
  }
}

export function isRequestBodyLimitError(
  error: unknown,
  code?: RequestBodyLimitErrorCode,
): error is RequestBodyLimitError {
  if (!(error instanceof RequestBodyLimitError)) {
    return false;
  }
  if (!code) {
    return true;
  }
  return error.code === code;
}

export function requestBodyErrorToText(code: RequestBodyLimitErrorCode): string {
  return DEFAULT_RESPONSE_MESSAGE[code];
}

function parseContentLengthHeader(req: IncomingMessage): number | null {
  const header = req.headers["content-length"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = parseStrictNonNegativeInteger(raw);
  if (parsed === undefined) {
    return null;
  }
  return parsed;
}

export type ReadRequestBodyOptions = {
  maxBytes: number;
  timeoutMs?: number;
  encoding?: BufferEncoding;
};

type RequestBodyLimitValues = {
  maxBytes: number;
  timeoutMs: number;
};

type RequestBodyChunkProgress = {
  buffer: Buffer;
  totalBytes: number;
  exceeded: boolean;
};

function resolveRequestBodyLimitValues(options: {
  maxBytes: number;
  timeoutMs?: number;
}): RequestBodyLimitValues {
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(1, Math.floor(options.maxBytes))
    : 1;
  const timeoutMs =
    options.timeoutMs === undefined
      ? DEFAULT_WEBHOOK_BODY_TIMEOUT_MS
      : resolveTimerTimeoutMs(options.timeoutMs, DEFAULT_WEBHOOK_BODY_TIMEOUT_MS);
  return { maxBytes, timeoutMs };
}

export const testApi = { resolveRequestBodyLimitValues };
export { testApi as __test__ };

function advanceRequestBodyChunk(
  chunk: Buffer | string,
  totalBytes: number,
  maxBytes: number,
): RequestBodyChunkProgress {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const nextTotalBytes = totalBytes + buffer.length;
  return {
    buffer,
    totalBytes: nextTotalBytes,
    exceeded: nextTotalBytes > maxBytes,
  };
}

type ReadResponsePrefixResult = {
  buffer: Buffer;
  size: number;
  truncated: boolean;
};

export type ReadResponseTextPrefixOptions = {
  chunkTimeoutMs?: number;
  onIdleTimeout?: (params: { chunkTimeoutMs: number }) => Error;
  timeoutMs?: number;
  onTimeout?: (params: { timeoutMs: number }) => Error;
};

type ReadResponsePrefixOptions = ReadResponseTextPrefixOptions & {
  stopAtLimit?: boolean;
};

function validateMaxBytes(maxBytes: number): void {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative finite number: ${maxBytes}`);
  }
}

async function readResponsePrefixFromReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  options?: ReadResponsePrefixOptions,
): Promise<ReadResponsePrefixResult> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = options?.chunkTimeoutMs
        ? await readChunkWithIdleTimeout(reader, options.chunkTimeoutMs, options.onIdleTimeout)
        : await reader.read();
      if (done) {
        size = total;
        break;
      }
      if (!value?.length) {
        continue;
      }
      const nextTotal = total + value.length;
      if (nextTotal > maxBytes || (options?.stopAtLimit && nextTotal === maxBytes)) {
        const remaining = maxBytes - total;
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        size = nextTotal;
        truncated = true;
        try {
          await reader.cancel();
        } catch {}
        break;
      }
      chunks.push(value);
      total = nextTotal;
      size = total;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  return {
    buffer: Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total,
    ),
    size,
    truncated,
  };
}

async function readResponsePrefix(
  response: Response,
  maxBytes: number,
  options?: ReadResponsePrefixOptions,
): Promise<ReadResponsePrefixResult> {
  validateMaxBytes(maxBytes);
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    return await withResponseBodyTimeout({
      timeoutMs: options?.timeoutMs,
      onTimeout: options?.onTimeout,
      cancel: async (error) => await body?.cancel(error),
      read: async () => {
        const fallback = Buffer.from(await response.arrayBuffer());
        if (fallback.length > maxBytes) {
          return {
            buffer: fallback.subarray(0, maxBytes),
            size: fallback.length,
            truncated: true,
          };
        }
        return { buffer: fallback, size: fallback.length, truncated: false };
      },
    });
  }

  const reader = body.getReader();
  return await withResponseBodyTimeout({
    timeoutMs: options?.timeoutMs,
    onTimeout: options?.onTimeout,
    cancel: async (error) => await reader.cancel(error),
    read: async () => await readResponsePrefixFromReader(reader, maxBytes, options),
  });
}

export type ReadResponseTextPrefixResult = {
  text: string;
  size: number;
  truncated: boolean;
};

/** Reads and decodes a bounded text prefix while cancelling unread overflow. */
export async function readResponseTextPrefix(
  response: Response,
  maxBytes: number,
  options?: ReadResponseTextPrefixOptions,
): Promise<ReadResponseTextPrefixResult> {
  const prefix = await readResponsePrefix(response, maxBytes, {
    ...options,
    stopAtLimit: true,
  });
  return {
    text: decodeTextPrefix(prefix.buffer, { truncated: prefix.truncated }),
    size: prefix.size,
    truncated: prefix.truncated,
  };
}

/** Reads a response body under byte, idle, and overall timeout bounds. */
export async function readResponseWithLimit(
  response: Response,
  maxBytes: number,
  options?: ReadResponseTextPrefixOptions & {
    onOverflow?: (params: { size: number; maxBytes: number; res: Response }) => Error;
  },
): Promise<Buffer> {
  const onOverflow =
    options?.onOverflow ??
    ((params: { size: number; maxBytes: number }) =>
      new Error(`Content too large: ${params.size} bytes (limit: ${params.maxBytes} bytes)`));
  const prefix = await readResponsePrefix(response, maxBytes, {
    chunkTimeoutMs: options?.chunkTimeoutMs,
    onIdleTimeout: options?.onIdleTimeout,
    timeoutMs: options?.timeoutMs,
    onTimeout: options?.onTimeout,
  });
  if (prefix.truncated) {
    throw onOverflow({ size: prefix.size, maxBytes, res: response });
  }
  return prefix.buffer;
}

/** Reads a small collapsed text prefix from a response body for diagnostics/errors. */
export async function readResponseTextSnippet(
  response: Response,
  options?: ReadResponseTextPrefixOptions & {
    maxBytes?: number;
    maxChars?: number;
  },
): Promise<string | undefined> {
  const maxBytes = options?.maxBytes ?? 8 * 1024;
  const maxChars = options?.maxChars ?? 200;
  const prefix = await readResponseTextPrefix(response, maxBytes, {
    chunkTimeoutMs: options?.chunkTimeoutMs,
    onIdleTimeout: options?.onIdleTimeout,
    timeoutMs: options?.timeoutMs,
    onTimeout: options?.onTimeout,
  });
  if (!prefix.text) {
    return undefined;
  }

  const collapsed = prefix.text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  if (collapsed.length > maxChars) {
    return `${truncateUtf16Safe(collapsed, maxChars)}…`;
  }
  return prefix.truncated ? `${collapsed}…` : collapsed;
}

export async function readRequestBodyWithLimit(
  req: IncomingMessage,
  options: ReadRequestBodyOptions,
): Promise<string> {
  const { maxBytes, timeoutMs } = resolveRequestBodyLimitValues(options);
  const encoding = options.encoding ?? "utf-8";

  const declaredLength = parseContentLengthHeader(req);
  if (declaredLength !== null && declaredLength > maxBytes) {
    const error = new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" });
    if (!req.destroyed) {
      // Limit violations are expected user input; destroying with an Error causes
      // an async 'error' event which can crash the process if no listener remains.
      req.destroy();
    }
    throw error;
  }

  return await new Promise((resolve, reject) => {
    let done = false;
    let ended = false;
    let totalBytes = 0;
    const chunks: Buffer[] = [];

    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("close", onClose);
      clearNodeTimeout(timer);
    };

    const finish = (cb: () => void) => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      cb();
    };

    const fail = (error: RequestBodyLimitError | Error) => {
      finish(() => reject(error));
    };

    const timer = setNodeTimeout(() => {
      const error = new RequestBodyLimitError({ code: "REQUEST_BODY_TIMEOUT" });
      if (!req.destroyed) {
        req.destroy();
      }
      fail(error);
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      if (done) {
        return;
      }
      const progress = advanceRequestBodyChunk(chunk, totalBytes, maxBytes);
      totalBytes = progress.totalBytes;
      if (progress.exceeded) {
        const error = new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" });
        if (!req.destroyed) {
          req.destroy();
        }
        fail(error);
        return;
      }
      chunks.push(progress.buffer);
    };

    const onEnd = () => {
      ended = true;
      finish(() => resolve(Buffer.concat(chunks).toString(encoding)));
    };

    const onError = (error: Error) => {
      if (done) {
        return;
      }
      fail(error);
    };

    const onClose = () => {
      if (done || ended) {
        return;
      }
      fail(new RequestBodyLimitError({ code: "CONNECTION_CLOSED" }));
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

export type ReadJsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; code: RequestBodyLimitErrorCode | "INVALID_JSON" };

export type ReadJsonBodyOptions = ReadRequestBodyOptions & {
  emptyObjectOnEmpty?: boolean;
};

export async function readJsonBodyWithLimit(
  req: IncomingMessage,
  options: ReadJsonBodyOptions,
): Promise<ReadJsonBodyResult> {
  try {
    const raw = await readRequestBodyWithLimit(req, options);
    const trimmed = raw.trim();
    if (!trimmed) {
      if (options.emptyObjectOnEmpty === false) {
        return { ok: false, code: "INVALID_JSON", error: "empty payload" };
      }
      return { ok: true, value: {} };
    }
    try {
      return { ok: true, value: JSON.parse(trimmed) as unknown };
    } catch (error) {
      return {
        ok: false,
        code: "INVALID_JSON",
        error: formatErrorMessage(error),
      };
    }
  } catch (error) {
    if (isRequestBodyLimitError(error)) {
      return { ok: false, code: error.code, error: requestBodyErrorToText(error.code) };
    }
    return {
      ok: false,
      code: "INVALID_JSON",
      error: formatErrorMessage(error),
    };
  }
}

export type RequestBodyLimitGuard = {
  dispose: () => void;
  isTripped: () => boolean;
  code: () => RequestBodyLimitErrorCode | null;
};

export type RequestBodyLimitGuardOptions = {
  maxBytes: number;
  timeoutMs?: number;
  responseFormat?: "json" | "text";
  responseText?: Partial<Record<RequestBodyLimitErrorCode, string>>;
};

export function installRequestBodyLimitGuard(
  req: IncomingMessage,
  res: ServerResponse,
  options: RequestBodyLimitGuardOptions,
): RequestBodyLimitGuard {
  const { maxBytes, timeoutMs } = resolveRequestBodyLimitValues(options);
  const responseFormat = options.responseFormat ?? "json";
  const customText = options.responseText ?? {};

  let tripped = false;
  let reason: RequestBodyLimitErrorCode | null = null;
  let done = false;
  let ended = false;
  let totalBytes = 0;

  const cleanup = () => {
    req.removeListener("data", onData);
    req.removeListener("end", onEnd);
    req.removeListener("close", onClose);
    req.removeListener("error", onError);
    clearNodeTimeout(timer);
  };

  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    cleanup();
  };

  const respond = (error: RequestBodyLimitError) => {
    const text = customText[error.code] ?? requestBodyErrorToText(error.code);
    if (!res.headersSent) {
      res.statusCode = error.statusCode;
      if (responseFormat === "text") {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(text);
      } else {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: text }));
      }
    }
  };

  const trip = (error: RequestBodyLimitError) => {
    if (tripped) {
      return;
    }
    tripped = true;
    reason = error.code;
    finish();
    respond(error);
    if (!req.destroyed) {
      // Limit violations are expected user input; destroying with an Error causes
      // an async 'error' event which can crash the process if no listener remains.
      req.destroy();
    }
  };

  const onData = (chunk: Buffer | string) => {
    if (done) {
      return;
    }
    const progress = advanceRequestBodyChunk(chunk, totalBytes, maxBytes);
    totalBytes = progress.totalBytes;
    if (progress.exceeded) {
      trip(new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" }));
    }
  };

  const onEnd = () => {
    ended = true;
    finish();
  };

  const onClose = () => {
    if (done || ended) {
      return;
    }
    finish();
  };

  const onError = () => {
    finish();
  };

  const timer = setNodeTimeout(() => {
    trip(new RequestBodyLimitError({ code: "REQUEST_BODY_TIMEOUT" }));
  }, timeoutMs);

  req.on("data", onData);
  req.on("end", onEnd);
  req.on("close", onClose);
  req.on("error", onError);

  const declaredLength = parseContentLengthHeader(req);
  if (declaredLength !== null && declaredLength > maxBytes) {
    trip(new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" }));
  }

  return {
    dispose: finish,
    isTripped: () => tripped,
    code: () => reason,
  };
}
