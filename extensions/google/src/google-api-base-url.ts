// Lightweight Google API URL normalization shared by provider contract surfaces.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const DEFAULT_GOOGLE_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function isCanonicalGoogleApiOriginShorthand(value: string): boolean {
  return /^https:\/\/generativelanguage\.googleapis\.com\/?$/i.test(value);
}

function isGoogleGenerativeAiUrl(url: URL): boolean {
  return (
    url.protocol === "https:" && url.hostname.toLowerCase() === "generativelanguage.googleapis.com"
  );
}

function stripUrlUserInfo(url: URL): void {
  url.username = "";
  url.password = "";
}

const GOOGLE_VERTEX_HOST = "aiplatform.googleapis.com";
const GOOGLE_VERTEX_REGION_HOST_SUFFIX = "-aiplatform.googleapis.com";
const GOOGLE_VERTEX_MULTI_REGION_HOSTS = new Set([
  "aiplatform.eu.rep.googleapis.com",
  "aiplatform.us.rep.googleapis.com",
]);

export function isGoogleVertexHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === GOOGLE_VERTEX_HOST ||
    normalized.endsWith(GOOGLE_VERTEX_REGION_HOST_SUFFIX) ||
    GOOGLE_VERTEX_MULTI_REGION_HOSTS.has(normalized)
  );
}

export function isGoogleVertexBaseUrl(baseUrl?: string | null): boolean {
  const raw = normalizeOptionalString(baseUrl);
  if (!raw) {
    return false;
  }
  try {
    return isGoogleVertexHostname(new URL(raw).hostname);
  } catch {
    return false;
  }
}

export function normalizeGoogleApiBaseUrl(baseUrl?: string): string {
  const raw = trimTrailingSlashes(normalizeOptionalString(baseUrl) || DEFAULT_GOOGLE_API_BASE_URL);
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    stripUrlUserInfo(url);
    if (isGoogleGenerativeAiUrl(url)) {
      const normalizedPath = trimTrailingSlashes(url.pathname || "");
      url.pathname = normalizedPath || "/v1beta";
    }
    return trimTrailingSlashes(url.toString());
  } catch {
    if (isCanonicalGoogleApiOriginShorthand(raw)) {
      return DEFAULT_GOOGLE_API_BASE_URL;
    }
    return raw;
  }
}

export function isGoogleGenerativeAiApi(api?: string | null): boolean {
  return api === "google-generative-ai";
}

export function normalizeGoogleGenerativeAiBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) {
    return baseUrl;
  }

  const normalized = normalizeGoogleApiBaseUrl(baseUrl);
  try {
    const url = new URL(normalized);
    stripUrlUserInfo(url);
    if (isGoogleGenerativeAiUrl(url)) {
      url.pathname = trimTrailingSlashes(url.pathname || "").replace(/\/openai$/i, "") || "/v1beta";
      return trimTrailingSlashes(url.toString());
    }
  } catch {
    // `normalizeGoogleApiBaseUrl` already returned the best-effort input form.
  }

  return normalized;
}
