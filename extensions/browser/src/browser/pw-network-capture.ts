import { Buffer } from "node:buffer";
import {
  redactCaptureText,
  redactedCaptureHeadersBounded,
} from "openclaw/plugin-sdk/proxy-capture";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { Request, Response } from "playwright-core";
import { redactToolPayloadText } from "../logging/redact.js";
import type { BrowserNetworkRequest } from "./pw-session-contracts.js";

export const MAX_NETWORK_CAPTURE_BYTES = 1_048_576;
const MAX_NETWORK_REQUEST_BODY_CHARS = 64_000;
const MAX_NETWORK_HEADER_BYTES = 65_536;
const MAX_NETWORK_HEADER_ENTRIES = 128;
const MAX_NETWORK_HEADER_NAME_CHARS = 1_024;
const MAX_NETWORK_HEADER_VALUE_CHARS = 65_536;
const MAX_NETWORK_HEADER_INPUT_CHARS = 256_000;
const MAX_NETWORK_REDACTION_INPUT_CHARS = 256_000;
const MAX_NETWORK_URL_CHARS = 64_000;
const MAX_NETWORK_STATUS_TEXT_CHARS = 8_000;
const MAX_NETWORK_FAILURE_TEXT_CHARS = 16_000;
const MAX_NETWORK_METHOD_CHARS = 64;
const OMITTED_CAPTURE_VALUE = "[OMITTED: exceeds capture limit]";

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function captureHeaders(headers: Record<string, string>): {
  headers: Record<string, string>;
  truncated: boolean;
} {
  const captured = redactedCaptureHeadersBounded(headers, {
    maxEntries: MAX_NETWORK_HEADER_ENTRIES,
    maxNameChars: MAX_NETWORK_HEADER_NAME_CHARS,
    maxValueChars: MAX_NETWORK_HEADER_VALUE_CHARS,
    maxTotalValueChars: MAX_NETWORK_HEADER_INPUT_CHARS,
  });
  const bounded: Record<string, string> = {};
  let truncated = captured.truncated;
  for (const [name, value] of Object.entries(captured.headers)) {
    bounded[name] = value;
    if (jsonByteLength(bounded) > MAX_NETWORK_HEADER_BYTES) {
      delete bounded[name];
      truncated = true;
      continue;
    }
  }
  return { headers: bounded, truncated };
}

function captureText(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length > MAX_NETWORK_REDACTION_INPUT_CHARS) {
    return { value: OMITTED_CAPTURE_VALUE, truncated: true };
  }
  const redacted = redactToolPayloadText(redactCaptureText(value));
  return {
    value: redacted.length > maxChars ? truncateUtf16Safe(redacted, maxChars) : redacted,
    truncated: redacted.length > maxChars,
  };
}

export function captureNetworkRequest(req: Request, id: string): BrowserNetworkRequest {
  const requestHeaders = captureHeaders(req.headers());
  const rawRequestBody = req.postData();
  const requestBody =
    rawRequestBody === null
      ? undefined
      : captureText(rawRequestBody, MAX_NETWORK_REQUEST_BODY_CHARS);
  const url = captureText(req.url(), MAX_NETWORK_URL_CHARS);
  const method = captureText(req.method(), MAX_NETWORK_METHOD_CHARS);
  return {
    id,
    timestamp: new Date().toISOString(),
    method: method.value,
    ...(method.truncated ? { methodTruncated: true } : {}),
    url: url.value,
    ...(url.truncated ? { urlTruncated: true } : {}),
    resourceType: req.resourceType(),
    requestHeaders: requestHeaders.headers,
    ...(requestHeaders.truncated ? { requestHeadersTruncated: true } : {}),
    ...(requestBody !== undefined
      ? {
          requestBody: requestBody.value,
          ...(requestBody.truncated ? { requestBodyTruncated: true } : {}),
          ...(requestBody.value === OMITTED_CAPTURE_VALUE ? { requestBodyOmitted: true } : {}),
        }
      : {}),
  };
}

export function captureNetworkResponse(
  request: BrowserNetworkRequest,
  resp: Response,
): BrowserNetworkRequest {
  const responseHeaders = captureHeaders(resp.headers());
  const statusText = captureText(resp.statusText(), MAX_NETWORK_STATUS_TEXT_CHARS);
  return {
    ...request,
    status: resp.status(),
    statusText: statusText.value,
    ...(statusText.truncated ? { statusTextTruncated: true } : {}),
    ok: resp.ok(),
    responseHeaders: responseHeaders.headers,
    ...(responseHeaders.truncated ? { responseHeadersTruncated: true } : {}),
  };
}

export function captureNetworkFailure(
  request: BrowserNetworkRequest,
  failureText: string | undefined,
): BrowserNetworkRequest {
  const capturedFailureText =
    failureText === undefined
      ? undefined
      : captureText(failureText, MAX_NETWORK_FAILURE_TEXT_CHARS);
  return {
    ...request,
    ...(capturedFailureText
      ? {
          failureText: capturedFailureText.value,
          ...(capturedFailureText.truncated ? { failureTextTruncated: true } : {}),
        }
      : {}),
    ok: false,
  };
}

export function retainBoundedNetworkRequests(
  requests: BrowserNetworkRequest[],
  maxRequests: number,
): BrowserNetworkRequest[] {
  const retained = requests.slice(-maxRequests);
  while (
    retained.length > 0 &&
    jsonByteLength({ requests: retained }) > MAX_NETWORK_CAPTURE_BYTES
  ) {
    retained.shift();
  }
  return retained;
}

export function snapshotBoundedNetworkRequests(
  requests: BrowserNetworkRequest[],
): BrowserNetworkRequest[] {
  const detached = requests.map((request) => ({
    ...request,
    ...(request.requestHeaders ? { requestHeaders: { ...request.requestHeaders } } : {}),
    ...(request.responseHeaders ? { responseHeaders: { ...request.responseHeaders } } : {}),
  }));
  return retainBoundedNetworkRequests(detached, detached.length);
}

export function boundNetworkRequestsPayload<
  T extends { requests: BrowserNetworkRequest[]; url?: string },
>(payload: T): T {
  const url = payload.url ? captureText(payload.url, MAX_NETWORK_URL_CHARS).value : undefined;
  const bounded = {
    ...payload,
    ...(url === undefined ? {} : { url }),
    requests: snapshotBoundedNetworkRequests(payload.requests),
  };
  while (bounded.requests.length > 0 && jsonByteLength(bounded) > MAX_NETWORK_CAPTURE_BYTES) {
    bounded.requests.shift();
  }
  return bounded;
}

export function networkCaptureByteLength(requests: BrowserNetworkRequest[]): number {
  return jsonByteLength({ requests });
}
