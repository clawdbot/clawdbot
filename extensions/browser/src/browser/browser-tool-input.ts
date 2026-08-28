import {
  browserAct,
  normalizeOptionalString,
  readPositiveIntegerParam,
  readStringParam,
} from "../browser-tool.runtime.js";
import { parseBrowserNavigationUrl } from "./navigation-guard.js";

export function readOptionalTargetAndTimeout(params: Record<string, unknown>) {
  const targetId = normalizeOptionalString(params.targetId);
  const timeoutMs = readPositiveIntegerParam(params, "timeoutMs", {
    message: "timeoutMs must be a positive integer.",
  });
  return { targetId, timeoutMs };
}

export function readTargetUrlParam(params: Record<string, unknown>) {
  const targetUrl =
    readStringParam(params, "targetUrl") ??
    readStringParam(params, "url", { required: true, label: "targetUrl" });
  parseBrowserNavigationUrl(targetUrl);
  return targetUrl;
}

const LEGACY_BROWSER_ACT_REQUEST_KEYS = [
  "kind",
  "actions",
  "stopOnError",
  "targetId",
  "ref",
  "doubleClick",
  "button",
  "modifiers",
  "x",
  "y",
  "text",
  "submit",
  "slowly",
  "key",
  "delayMs",
  "startRef",
  "endRef",
  "values",
  "fields",
  "width",
  "height",
  "timeMs",
  "textGone",
  "selector",
  "url",
  "loadState",
  "fn",
  "timeoutMs",
] as const;

const LEGACY_BROWSER_ACT_SHARED_REQUEST_KEYS = new Set<
  (typeof LEGACY_BROWSER_ACT_REQUEST_KEYS)[number]
>(["targetId"]);

export function readActRequestParam(params: Record<string, unknown>) {
  const requestParam = params.request;
  if (requestParam && typeof requestParam === "object") {
    // SAFETY: the object branch is narrowed above; Browser act params use string keys.
    const request = { ...(requestParam as Record<string, unknown>) };
    const hasMismatchedKind =
      typeof request.kind === "string" &&
      typeof params.kind === "string" &&
      request.kind !== params.kind;
    for (const key of LEGACY_BROWSER_ACT_REQUEST_KEYS) {
      if (Object.hasOwn(request, key) || !Object.hasOwn(params, key)) {
        continue;
      }
      // Flattened act fields are legacy shape repair. Only the tab scope is
      // safe across kind mismatches; action-specific fields can corrupt the
      // explicit nested request.
      if (hasMismatchedKind && !LEGACY_BROWSER_ACT_SHARED_REQUEST_KEYS.has(key)) {
        continue;
      }
      request[key] = params[key];
    }
    // SAFETY: legacy fields are copied from the validated Browser act input shape.
    // SAFETY: the legacy key list narrows this record to the Browser act request shape.
    return request as Parameters<typeof browserAct>[1];
  }

  const kind = readStringParam(params, "kind");
  if (!kind) {
    return undefined;
  }

  const request: Record<string, unknown> = {};
  for (const key of LEGACY_BROWSER_ACT_REQUEST_KEYS) {
    if (!Object.hasOwn(params, key)) {
      continue;
    }
    request[key] = params[key];
  }
  // SAFETY: the legacy key list narrows this record to the Browser act request shape.
  return request as Parameters<typeof browserAct>[1];
}

export function readToolTimeoutMs(params: Record<string, unknown>) {
  return readPositiveIntegerParam(params, "timeoutMs", {
    message: "timeoutMs must be a positive integer.",
  });
}
