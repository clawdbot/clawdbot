// Feishu plugin module implements client behavior.
import type { Agent } from "node:https";
import { createRequire } from "node:module";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  readPluginPackageVersion,
  resolveAmbientNodeProxyAgent,
} from "openclaw/plugin-sdk/extension-shared";
import { resolveConfiguredHttpTimeoutMs } from "./client-timeout.js";
import type { FeishuConfig, FeishuDomain, ResolvedFeishuAccount } from "./types.js";

const require = createRequire(import.meta.url);
const pluginVersion = readPluginPackageVersion({ require });

const FEISHU_USER_AGENT = `openclaw-feishu-builtin/${pluginVersion}/${process.platform}`;

const FEISHU_WS_CONFIG = {
  pingTimeout: 3,
} as const;

/** User-Agent header value for all Feishu API requests. */
export function getFeishuUserAgent(): string {
  return FEISHU_USER_AGENT;
}

type FeishuClientSdk = Pick<
  typeof Lark,
  | "AppType"
  | "Client"
  | "defaultHttpInstance"
  | "Domain"
  | "EventDispatcher"
  | "LoggerLevel"
  | "WSClient"
>;

const feishuClientSdk: FeishuClientSdk = {
  AppType: Lark.AppType,
  Client: Lark.Client,
  defaultHttpInstance: Lark.defaultHttpInstance,
  Domain: Lark.Domain,
  EventDispatcher: Lark.EventDispatcher,
  LoggerLevel: Lark.LoggerLevel,
  WSClient: Lark.WSClient,
};

type RequestInterceptorApi = {
  use: (fn: (req: unknown) => unknown) => unknown;
};

type FeishuDefaultHttpInstanceWithInterceptors = {
  interceptors?: {
    request?: RequestInterceptorApi;
  };
};

function setRequestUserAgent(req: unknown) {
  const request = req as { headers?: unknown };
  const headers = request.headers;
  if (!headers) {
    request.headers = { "User-Agent": getFeishuUserAgent() };
    return req;
  }

  const maybeAxiosHeaders = headers as { set?: unknown };
  if (typeof maybeAxiosHeaders.set === "function") {
    maybeAxiosHeaders.set("User-Agent", getFeishuUserAgent());
    return req;
  }

  (headers as Record<string, string>)["User-Agent"] = getFeishuUserAgent();
  return req;
}

// Override the SDK's default User-Agent through the public interceptor API.
// The SDK fallback interceptor only fills User-Agent when it is absent, so this
// interceptor can preserve the rest of the SDK's request interceptor stack.
{
  const inst = Lark.defaultHttpInstance as FeishuDefaultHttpInstanceWithInterceptors;
  inst.interceptors?.request?.use(setRequestUserAgent);
}

type FeishuHttpInstanceLike = Pick<
  typeof feishuClientSdk.defaultHttpInstance,
  "request" | "get" | "post" | "put" | "patch" | "delete" | "head" | "options"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) {
    return undefined;
  }
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== normalizedName) {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string");
      return typeof first === "string" ? first : undefined;
    }
  }
  return undefined;
}

function isMultipartFormRequest(opts: Lark.HttpRequestOptions<unknown>): boolean {
  return /^multipart\/form-data(?:;|$)/i.test(readHeader(opts.headers, "content-type") ?? "");
}

const FEISHU_MESSAGE_MEDIA_UPLOAD_PATHS = new Set([
  "/open-apis/im/v1/files",
  "/open-apis/im/v1/images",
]);

function isFeishuMessageMediaUploadRequest(
  opts: Lark.HttpRequestOptions<unknown>,
  data: Record<string, unknown>,
): boolean {
  if (typeof opts.url !== "string" || opts.method?.toUpperCase() !== "POST") {
    return false;
  }
  let pathname: string;
  try {
    pathname = new URL(opts.url).pathname;
  } catch {
    return false;
  }
  return (
    FEISHU_MESSAGE_MEDIA_UPLOAD_PATHS.has(pathname) &&
    (Buffer.isBuffer(data.file) || Buffer.isBuffer(data.image))
  );
}

function stringifyMultipartFieldValue(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      return undefined;
  }
}

function bufferToBlobPart(value: Buffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytes;
}

function normalizeMultipartUploadData<D>(
  opts: Lark.HttpRequestOptions<D>,
): Lark.HttpRequestOptions<D> {
  if (
    !isMultipartFormRequest(opts) ||
    !isRecord(opts.data) ||
    !isFeishuMessageMediaUploadRequest(opts, opts.data)
  ) {
    return opts;
  }

  const form = new FormData();
  const fileName =
    typeof opts.data.file_name === "string" && opts.data.file_name
      ? opts.data.file_name
      : undefined;
  for (const [key, value] of Object.entries(opts.data)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Buffer.isBuffer(value)) {
      form.append(
        key,
        new Blob([bufferToBlobPart(value)]),
        key === "file" && fileName ? fileName : `${key}.bin`,
      );
      continue;
    }
    const fieldValue = stringifyMultipartFieldValue(value);
    if (fieldValue !== undefined) {
      form.append(key, fieldValue);
    }
  }

  return { ...opts, data: form as D };
}

function isManagedProxyActive() {
  return process.env["OPENCLAW_PROXY_ACTIVE"] === "1";
}

let cachedFeishuProxyAgent: Agent | undefined;
let pendingFeishuProxyAgent: Promise<Agent | undefined> | undefined;
let feishuProxyAgentGeneration = 0;

// Ambient proxy configuration is process-stable. Share one dual-protocol agent
// across REST, bootstrap, and WebSocket traffic so connections stay pooled.
async function getFeishuProxyAgent(): Promise<Agent | undefined> {
  if (cachedFeishuProxyAgent) {
    return cachedFeishuProxyAgent;
  }
  if (pendingFeishuProxyAgent) {
    return pendingFeishuProxyAgent;
  }

  const generation = feishuProxyAgentGeneration;
  let resolutionError: unknown;
  const pending = resolveAmbientNodeProxyAgent<Agent>({
    onError: (error) => {
      resolutionError = error;
    },
  }).then((agent) => {
    if (generation !== feishuProxyAgentGeneration) {
      agent?.destroy();
      return undefined;
    }
    if (!agent && isManagedProxyActive()) {
      throw new Error("Feishu managed proxy is active but no proxy agent could be created", {
        cause: resolutionError,
      });
    }
    cachedFeishuProxyAgent = agent;
    return agent;
  });
  pendingFeishuProxyAgent = pending;
  try {
    return await pending;
  } finally {
    if (pendingFeishuProxyAgent === pending) {
      pendingFeishuProxyAgent = undefined;
    }
  }
}

/** @internal Resets process-scoped proxy state between tests. */
export function resetFeishuProxyAgentForTest(): void {
  feishuProxyAgentGeneration += 1;
  pendingFeishuProxyAgent = undefined;
  cachedFeishuProxyAgent?.destroy();
  cachedFeishuProxyAgent = undefined;
}

type FeishuProxyAwareHttpRequestOptions<D> = Lark.HttpRequestOptions<D> & {
  httpAgent?: Agent;
  httpsAgent?: Agent;
  proxy?: false;
};

// Multi-account client cache
const clientCache = new Map<
  string,
  {
    client: Lark.Client;
    config: { appId: string; appSecret: string; domain?: FeishuDomain; httpTimeoutMs: number };
  }
>();

function resolveDomain(domain: FeishuDomain | undefined): Lark.Domain | string {
  if (domain === "lark") {
    return feishuClientSdk.Domain.Lark;
  }
  if (domain === "feishu" || !domain) {
    return feishuClientSdk.Domain.Feishu;
  }
  return domain.replace(/\/+$/, ""); // Custom URL for private deployment
}

/**
 * Create an HTTP instance that delegates to the Lark SDK's default instance
 * but injects a default request timeout and User-Agent header to prevent
 * indefinite hangs, set a standardized User-Agent per OAPI best practices, and
 * keep axios from taking a separate ambient proxy path for HTTPS requests.
 */
function createFeishuHttpInstance(defaultTimeoutMs: number): Lark.HttpInstance {
  const base: FeishuHttpInstanceLike = feishuClientSdk.defaultHttpInstance;

  async function injectRequestOptions<D>(
    opts?: Lark.HttpRequestOptions<D>,
  ): Promise<FeishuProxyAwareHttpRequestOptions<D>> {
    const next: FeishuProxyAwareHttpRequestOptions<D> = { timeout: defaultTimeoutMs, ...opts };
    const agent = await getFeishuProxyAgent();
    if (agent) {
      if (isManagedProxyActive()) {
        next.httpAgent = agent;
        next.httpsAgent = agent;
      } else {
        next.httpAgent ??= agent;
        next.httpsAgent ??= agent;
      }
      next.proxy = false;
    }
    return next;
  }

  return {
    request: async (opts) =>
      base.request(await injectRequestOptions(normalizeMultipartUploadData(opts))),
    get: async (url, opts) => base.get(url, await injectRequestOptions(opts)),
    post: async (url, data, opts) => base.post(url, data, await injectRequestOptions(opts)),
    put: async (url, data, opts) => base.put(url, data, await injectRequestOptions(opts)),
    patch: async (url, data, opts) => base.patch(url, data, await injectRequestOptions(opts)),
    delete: async (url, opts) => base.delete(url, await injectRequestOptions(opts)),
    head: async (url, opts) => base.head(url, await injectRequestOptions(opts)),
    options: async (url, opts) => base.options(url, await injectRequestOptions(opts)),
  };
}

/**
 * Credentials needed to create a Feishu client.
 * Both FeishuConfig and ResolvedFeishuAccount satisfy this interface.
 */
export type FeishuClientCredentials = {
  accountId?: string;
  appId?: string;
  appSecret?: string;
  domain?: FeishuDomain;
  httpTimeoutMs?: number;
  config?: Pick<FeishuConfig, "httpTimeoutMs">;
};

/**
 * Create or get a cached Feishu client for an account.
 * Accepts any object with appId, appSecret, and optional domain/accountId.
 */
export function createFeishuClient(creds: FeishuClientCredentials): Lark.Client {
  const { accountId = "default", appId, appSecret, domain } = creds;
  const defaultHttpTimeoutMs = resolveConfiguredHttpTimeoutMs(creds);

  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured for account "${accountId}"`);
  }

  // Check cache
  const cached = clientCache.get(accountId);
  if (
    cached &&
    cached.config.appId === appId &&
    cached.config.appSecret === appSecret &&
    cached.config.domain === domain &&
    cached.config.httpTimeoutMs === defaultHttpTimeoutMs
  ) {
    return cached.client;
  }

  // Create new client with timeout-aware HTTP instance
  const client = new feishuClientSdk.Client({
    appId,
    appSecret,
    appType: feishuClientSdk.AppType.SelfBuild,
    domain: resolveDomain(domain),
    httpInstance: createFeishuHttpInstance(defaultHttpTimeoutMs),
  });

  // Cache it
  clientCache.set(accountId, {
    client,
    config: { appId, appSecret, domain, httpTimeoutMs: defaultHttpTimeoutMs },
  });

  return client;
}

type FeishuWsClientCallbacks = Pick<
  ConstructorParameters<typeof feishuClientSdk.WSClient>[0],
  "onError" | "onReady" | "onReconnected" | "onReconnecting"
>;

/**
 * Create a Feishu WebSocket client for an account.
 * Note: WSClient is not cached since each call creates a new connection.
 */
export async function createFeishuWSClient(
  account: ResolvedFeishuAccount,
  callbacks: FeishuWsClientCallbacks = {},
): Promise<Lark.WSClient> {
  const { accountId, appId, appSecret, domain } = account;

  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured for account "${accountId}"`);
  }

  const agent = await getFeishuProxyAgent();
  const defaultHttpTimeoutMs = resolveConfiguredHttpTimeoutMs(account);
  return new feishuClientSdk.WSClient({
    appId,
    appSecret,
    domain: resolveDomain(domain),
    httpInstance: createFeishuHttpInstance(defaultHttpTimeoutMs),
    ...callbacks,
    loggerLevel: feishuClientSdk.LoggerLevel.info,
    wsConfig: FEISHU_WS_CONFIG,
    ...(agent ? { agent } : {}),
  });
}

/**
 * Create an event dispatcher for an account.
 */
export function createEventDispatcher(account: ResolvedFeishuAccount): Lark.EventDispatcher {
  return new feishuClientSdk.EventDispatcher({
    encryptKey: account.encryptKey,
    verificationToken: account.verificationToken,
  });
}
