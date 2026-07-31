// Copilot plugin module implements BYOK provider mapping.
import type { ProviderConfig } from "@github/copilot-sdk";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import { tokenFingerprint } from "./auth-bridge.js";

const COPILOT_BYOK_PROVIDER_ERROR =
  "[copilot-attempt] BYOK requires an OpenAI-compatible or Anthropic model api and a non-empty baseUrl";
const COPILOT_BYOK_TRANSPORT_POLICY_ERROR =
  "[copilot-attempt] BYOK does not support OpenClaw provider request proxy, TLS, or private-network policy overrides";
const COPILOT_BYOK_ENDPOINT_POLICY_ERROR =
  "[copilot-attempt] BYOK endpoint is blocked by OpenClaw SSRF policy";

const CREDENTIAL_QUERY_PARAM_NAMES = new Set([
  "accesstoken",
  "appsecret",
  "auth",
  "authtoken",
  "apikey",
  "authorization",
  "clientsecret",
  "code",
  "credential",
  "hooktoken",
  "idtoken",
  "jwt",
  "key",
  "pass",
  "passwd",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "session",
  "sig",
  "signature",
  "token",
  "xapikey",
  "xaccesstoken",
  "xamzsecuritytoken",
  "xamzsignature",
  "xauthtoken",
]);
const QUERY_PARAM_NAME_SEPARATOR_RE = /[\p{C}\p{Z}\u115F\u1160\u3164\uFFA0+]/gu;

type CopilotProviderMode = "github-copilot" | "byok";

type CopilotModelProviderInput = {
  api?: string;
  id: string;
  provider: string;
  baseUrl?: string;
  azureApiVersion?: string;
  headers?: Record<string, string | null | undefined>;
  authHeader?: boolean;
  requestAuthMode?: string;
  requestProxy?: unknown;
  requestTls?: unknown;
  requestAllowPrivateNetwork?: unknown;
  contextTokens?: number;
  contextWindow?: number;
  maxTokens?: number;
};

export type ResolvedCopilotProvider = {
  mode: CopilotProviderMode;
  provider?: ProviderConfig;
  authProfileId?: string;
  authProfileVersion?: string;
};

/**
 * Maps OpenClaw's prepared model facts into the Copilot SDK's session-level
 * provider contract. The SDK owns the wire request; OpenClaw only supplies
 * the already-resolved endpoint, model, headers, and credential.
 */
export function resolveCopilotProvider(params: {
  model: CopilotModelProviderInput;
  resolvedApiKey?: string;
  authProfileId?: string;
}): ResolvedCopilotProvider {
  if (params.model.provider.trim().toLowerCase() === "github-copilot") {
    return { mode: "github-copilot" };
  }

  const baseUrl = readString(params.model.baseUrl);
  if (!baseUrl) {
    throw new Error(COPILOT_BYOK_PROVIDER_ERROR);
  }
  assertByokEndpointAllowed(baseUrl);
  if (hasUnsupportedTransportPolicy(params.model)) {
    throw new Error(COPILOT_BYOK_TRANSPORT_POLICY_ERROR);
  }

  const api = readString(params.model.api)?.toLowerCase() ?? "openai-responses";
  const provider = resolveProviderType(api, baseUrl, params.model.azureApiVersion);
  const resolvedApiKey = resolveProviderCredential(params.resolvedApiKey);
  const headers = resolveProviderHeaders(params.model.headers);
  const requestAuthMode = readString(params.model.requestAuthMode)?.toLowerCase();
  const usePreparedRequestAuth =
    requestAuthMode !== undefined && requestAuthMode !== "provider-default";
  const providerConfig: ProviderConfig = {
    type: provider.type,
    ...(provider.wireApi ? { wireApi: provider.wireApi } : {}),
    baseUrl: provider.baseUrl,
    modelId: params.model.id,
    wireModel: params.model.id,
    ...(resolvedApiKey && !usePreparedRequestAuth
      ? params.model.authHeader
        ? { bearerToken: resolvedApiKey }
        : { apiKey: resolvedApiKey }
      : {}),
    ...(headers ? { headers } : {}),
    ...(provider.azure ? { azure: provider.azure } : {}),
    ...((params.model.contextTokens ?? params.model.contextWindow)
      ? { maxPromptTokens: params.model.contextTokens ?? params.model.contextWindow }
      : {}),
    ...(params.model.maxTokens ? { maxOutputTokens: params.model.maxTokens } : {}),
  };
  const authProfileId = params.authProfileId?.trim() || `byok:${params.model.provider}`;
  const authProfileVersion = tokenFingerprint(
    stableSerialize({
      api,
      baseUrl: provider.baseUrl,
      azureApiVersion: provider.azure?.apiVersion,
      headers,
      authHeader: params.model.authHeader,
      requestAuthMode: params.model.requestAuthMode,
      apiKey: resolvedApiKey,
      modelId: params.model.id,
      maxPromptTokens: params.model.contextTokens ?? params.model.contextWindow,
      maxOutputTokens: params.model.maxTokens,
    }),
  );

  return {
    mode: "byok",
    provider: providerConfig,
    authProfileId,
    authProfileVersion,
  };
}

export function isCopilotByokUnsupportedProviderError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === COPILOT_BYOK_PROVIDER_ERROR ||
      error.message === COPILOT_BYOK_TRANSPORT_POLICY_ERROR ||
      error.message === COPILOT_BYOK_ENDPOINT_POLICY_ERROR)
  );
}

export function supportsCopilotByokProviderShape(
  model: Pick<
    CopilotModelProviderInput,
    "api" | "baseUrl" | "requestProxy" | "requestTls" | "requestAllowPrivateNetwork"
  >,
): boolean {
  if (!readString(model.baseUrl) || hasUnsupportedTransportPolicy(model)) {
    return false;
  }
  try {
    resolveProviderType(
      readString(model.api)?.toLowerCase() ?? "openai-responses",
      readString(model.baseUrl)!,
      undefined,
    );
    assertByokEndpointHostAllowed(readString(model.baseUrl)!);
    return true;
  } catch {
    return false;
  }
}

function hasUnsupportedTransportPolicy(
  model: Pick<
    CopilotModelProviderInput,
    "requestProxy" | "requestTls" | "requestAllowPrivateNetwork"
  >,
): boolean {
  return (
    model.requestProxy !== undefined ||
    model.requestTls !== undefined ||
    model.requestAllowPrivateNetwork !== undefined
  );
}

function assertByokEndpointHostAllowed(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(COPILOT_BYOK_PROVIDER_ERROR);
  }
  if (url.protocol !== "https:") {
    throw new Error(COPILOT_BYOK_ENDPOINT_POLICY_ERROR);
  }
  if (url.username || url.password) {
    throw new Error(COPILOT_BYOK_ENDPOINT_POLICY_ERROR);
  }
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_PARAM_NAMES.has(normalizeCredentialQueryParamName(key))) {
      throw new Error(COPILOT_BYOK_ENDPOINT_POLICY_ERROR);
    }
  }
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (isBlockedHostnameOrIp(hostname)) {
    throw new Error(COPILOT_BYOK_ENDPOINT_POLICY_ERROR);
  }
}

function normalizeCredentialQueryParamName(name: string): string {
  const stripped = name.replace(QUERY_PARAM_NAME_SEPARATOR_RE, "");
  try {
    return decodeURIComponent(stripped)
      .replace(QUERY_PARAM_NAME_SEPARATOR_RE, "")
      .toLowerCase()
      .replace(/[-_]/g, "");
  } catch {
    return stripped.toLowerCase().replace(/[-_]/g, "");
  }
}

function assertByokEndpointAllowed(baseUrl: string): void {
  assertByokEndpointHostAllowed(baseUrl);
}

function resolveProviderType(
  api: string | undefined,
  baseUrl: string,
  azureApiVersion: string | undefined,
): {
  type: NonNullable<ProviderConfig["type"]>;
  wireApi?: NonNullable<ProviderConfig["wireApi"]>;
  baseUrl: string;
  azure?: NonNullable<ProviderConfig["azure"]>;
} {
  switch (api) {
    case "anthropic-messages":
      return { type: "anthropic", baseUrl };
    case "azure-openai-responses":
      return resolveAzureProviderType(baseUrl, azureApiVersion);
    case "openai-responses":
      return { type: "openai", wireApi: "responses", baseUrl };
    case "openai-completions":
    case "ollama":
      return { type: "openai", wireApi: "completions", baseUrl };
    default:
      throw new Error(COPILOT_BYOK_PROVIDER_ERROR);
  }
}

function resolveAzureProviderType(
  baseUrl: string,
  apiVersion: string | undefined,
): {
  type: NonNullable<ProviderConfig["type"]>;
  wireApi: NonNullable<ProviderConfig["wireApi"]>;
  baseUrl: string;
  azure?: NonNullable<ProviderConfig["azure"]>;
} {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(COPILOT_BYOK_PROVIDER_ERROR);
  }
  if (isOpenAICompatibleAzureResponsesBaseUrl(url)) {
    return { type: "openai", wireApi: "responses", baseUrl };
  }
  if (!isTraditionalAzureOpenAIHost(url.hostname)) {
    throw new Error(COPILOT_BYOK_PROVIDER_ERROR);
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  const resolvedApiVersion = readString(apiVersion);
  return {
    type: "azure",
    wireApi: "responses",
    baseUrl: url.toString().replace(/\/+$/, ""),
    ...(resolvedApiVersion ? { azure: { apiVersion: resolvedApiVersion } } : {}),
  };
}

function isTraditionalAzureOpenAIHost(hostname: string): boolean {
  return (
    hostname.endsWith(".openai.azure.com") || hostname.endsWith(".cognitiveservices.azure.com")
  );
}

function isOpenAICompatibleAzureResponsesBaseUrl(url: URL): boolean {
  if (isTraditionalAzureOpenAIHost(url.hostname)) {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  const isFoundryHost =
    hostname.endsWith(".services.ai.azure.com") ||
    hostname.endsWith(".api.cognitive.microsoft.com");
  if (!isFoundryHost) {
    return false;
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  return normalizedPath === "/openai/v1" || normalizedPath.endsWith("/openai/v1");
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveProviderCredential(value: string | undefined): string | undefined {
  const credential = readString(value);
  return credential && !isNonSecretApiKeyMarker(credential) ? credential : undefined;
}

function resolveProviderHeaders(
  headers: Record<string, string | null | undefined> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const resolved = Object.fromEntries(
    Object.entries(headers).filter(([, value]) => typeof value === "string"),
  ) as Record<string, string>;
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
