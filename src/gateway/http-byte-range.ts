import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseRetryAfterHttpDateMs } from "@openclaw/ai/internal/retry-after";
import { matchesHttpIfNoneMatch } from "./http-conditional.js";

type FileIdentity = {
  size: number;
  mtimeMs: number;
};

type ByteSlice = {
  start: number;
  end: number;
};

type ByteResponsePlan = {
  etag?: string;
  lastModified?: string;
} & (
  | {
      kind: "full";
      statusCode: 200;
      contentLength: number;
    }
  | {
      kind: "partial";
      statusCode: 206;
      contentLength: number;
      range: ByteSlice;
      size: number;
    }
  | {
      kind: "unsatisfiable";
      statusCode: 416;
      contentLength: 0;
      size: number;
    }
  | {
      kind: "not-modified";
      statusCode: 304;
    }
);

export function createImmutableFileValidators(file: FileIdentity): {
  etag: string;
  mtimeMs: number;
} {
  // Only owners of write-once representations can use stat metadata as a strong validator.
  const digest = createHash("sha256").update(`${file.size}:${file.mtimeMs}`).digest("base64url");
  return { etag: `"${digest}"`, mtimeMs: file.mtimeMs };
}

function parseByteRange(value: string, size: number): ByteSlice | "invalid" | "unsatisfiable" {
  const normalized = value.trim();
  if (normalized.includes(",")) {
    // Multipart ranges are deliberately unsupported; serve the full representation instead.
    return "invalid";
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(normalized);
  if (!match || (!match[1] && !match[2])) {
    return "invalid";
  }
  const [, rangeStart = "", rangeEnd = ""] = match;

  const fileSize = BigInt(size);
  if (!rangeStart) {
    const suffixLength = BigInt(rangeEnd);
    if (suffixLength === 0n || fileSize === 0n) {
      return "unsatisfiable";
    }
    const start = suffixLength >= fileSize ? 0n : fileSize - suffixLength;
    return { start: Number(start), end: size - 1 };
  }

  const start = BigInt(rangeStart);
  if (start >= fileSize) {
    return "unsatisfiable";
  }
  const requestedEnd = rangeEnd ? BigInt(rangeEnd) : fileSize - 1n;
  if (requestedEnd < start) {
    return "unsatisfiable";
  }
  const end = requestedEnd >= fileSize ? fileSize - 1n : requestedEnd;
  return { start: Number(start), end: Number(end) };
}

export function resolveByteResponse(params: {
  file: Pick<FileIdentity, "size">;
  validators?: ReturnType<typeof createImmutableFileValidators>;
  nowMs?: number;
  method?: string;
  request?: Pick<IncomingMessage, "headers" | "headersDistinct">;
}): ByteResponsePlan {
  const etag = params.validators?.etag;
  const originatedAtMs = params.nowMs ?? Date.now();
  // Filesystem clocks may lead this host; validators cannot postdate message origination.
  const lastModifiedMs = params.validators
    ? Math.floor(Math.min(params.validators.mtimeMs, originatedAtMs) / 1_000) * 1_000
    : undefined;
  const lastModified =
    lastModifiedMs === undefined ? undefined : new Date(lastModifiedMs).toUTCString();
  const headers = params.request?.headers;
  const ifNoneMatch = headers?.["if-none-match"];
  const ifModifiedSinceValues = params.request?.headersDistinct["if-modified-since"];
  // Node drops duplicate singleton fields from headers; only the distinct list is authoritative.
  const ifModifiedSince =
    ifModifiedSinceValues?.length === 1 ? ifModifiedSinceValues[0] : undefined;
  // Any If-None-Match field supersedes If-Modified-Since, even when no ETag matches.
  if (
    (params.method === "GET" || params.method === "HEAD") &&
    (matchesHttpIfNoneMatch(ifNoneMatch, etag) ||
      (ifNoneMatch === undefined &&
        lastModifiedMs !== undefined &&
        typeof ifModifiedSince === "string" &&
        (parseRetryAfterHttpDateMs(ifModifiedSince, originatedAtMs) ?? Number.NEGATIVE_INFINITY) >=
          lastModifiedMs))
  ) {
    // RFC 9110 evaluates representation validators before Range or If-Range.
    return { kind: "not-modified", statusCode: 304, etag, lastModified };
  }
  const full = {
    kind: "full",
    statusCode: 200,
    contentLength: params.file.size,
    etag,
    lastModified,
  } as const;
  const rangeHeader = headers?.range;
  if (params.method !== "GET" || typeof rangeHeader !== "string") {
    return full;
  }
  const ifRangeHeader = headers?.["if-range"];
  if (
    ifRangeHeader !== undefined &&
    ifRangeHeader !== etag &&
    // If-Range must exactly match the emitted HTTP-date; parsing accepts invalid lookalikes.
    ifRangeHeader !== lastModified
  ) {
    return full;
  }

  const range = parseByteRange(rangeHeader, params.file.size);
  if (range === "invalid") {
    return full;
  }
  if (range === "unsatisfiable") {
    return {
      kind: "unsatisfiable",
      statusCode: 416,
      contentLength: 0,
      etag,
      lastModified,
      size: params.file.size,
    };
  }
  return {
    kind: "partial",
    statusCode: 206,
    contentLength: range.end - range.start + 1,
    etag,
    lastModified,
    range,
    size: params.file.size,
  };
}

export function writeByteHeaders(res: ServerResponse, plan: ByteResponsePlan): void {
  res.statusCode = plan.statusCode;
  res.setHeader("Accept-Ranges", "bytes");
  if (plan.etag !== undefined) {
    res.setHeader("ETag", plan.etag);
  }
  if (plan.lastModified !== undefined) {
    res.setHeader("Last-Modified", plan.lastModified);
  }
  if (plan.kind === "not-modified") {
    return;
  }
  res.setHeader("Content-Length", String(plan.contentLength));
  if (plan.kind === "partial") {
    res.setHeader("Content-Range", `bytes ${plan.range.start}-${plan.range.end}/${plan.size}`);
  } else if (plan.kind === "unsatisfiable") {
    res.setHeader("Content-Range", `bytes */${plan.size}`);
  }
}

export function createGatewayByteStream(
  res: ServerResponse,
  handle: Pick<FileHandle, "close" | "createReadStream">,
  onReadError: () => void,
) {
  let stream: ReturnType<FileHandle["createReadStream"]> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    if (stream) {
      stream.destroy();
      return;
    }
    await handle.close().catch(() => {});
  };
  const release = () => {
    void close();
  };
  // The ReadStream owns the FileHandle after creation; destroying it closes the descriptor once.
  res.once("close", release);

  return {
    close,
    async pipe(plan: ByteResponsePlan, method: string | undefined) {
      if (method === "HEAD" || !("contentLength" in plan) || plan.contentLength === 0) {
        await close();
        res.end();
        return;
      }
      if (closed || res.destroyed || res.writableEnded) {
        await close();
        return;
      }
      stream = handle.createReadStream({
        start: plan.kind === "partial" ? plan.range.start : 0,
        end: plan.kind === "partial" ? plan.range.end : plan.contentLength - 1,
        autoClose: true,
      });
      stream.once("end", release).once("close", release);
      stream.once("error", () => {
        release();
        if (!res.destroyed && !res.writableEnded) {
          if (res.headersSent) {
            res.destroy();
          } else {
            onReadError();
          }
        }
      });
      stream.pipe(res);
    },
  };
}
