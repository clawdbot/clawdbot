import fs from "node:fs/promises";
import type { ConnectionOptions } from "node:tls";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import {
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  fetchWithSsrFGuard,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

type ProxyRule = RegExp | URL | string;
type TlsCert = ConnectionOptions["cert"];
type TlsKey = ConnectionOptions["key"];
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type GoogleAuthModule = typeof import("google-auth-library");
type GaxiosModule = typeof import("gaxios");
type GoogleAuthRuntime = {
  Gaxios: GaxiosModule["Gaxios"];
  GoogleAuth: GoogleAuthModule["GoogleAuth"];
  OAuth2Client: GoogleAuthModule["OAuth2Client"];
};
type GoogleAuthTransport = InstanceType<GaxiosModule["Gaxios"]>;
type GoogleAuthRequestWithUnknownHeaders = RequestInit & {
  headers?: unknown;
};
type GoogleAuthResponseWithUnknownHeaders = {
  headers?: unknown;
};
type GuardedGoogleAuthRequestInit = RequestInit & {
  agent?: unknown;
  cert?: unknown;
  dispatcher?: unknown;
  fetchImplementation?: unknown;
  key?: unknown;
  noProxy?: unknown;
  proxy?: unknown;
};
type TlsOptions = {
  cert?: TlsCert;
  key?: TlsKey;
};
type ProxyAgentLike = {
  connectOpts?: TlsOptions;
  proxy: URL;
};
type TlsAgentLike = {
  options?: TlsOptions;
};
type GoogleChatServiceAccountCredentials = Record<string, unknown> & {
  auth_provider_x509_cert_url?: string;
  auth_uri?: string;
  client_email: string;
  client_x509_cert_url?: string;
  private_key: string;
  token_uri?: string;
  type?: string;
  universe_domain?: string;
};

const GOOGLE_AUTH_ALLOWED_HOST_SUFFIXES = ["accounts.google.com", "googleapis.com"];
const GOOGLE_AUTH_POLICY = buildHostnameAllowlistPolicyFromSuffixAllowlist(
  GOOGLE_AUTH_ALLOWED_HOST_SUFFIXES,
);
const GOOGLE_AUTH_AUDIT_CONTEXT = "googlechat.auth.google-auth";
const GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
const GOOGLE_AUTH_PROVIDER_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs";
const GOOGLE_AUTH_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_UNIVERSE_DOMAIN = "googleapis.com";
const GOOGLE_CLIENT_CERTS_URL_PREFIX = "https://www.googleapis.com/robot/v1/metadata/x509/";
const MAX_GOOGLE_AUTH_RESPONSE_BYTES = 1024 * 1024;
const MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES = 64 * 1024;

let googleAuthRuntimePromise: Promise<GoogleAuthRuntime> | null = null;

function normalizeGoogleAuthPreparedRequestHeaders<T extends GoogleAuthRequestWithUnknownHeaders>(
  config: T,
): T & { headers: Headers } {
  if (!(config.headers instanceof Headers)) {
    config.headers = new Headers(config.headers as HeadersInit | undefined);
  }
  return config as T & { headers: Headers };
}

function normalizeGoogleAuthResponseHeaders<T extends GoogleAuthResponseWithUnknownHeaders>(
  response: T,
): T & { headers: Headers } {
  if (!(response.headers instanceof Headers)) {
    response.headers = new Headers(response.headers as HeadersInit | undefined);
  }
  return response as T & { headers: Headers };
}

function installGoogleAuthHeaderCompatibilityInterceptor(
  transport: GoogleAuthTransport,
): GoogleAuthTransport {
  transport.interceptors.request.add({
    resolved: async (config) => normalizeGoogleAuthPreparedRequestHeaders(config),
  });
  transport.interceptors.response.add({
    resolved: async (response) => normalizeGoogleAuthResponseHeaders(response),
  });
  return transport;
}

function asNullableObjectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function hasProxyAgentShape(value: unknown): value is ProxyAgentLike {
  const record = asNullableObjectRecord(value);
  return record !== null && record.proxy instanceof URL;
}

function hasTlsAgentShape(value: unknown): value is TlsAgentLike {
  const record = asNullableObjectRecord(value);
  return record !== null && asNullableObjectRecord(record.options) !== null;
}

function resolveGoogleAuthAgent(init: GuardedGoogleAuthRequestInit, url: URL): unknown {
  return typeof init.agent === "function" ? init.agent(url) : init.agent;
}

function hasTlsOptions(options: TlsOptions): boolean {
  return options.cert !== undefined || options.key !== undefined;
}

function resolveGoogleAuthTlsOptions(init: GuardedGoogleAuthRequestInit, url: URL): TlsOptions {
  const explicit = {
    cert: init.cert as TlsCert | undefined,
    key: init.key as TlsKey | undefined,
  };
  if (hasTlsOptions(explicit)) {
    return explicit;
  }

  const agent = resolveGoogleAuthAgent(init, url);
  if (hasProxyAgentShape(agent)) {
    return {
      cert: agent.connectOpts?.cert,
      key: agent.connectOpts?.key,
    };
  }
  if (hasTlsAgentShape(agent)) {
    return {
      cert: agent.options?.cert,
      key: agent.options?.key,
    };
  }
  return {};
}

function normalizeGoogleAuthProxyEnvValue(value: string | undefined): string | null | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveGoogleAuthEnvProxyUrl(protocol: "http" | "https"): string | undefined {
  const httpProxy =
    normalizeGoogleAuthProxyEnvValue(process.env.HTTP_PROXY) ??
    normalizeGoogleAuthProxyEnvValue(process.env.http_proxy);
  const httpsProxy =
    normalizeGoogleAuthProxyEnvValue(process.env.HTTPS_PROXY) ??
    normalizeGoogleAuthProxyEnvValue(process.env.https_proxy);
  if (protocol === "https") {
    return httpsProxy ?? httpProxy ?? undefined;
  }
  return httpProxy ?? undefined;
}

function collectGoogleAuthNoProxyRules(noProxy: ProxyRule[] = []): ProxyRule[] {
  const rules = [...noProxy];
  const envRules = (process.env.NO_PROXY ?? process.env.no_proxy)?.split(",") ?? [];
  for (const rule of envRules) {
    const trimmed = rule.trim();
    if (trimmed.length > 0) {
      rules.push(trimmed);
    }
  }
  return rules;
}

function shouldBypassGoogleAuthProxy(url: URL, noProxy: ProxyRule[] = []): boolean {
  for (const rule of collectGoogleAuthNoProxyRules(noProxy)) {
    if (rule instanceof RegExp) {
      if (rule.test(url.toString())) {
        return true;
      }
      continue;
    }
    if (rule instanceof URL) {
      if (rule.origin === url.origin) {
        return true;
      }
      continue;
    }
    if (rule.startsWith("*.") || rule.startsWith(".")) {
      const cleanedRule = rule.replace(/^\*\./, ".");
      if (url.hostname.endsWith(cleanedRule)) {
        return true;
      }
      continue;
    }
    if (rule === url.origin || rule === url.hostname || rule === url.href) {
      return true;
    }
  }
  return false;
}

function readGoogleAuthProxyUrl(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  return undefined;
}

function readOptionalTrimmedString(
  record: Record<string, unknown>,
  fieldName: string,
): string | undefined {
  const value = record[fieldName];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Google Chat service account field "${fieldName}" must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Google Chat service account field "${fieldName}" cannot be empty`);
  }
  return trimmed;
}

function readRequiredTrimmedString(record: Record<string, unknown>, fieldName: string): string {
  return (
    readOptionalTrimmedString(record, fieldName) ??
    (() => {
      throw new Error(`Google Chat service account is missing "${fieldName}"`);
    })()
  );
}

function assertExactUrlField(
  record: Record<string, unknown>,
  fieldName: string,
  expectedUrl: string,
): void {
  const value = readOptionalTrimmedString(record, fieldName);
  if (!value) {
    return;
  }
  if (value !== expectedUrl) {
    throw new Error(
      `Google Chat service account field "${fieldName}" must be ${expectedUrl}, got ${value}`,
    );
  }
}

function assertUrlPrefixField(
  record: Record<string, unknown>,
  fieldName: string,
  expectedPrefix: string,
): void {
  const value = readOptionalTrimmedString(record, fieldName);
  if (!value) {
    return;
  }
  if (!value.startsWith(expectedPrefix)) {
    throw new Error(
      `Google Chat service account field "${fieldName}" must start with ${expectedPrefix}, got ${value}`,
    );
  }
}

function validateGoogleChatServiceAccountCredentials(
  credentials: Record<string, unknown>,
): GoogleChatServiceAccountCredentials {
  const type = readOptionalTrimmedString(credentials, "type");
  if (type && type !== "service_account") {
    throw new Error(`Google Chat credentials must use service_account auth, got "${type}" instead`);
  }

  readRequiredTrimmedString(credentials, "client_email");
  readRequiredTrimmedString(credentials, "private_key");

  const universeDomain = readOptionalTrimmedString(credentials, "universe_domain");
  if (universeDomain && universeDomain !== GOOGLE_AUTH_UNIVERSE_DOMAIN) {
    throw new Error(
      `Google Chat service account field "universe_domain" must be ${GOOGLE_AUTH_UNIVERSE_DOMAIN}, got ${universeDomain}`,
    );
  }

  assertExactUrlField(credentials, "auth_uri", GOOGLE_AUTH_URI);
  assertExactUrlField(credentials, "auth_provider_x509_cert_url", GOOGLE_AUTH_PROVIDER_CERTS_URL);
  assertExactUrlField(credentials, "token_uri", GOOGLE_AUTH_TOKEN_URI);
  assertUrlPrefixField(credentials, "client_x509_cert_url", GOOGLE_CLIENT_CERTS_URL_PREFIX);

  return credentials as GoogleChatServiceAccountCredentials;
}

async function readCredentialsFile(filePath: string): Promise<Record<string, unknown>> {
  const resolvedPath = resolveUserPath(filePath);
  if (!resolvedPath) {
    throw new Error("Google Chat service account file path is empty");
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(resolvedPath, "r");
  } catch {
    throw new Error("Failed to load Google Chat service account file.");
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Google Chat service account file must be a regular file.");
    }
    if (stat.size > MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES) {
      throw new Error(
        `Google Chat service account file exceeds ${MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES} bytes.`,
      );
    }

    let raw: string;
    try {
      raw = await handle.readFile({ encoding: "utf8" });
    } catch {
      throw new Error("Failed to load Google Chat service account file.");
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES) {
      throw new Error(
        `Google Chat service account file exceeds ${MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES} bytes.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalid Google Chat service account JSON.");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Google Chat service account file must contain a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } finally {
    await handle.close().catch(() => {});
  }
}

function sanitizeGoogleAuthInit(init?: RequestInit): RequestInit | undefined {
  if (!init) {
    return undefined;
  }
  const nextInit = { ...(init as GuardedGoogleAuthRequestInit) };
  delete nextInit.agent;
  delete nextInit.cert;
  delete nextInit.dispatcher;
  delete nextInit.fetchImplementation;
  delete nextInit.key;
  delete nextInit.noProxy;
  delete nextInit.proxy;
  return nextInit;
}

function resolveGoogleAuthDispatcherPolicy(
  input: RequestInfo | URL,
  init?: RequestInit,
): {
  dispatcherPolicy?: PinnedDispatcherPolicy;
  init?: RequestInit;
} {
  const requestUrl =
    input instanceof Request
      ? new URL(input.url)
      : new URL(typeof input === "string" ? input : input.toString());
  const nextInit = sanitizeGoogleAuthInit(init);
  const googleAuthInit = (init ?? {}) as GuardedGoogleAuthRequestInit;
  const tlsOptions = resolveGoogleAuthTlsOptions(googleAuthInit, requestUrl);
  const proxyBypassed = shouldBypassGoogleAuthProxy(
    requestUrl,
    Array.isArray(googleAuthInit.noProxy) ? (googleAuthInit.noProxy as ProxyRule[]) : [],
  );
  const agent = resolveGoogleAuthAgent(googleAuthInit, requestUrl);
  const explicitProxy =
    readGoogleAuthProxyUrl(googleAuthInit.proxy) ??
    (hasProxyAgentShape(agent) ? agent.proxy.toString() : undefined);

  if (!proxyBypassed && explicitProxy) {
    return {
      dispatcherPolicy: {
        allowPrivateProxy: true,
        mode: "explicit-proxy",
        ...(hasTlsOptions(tlsOptions) ? { proxyTls: { ...tlsOptions } } : {}),
        proxyUrl: explicitProxy,
      },
      init: nextInit,
    };
  }

  const envProxyUrl = proxyBypassed
    ? undefined
    : resolveGoogleAuthEnvProxyUrl(requestUrl.protocol === "http:" ? "http" : "https");
  if (envProxyUrl) {
    return {
      dispatcherPolicy: {
        mode: "env-proxy",
        ...(hasTlsOptions(tlsOptions) ? { proxyTls: { ...tlsOptions } } : {}),
      },
      init: nextInit,
    };
  }

  if (hasTlsOptions(tlsOptions)) {
    return {
      dispatcherPolicy: {
        connect: { ...tlsOptions },
        mode: "direct",
      },
      init: nextInit,
    };
  }

  return { init: nextInit };
}

export function createGoogleAuthFetch(baseFetch?: FetchLike): FetchLike {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const guardedOptions = resolveGoogleAuthDispatcherPolicy(input, init);
    const { response, release } = await fetchWithSsrFGuard({
      auditContext: GOOGLE_AUTH_AUDIT_CONTEXT,
      dispatcherPolicy: guardedOptions.dispatcherPolicy,
      init: guardedOptions.init,
      policy: GOOGLE_AUTH_POLICY,
      url,
      ...(baseFetch ? { fetchImpl: baseFetch } : {}),
    });
    try {
      const body = await readGoogleAuthResponseBytes(response);
      const bufferedBody = Uint8Array.from(body);
      return new Response(bufferedBody.buffer, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    } finally {
      await release();
    }
  };
}

async function readGoogleAuthResponseBytes(response: Response): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_GOOGLE_AUTH_RESPONSE_BYTES) {
      throw new Error(`Google auth response exceeds ${MAX_GOOGLE_AUTH_RESPONSE_BYTES} bytes.`);
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(
      "Google auth response body stream unavailable; refusing to buffer unbounded response.",
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > MAX_GOOGLE_AUTH_RESPONSE_BYTES) {
        try {
          await reader.cancel("Google auth response exceeded buffer limit");
        } catch {
          // Ignore cancellation errors; the caller still releases the dispatcher.
        }
        throw new Error(`Google auth response exceeds ${MAX_GOOGLE_AUTH_RESPONSE_BYTES} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function loadGoogleAuthRuntime(): Promise<GoogleAuthRuntime> {
  if (!googleAuthRuntimePromise) {
    googleAuthRuntimePromise = (async () => {
      try {
        const [googleAuthModule, gaxiosModule] = await Promise.all([
          import("google-auth-library"),
          import("gaxios"),
        ]);
        return {
          Gaxios: gaxiosModule.Gaxios,
          GoogleAuth: googleAuthModule.GoogleAuth,
          OAuth2Client: googleAuthModule.OAuth2Client,
        };
      } catch (error) {
        googleAuthRuntimePromise = null;
        throw error;
      }
    })();
  }
  return await googleAuthRuntimePromise;
}

export async function getGoogleAuthTransport(): Promise<GoogleAuthTransport> {
  const { Gaxios } = await loadGoogleAuthRuntime();
  return installGoogleAuthHeaderCompatibilityInterceptor(
    new Gaxios({
      fetchImplementation: createGoogleAuthFetch(),
    }),
  );
}

export async function resolveValidatedGoogleChatCredentials(
  account: ResolvedGoogleChatAccount,
): Promise<GoogleChatServiceAccountCredentials | null> {
  if (account.credentials) {
    return validateGoogleChatServiceAccountCredentials(account.credentials);
  }
  if (account.credentialsFile) {
    const fileCredentials = await readCredentialsFile(account.credentialsFile);
    return validateGoogleChatServiceAccountCredentials(fileCredentials);
  }
  return null;
}

export const __testing = {
  resetGoogleAuthRuntimeForTests(): void {
    googleAuthRuntimePromise = null;
  },
  normalizeGoogleAuthPreparedRequestHeaders,
  normalizeGoogleAuthResponseHeaders,
  resolveGoogleAuthEnvProxyUrl,
  validateGoogleChatServiceAccountCredentials,
};
