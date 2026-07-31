import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { matchesHttpIfNoneMatch } from "./http-conditional.js";

type FileIdentity = {
  size: number;
  mtimeMs: number;
};

type ByteSlice = {
  start: number;
  end: number;
};

type ByteResponsePlan =
  | {
      kind: "full";
      statusCode: 200;
      contentLength: number;
      etag: string;
    }
  | {
      kind: "partial";
      statusCode: 206;
      contentLength: number;
      etag: string;
      range: ByteSlice;
      size: number;
    }
  | {
      kind: "unsatisfiable";
      statusCode: 416;
      contentLength: 0;
      etag: string;
      size: number;
    }
  | {
      kind: "not-modified";
      statusCode: 304;
      etag: string;
    };

function createByteEtag(file: FileIdentity): string {
  // Gateway media files are write-once, so size + mtimeMs uniquely version their bytes here.
  // Serving mutable files with a strong validator would instead require a content hash.
  const digest = createHash("sha256").update(`${file.size}:${file.mtimeMs}`).digest("base64url");
  return `"${digest}"`;
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
  file: FileIdentity;
  method?: string;
  rangeHeader?: string | string[];
  ifRangeHeader?: string | string[];
  ifNoneMatchHeader?: string | string[];
}): ByteResponsePlan {
  const etag = createByteEtag(params.file);
  if (
    (params.method === "GET" || params.method === "HEAD") &&
    matchesHttpIfNoneMatch(params.ifNoneMatchHeader, etag)
  ) {
    // RFC 9110 evaluates representation validators before Range or If-Range.
    return { kind: "not-modified", statusCode: 304, etag };
  }
  const full = {
    kind: "full",
    statusCode: 200,
    contentLength: params.file.size,
    etag,
  } as const;
  if (params.method !== "GET" || typeof params.rangeHeader !== "string") {
    return full;
  }
  if (params.ifRangeHeader !== undefined && params.ifRangeHeader !== etag) {
    return full;
  }

  const range = parseByteRange(params.rangeHeader, params.file.size);
  if (range === "invalid") {
    return full;
  }
  if (range === "unsatisfiable") {
    return {
      kind: "unsatisfiable",
      statusCode: 416,
      contentLength: 0,
      etag,
      size: params.file.size,
    };
  }
  return {
    kind: "partial",
    statusCode: 206,
    contentLength: range.end - range.start + 1,
    etag,
    range,
    size: params.file.size,
  };
}

export function writeByteHeaders(res: ServerResponse, plan: ByteResponsePlan): void {
  res.statusCode = plan.statusCode;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("ETag", plan.etag);
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
