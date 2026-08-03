// Openai plugin module implements base url behavior.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const OPENAI_CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

type OpenAIEndpointKind = "unresolved" | "platform" | "chatgpt" | "custom" | "invalid";

const OPENAI_PLATFORM_PATHS = new Set(["/", "/v1", "/v1/"]);
const OPENAI_CHATGPT_PATHS = new Set([
  "/backend-api",
  "/backend-api/",
  "/backend-api/v1",
  "/backend-api/v1/",
  "/backend-api/codex",
  "/backend-api/codex/",
  "/backend-api/codex/v1",
  "/backend-api/codex/v1/",
  "/backend-api/codex/responses",
  "/backend-api/codex/responses/",
]);

/** Classifies exact native endpoints, valid custom URLs, and unsafe/invalid input. */
export function classifyOpenAIBaseUrl(baseUrl: unknown): OpenAIEndpointKind {
  if (baseUrl === undefined || baseUrl === null || baseUrl === "") {
    return "unresolved";
  }
  if (typeof baseUrl !== "string") {
    return "invalid";
  }
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return "unresolved";
  }
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return "invalid";
    }
    const rawHost = url.hostname.toLowerCase();
    const host = rawHost.endsWith(".") ? rawHost.slice(0, -1) : rawHost;
    if (host === "api.openai.com" || host === "chatgpt.com") {
      // Official remote endpoints carry API keys or subscription bearers.
      // Never reinterpret their plaintext form as an eligible native route.
      if (url.protocol !== "https:" || url.port || url.search || url.hash) {
        return "invalid";
      }
      if (host === "api.openai.com" && OPENAI_PLATFORM_PATHS.has(url.pathname)) {
        return "platform";
      }
      if (host === "chatgpt.com" && OPENAI_CHATGPT_PATHS.has(url.pathname)) {
        return "chatgpt";
      }
      return "invalid";
    }
    return "custom";
  } catch {
    return "invalid";
  }
}

export function resolveOpenAIDefaultBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return normalizeOptionalString(env.OPENAI_BASE_URL) ?? OPENAI_API_BASE_URL;
}

export function isOpenAIApiBaseUrl(baseUrl?: string): boolean {
  return classifyOpenAIBaseUrl(baseUrl) === "platform";
}

export function isOpenAICodexBaseUrl(baseUrl?: string): boolean {
  return classifyOpenAIBaseUrl(baseUrl) === "chatgpt";
}

/** True only for an HTTPS OpenAI Platform endpoint eligible for native transport hooks. */
export function isOpenAIHttpsApiBaseUrl(baseUrl?: string): boolean {
  if (typeof baseUrl !== "string" || classifyOpenAIBaseUrl(baseUrl) !== "platform") {
    return false;
  }
  return new URL(baseUrl.trim()).protocol === "https:";
}

export function canonicalizeCodexResponsesBaseUrl(baseUrl?: string): string | undefined {
  return isOpenAICodexBaseUrl(baseUrl) ? OPENAI_CODEX_RESPONSES_BASE_URL : baseUrl;
}
