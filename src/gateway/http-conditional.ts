// HTTP validators share strict date admission and weak entity-tag comparison.
import type { IncomingMessage } from "node:http";
import { parseHttpDateInstant } from "@openclaw/ai/internal/retry-after";
import { splitHttpHeaderValue } from "./http-header-value.js";

export function matchesHttpIfModifiedSince(
  request: Pick<IncomingMessage, "headersDistinct"> | undefined,
  lastModifiedMs: number,
  nowMs = Date.now(),
): boolean {
  // Node drops duplicate singleton fields from headers; the distinct list owns admission.
  const values = request?.headersDistinct["if-modified-since"];
  const value = values?.length === 1 ? values[0] : undefined;
  const since = typeof value === "string" ? parseHttpDateInstant(value, nowMs) : undefined;
  const modifiedSecondMs = Math.floor(lastModifiedMs / 1_000) * 1_000;
  return (
    since !== undefined &&
    (since.leapSecond
      ? modifiedSecondMs < since.timestampMs
      : modifiedSecondMs <= since.timestampMs)
  );
}

export function matchesHttpIfNoneMatch(
  header: string | string[] | undefined,
  etag: string | undefined,
): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) {
    return false;
  }
  const expected = etag?.replace(/^W\//u, "");
  return (
    value.trim() === "*" ||
    (splitHttpHeaderValue(value, ",", "opaque-tag")?.some(
      (candidate) => candidate.trim().replace(/^W\//u, "") === expected,
    ) ??
      false)
  );
}
