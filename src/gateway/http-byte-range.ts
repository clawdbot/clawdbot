import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { matchesHttpIfNoneMatch } from "./http-conditional.js";

const log = createSubsystemLogger("gateway/http-byte-range");

const HTTP_DATE_MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const HTTP_DATE_WEEKDAYS = "Sun Mon Tue Wed Thu Fri Sat".split(" ");
const HTTP_DATE_FULL_WEEKDAYS = "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(
  " ",
);
const HTTP_DATE_PATTERNS = [
  /^(?<weekday>Sun|Mon|Tue|Wed|Thu|Fri|Sat), (?<day>\d{2}) (?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<year>\d{4}) (?<hours>\d{2}):(?<minutes>\d{2}):(?<seconds>\d{2}) GMT$/,
  /^(?<weekday>Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (?<day>\d{2})-(?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(?<year>\d{2}) (?<hours>\d{2}):(?<minutes>\d{2}):(?<seconds>\d{2}) GMT$/,
  /^(?<weekday>Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<day> \d|\d{2}) (?<hours>\d{2}):(?<minutes>\d{2}):(?<seconds>\d{2}) (?<year>\d{4})$/,
] as const;

type FileIdentity = {
  size: number;
  mtimeMs: number;
};

type ByteSlice = {
  start: number;
  end: number;
};

type ByteResponsePlan = {
  etag: string;
  lastModified: string;
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

function parseConditionalHttpDate(value: string, nowMs: number): number | undefined {
  const groups =
    HTTP_DATE_PATTERNS[0].exec(value)?.groups ??
    HTTP_DATE_PATTERNS[1].exec(value)?.groups ??
    HTTP_DATE_PATTERNS[2].exec(value)?.groups;
  if (!groups) {
    return undefined;
  }
  const month = HTTP_DATE_MONTHS.indexOf(groups.month ?? "");
  const weekdayName = groups.weekday ?? "";
  const weekday =
    weekdayName.length === 3
      ? HTTP_DATE_WEEKDAYS.indexOf(weekdayName)
      : HTTP_DATE_FULL_WEEKDAYS.indexOf(weekdayName);
  let year = Number(groups.year);
  const day = Number((groups.day ?? "").trim());
  const hours = Number(groups.hours);
  const minutes = Number(groups.minutes);
  const seconds = Number(groups.seconds);
  if (groups.year?.length === 2) {
    const now = new Date(nowMs);
    if (Number.isNaN(now.getTime())) {
      return undefined;
    }
    year += Math.floor(now.getUTCFullYear() / 100) * 100;
    const fiftyYearsFromNow = Date.UTC(
      now.getUTCFullYear() + 50,
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    );
    // RFC 9110 places two-digit years over 50 years ahead in the previous century.
    const candidate =
      Date.UTC(year, month, day, hours, minutes, Math.min(seconds, 59)) +
      (seconds === 60 ? 1_000 : 0);
    if (candidate > fiftyYearsFromNow) {
      year -= 100;
    }
  }
  if (year < 1900 || hours > 23 || minutes > 59 || seconds > 60) {
    return undefined;
  }
  // JavaScript Date cannot represent :60; validate :59 before advancing the leap second.
  const calendarSecond = Math.min(seconds, 59);
  const timestamp = Date.UTC(year, month, day, hours, minutes, calendarSecond);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hours ||
    parsed.getUTCMinutes() !== minutes ||
    parsed.getUTCSeconds() !== calendarSecond ||
    parsed.getUTCDay() !== weekday
  ) {
    return undefined;
  }
  return seconds === 60 ? timestamp + 1_000 : timestamp;
}

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
  nowMs?: number;
  method?: string;
  request?: Pick<IncomingMessage, "headers" | "headersDistinct">;
}): ByteResponsePlan {
  const etag = createByteEtag(params.file);
  const originatedAtMs = params.nowMs ?? Date.now();
  // Filesystem clocks may lead this host; validators cannot postdate message origination.
  const lastModifiedMs = Math.floor(Math.min(params.file.mtimeMs, originatedAtMs) / 1_000) * 1_000;
  const lastModified = new Date(lastModifiedMs).toUTCString();
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
        typeof ifModifiedSince === "string" &&
        (parseConditionalHttpDate(ifModifiedSince, originatedAtMs) ?? Number.NEGATIVE_INFINITY) >=
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
  res.setHeader("ETag", plan.etag);
  res.setHeader("Last-Modified", plan.lastModified);
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
    // A FileHandle-backed stream is never created for a zero-length/HEAD/already-ended
    // response, so this direct close is the only cleanup that runs; a rejected close
    // otherwise leaks the descriptor with no trace (#116346).
    await handle.close().catch((err: unknown) => {
      log.warn(`gateway byte stream handle close failed: ${String(err)}`);
    });
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
      stream.once("error", (err) => {
        // A FileHandle-backed autoClose stream routes its internal close through the
        // handle, so a close failure after the response already settled surfaces here
        // as a stream error with no live reader left to report it to (#116346).
        const isPostResponseCloseFailure = res.destroyed || res.writableEnded;
        if (isPostResponseCloseFailure) {
          log.warn(`gateway byte stream handle close failed: ${String(err)}`);
        }
        release();
        if (!isPostResponseCloseFailure) {
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
