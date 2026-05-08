import { isLoopbackHost } from "openclaw/plugin-sdk/gateway-runtime";

export const QA_CREDENTIALS_DEFAULT_ENDPOINT_PREFIX = "/qa-credentials/v1";
const QA_CREDENTIALS_ALLOW_INSECURE_HTTP_ENV_KEY = "OPENCLAW_QA_ALLOW_INSECURE_HTTP";

type ErrorFactory = (message: string) => Error;

function makeError(message: string) {
  return new Error(message);
}

export function parseQaCredentialPositiveIntegerEnv(params: {
  env: NodeJS.ProcessEnv;
  fallback: number;
  key: string;
  toError?: ErrorFactory;
}): number {
  const raw = params.env[params.key]?.trim();
  if (!raw) {
    return params.fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw (params.toError ?? makeError)(`${params.key} must be a positive integer.`);
  }
  return value;
}

export function isQaCredentialTruthyOptIn(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function normalizeQaCredentialConvexSiteUrl(params: {
  env: NodeJS.ProcessEnv;
  raw: string;
  toError?: ErrorFactory;
}): string {
  const toError = params.toError ?? makeError;
  let url: URL;
  try {
    url = new URL(params.raw);
  } catch {
    throw toError(
      `OPENCLAW_QA_CONVEX_SITE_URL must be a valid URL, got "${params.raw || "<empty>"}".`,
    );
  }
  if (url.protocol === "https:") {
    const text = url.toString();
    return text.endsWith("/") ? text.slice(0, -1) : text;
  }
  if (url.protocol !== "http:") {
    throw toError("OPENCLAW_QA_CONVEX_SITE_URL must use https://.");
  }
  const allowInsecureHttp = isQaCredentialTruthyOptIn(
    params.env[QA_CREDENTIALS_ALLOW_INSECURE_HTTP_ENV_KEY],
  );
  if (!allowInsecureHttp || !isLoopbackHost(url.hostname)) {
    throw toError(
      `OPENCLAW_QA_CONVEX_SITE_URL must use https://. http:// is only allowed for loopback hosts when ${QA_CREDENTIALS_ALLOW_INSECURE_HTTP_ENV_KEY}=1.`,
    );
  }
  const text = url.toString();
  return text.endsWith("/") ? text.slice(0, -1) : text;
}

export function normalizeQaCredentialEndpointPrefix(params: {
  fallback?: string;
  invalidAbsoluteMessage: string;
  invalidSegmentsMessage: string;
  toError?: ErrorFactory;
  value: string | undefined;
}): string {
  const trimmed = params.value?.trim();
  if (!trimmed) {
    return params.fallback ?? QA_CREDENTIALS_DEFAULT_ENDPOINT_PREFIX;
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const normalized = prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
  const toError = params.toError ?? makeError;
  if (!normalized.startsWith("/") || normalized.startsWith("//")) {
    throw toError(params.invalidAbsoluteMessage);
  }
  if (normalized.includes("\\") || normalized.split("/").some((segment) => segment === "..")) {
    throw toError(params.invalidSegmentsMessage);
  }
  return normalized;
}

export function joinQaCredentialEndpoint(baseUrl: string, prefix: string, suffix: string): string {
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  const url = new URL(baseUrl);
  url.pathname = `${prefix}${normalizedSuffix}`.replace(/\/{2,}/gu, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}
