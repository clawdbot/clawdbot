import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
import { probeApnsHttp2ReachabilityViaProxy } from "../../push-apns-http2.js";
import { fetchWithRuntimeDispatcher } from "../runtime-fetch.js";
import { createHttp1ProxyAgent } from "../undici-runtime.js";

export const DEFAULT_PROXY_VALIDATION_ALLOWED_URLS = ["https://example.com/"] as const;
export const DEFAULT_PROXY_VALIDATION_APNS_AUTHORITY = "https://api.sandbox.push.apple.com";

const DEFAULT_PROXY_VALIDATION_TIMEOUT_MS = 5000;
const DENIED_CANARY_HEADER = "x-openclaw-proxy-validation-canary";
const APNS_REACHABILITY_REASON = "InvalidProviderToken";

export type ProxyValidationConfigSource = "override" | "config" | "env" | "missing" | "disabled";

export type ProxyValidationResolvedConfig = {
  enabled: boolean;
  proxyUrl?: string;
  source: ProxyValidationConfigSource;
  errors: string[];
};

export type ProxyValidationCheckKind = "allowed" | "denied" | "apns";

export type ProxyValidationCheck = {
  kind: ProxyValidationCheckKind;
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
};

export type ProxyValidationResult = {
  ok: boolean;
  config: ProxyValidationResolvedConfig;
  checks: ProxyValidationCheck[];
};

export type ProxyValidationFetchCheckParams = {
  proxyUrl: string;
  targetUrl: string;
  timeoutMs: number;
};

export type ProxyValidationFetchCheckResult = {
  ok: boolean;
  status: number;
  deniedCanaryToken?: string;
};

export type ProxyValidationFetchCheck = (
  params: ProxyValidationFetchCheckParams,
) => Promise<ProxyValidationFetchCheckResult>;

export type ProxyValidationApnsCheckParams = {
  proxyUrl: string;
  authority: string;
  timeoutMs: number;
};

export type ProxyValidationApnsCheckResult = {
  status: number;
  /** Present when the response originated from a real APNs server (Apple always returns this UUID). */
  apnsId?: string;
  /** APNs JSON error reason. InvalidProviderToken proves the invalid-token probe reached APNs. */
  apnsReason?: string;
};

export type ProxyValidationApnsCheck = (
  params: ProxyValidationApnsCheckParams,
) => Promise<ProxyValidationApnsCheckResult>;

export type ResolveProxyValidationConfigOptions = {
  config?: ProxyConfig;
  env?: NodeJS.ProcessEnv | Partial<Record<"OPENCLAW_PROXY_URL", string | undefined>>;
  proxyUrlOverride?: string;
};

export type RunProxyValidationOptions = ResolveProxyValidationConfigOptions & {
  allowedUrls?: readonly string[];
  deniedUrls?: readonly string[];
  timeoutMs?: number;
  fetchCheck?: ProxyValidationFetchCheck;
  apnsReachability?: boolean;
  apnsAuthority?: string;
  apnsCheck?: ProxyValidationApnsCheck;
};

function normalizeProxyUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isHttpProxyUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "http:";
  } catch {
    return false;
  }
}

function validateProxyUrl(value: string | undefined): string[] {
  if (!value) {
    return ["proxy validation requires proxy.proxyUrl, --proxy-url, or OPENCLAW_PROXY_URL"];
  }
  if (!isHttpProxyUrl(value)) {
    return ["proxyUrl must use http://"];
  }
  return [];
}

function validateProxyEnabled(source: ProxyValidationConfigSource, enabled: boolean): string[] {
  if (enabled || source === "override" || source === "missing" || source === "disabled") {
    return [];
  }
  if (source === "env") {
    return ["proxy validation requires proxy.enabled to be true for OPENCLAW_PROXY_URL"];
  }
  return ["proxy validation requires proxy.enabled to be true for configured proxy URLs"];
}

function validateResolvedProxy(
  source: ProxyValidationConfigSource,
  enabled: boolean,
  value: string | undefined,
): string[] {
  return [...validateProxyUrl(value), ...validateProxyEnabled(source, enabled)];
}

export function resolveProxyValidationConfig(
  options: ResolveProxyValidationConfigOptions,
): ProxyValidationResolvedConfig {
  const overrideUrl = normalizeProxyUrl(options.proxyUrlOverride);
  if (overrideUrl) {
    return {
      enabled: true,
      proxyUrl: overrideUrl,
      source: "override",
      errors: validateResolvedProxy("override", true, overrideUrl),
    };
  }

  const configUrl = normalizeProxyUrl(options.config?.proxyUrl);
  if (configUrl) {
    return {
      enabled: options.config?.enabled === true,
      proxyUrl: configUrl,
      source: "config",
      errors: validateResolvedProxy("config", options.config?.enabled === true, configUrl),
    };
  }

  const envUrl = normalizeProxyUrl(options.env?.OPENCLAW_PROXY_URL);
  if (envUrl) {
    return {
      enabled: options.config?.enabled === true,
      proxyUrl: envUrl,
      source: "env",
      errors: validateResolvedProxy("env", options.config?.enabled === true, envUrl),
    };
  }

  if (options.config?.enabled === true) {
    return {
      enabled: true,
      source: "missing",
      errors: validateProxyUrl(undefined),
    };
  }

  return {
    enabled: false,
    source: "disabled",
    errors: [
      "proxy validation requires proxy.enabled=true with proxy.proxyUrl or OPENCLAW_PROXY_URL, or --proxy-url",
    ],
  };
}

async function defaultProxyValidationFetchCheck({
  proxyUrl,
  targetUrl,
  timeoutMs,
}: ProxyValidationFetchCheckParams): Promise<ProxyValidationFetchCheckResult> {
  const dispatcher = createHttp1ProxyAgent({ uri: proxyUrl }, timeoutMs);
  try {
    const response = await fetchWithRuntimeDispatcher(targetUrl, {
      dispatcher,
      redirect: "manual",
    });
    void response.body?.cancel();
    return {
      ok: response.ok,
      status: response.status,
      deniedCanaryToken: response.headers.get(DENIED_CANARY_HEADER) ?? undefined,
    };
  } finally {
    await dispatcher.close();
  }
}

async function defaultProxyValidationApnsCheck({
  proxyUrl,
  authority,
  timeoutMs,
}: ProxyValidationApnsCheckParams): Promise<ProxyValidationApnsCheckResult> {
  const result = await probeApnsHttp2ReachabilityViaProxy({ proxyUrl, authority, timeoutMs });
  return {
    status: result.status,
    apnsId: result.responseHeaders?.["apns-id"],
    apnsReason: parseApnsErrorReason(result.body),
  };
}

function parseApnsErrorReason(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const reason = (parsed as { reason?: unknown }).reason;
    return typeof reason === "string" && reason.trim() ? reason : undefined;
  } catch {
    return undefined;
  }
}

function hasApnsReachabilityProof(result: ProxyValidationApnsCheckResult): boolean {
  if (result.apnsId) {
    return true;
  }
  return result.status === 403 && result.apnsReason === APNS_REACHABILITY_REASON;
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PROXY_VALIDATION_TIMEOUT_MS;
  }
  return Math.floor(value);
}

function isValidHttpTargetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

type ProxyValidationDeniedTarget = {
  url: string;
  expectedCanaryToken?: string;
  transportErrorMeansBlocked: boolean;
};

type DeniedCanary = {
  target: ProxyValidationDeniedTarget;
  close: () => Promise<void>;
};

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function createLoopbackDeniedCanary(): Promise<DeniedCanary> {
  const token = randomUUID();
  const server = createServer((_request, response) => {
    response.writeHead(204, {
      [DENIED_CANARY_HEADER]: token,
      "cache-control": "no-store",
    });
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    await closeServer(server);
    throw new Error("Unable to start loopback proxy validation canary");
  }

  return {
    target: {
      url: `http://127.0.0.1:${address.port}/`,
      expectedCanaryToken: token,
      transportErrorMeansBlocked: true,
    },
    close: () => closeServer(server),
  };
}

async function resolveDeniedTargets(
  deniedUrls: readonly string[] | undefined,
): Promise<{ targets: ProxyValidationDeniedTarget[]; close: () => Promise<void> }> {
  if (deniedUrls !== undefined) {
    return {
      targets: deniedUrls.map((url) => ({
        url,
        transportErrorMeansBlocked: false,
      })),
      close: async () => undefined,
    };
  }

  const canary = await createLoopbackDeniedCanary();
  return {
    targets: [canary.target],
    close: canary.close,
  };
}

async function runAllowedCheck(params: {
  url: string;
  proxyUrl: string;
  timeoutMs: number;
  fetchCheck: ProxyValidationFetchCheck;
}): Promise<ProxyValidationCheck> {
  if (!isValidHttpTargetUrl(params.url)) {
    return {
      kind: "allowed",
      url: params.url,
      ok: false,
      error: "Invalid allowed destination URL",
    };
  }

  try {
    const result = await params.fetchCheck({
      proxyUrl: params.proxyUrl,
      targetUrl: params.url,
      timeoutMs: params.timeoutMs,
    });
    if (!result.ok) {
      return {
        kind: "allowed",
        url: params.url,
        ok: false,
        status: result.status,
        error: `Allowed destination returned HTTP ${result.status}`,
      };
    }
    return { kind: "allowed", url: params.url, ok: true, status: result.status };
  } catch (err) {
    return {
      kind: "allowed",
      url: params.url,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runDeniedCheck(params: {
  target: ProxyValidationDeniedTarget;
  proxyUrl: string;
  timeoutMs: number;
  fetchCheck: ProxyValidationFetchCheck;
}): Promise<ProxyValidationCheck> {
  if (!isValidHttpTargetUrl(params.target.url)) {
    return {
      kind: "denied",
      url: params.target.url,
      ok: false,
      error: "Invalid denied destination URL",
    };
  }

  try {
    const result = await params.fetchCheck({
      proxyUrl: params.proxyUrl,
      targetUrl: params.target.url,
      timeoutMs: params.timeoutMs,
    });
    if (
      params.target.expectedCanaryToken !== undefined &&
      result.deniedCanaryToken !== params.target.expectedCanaryToken
    ) {
      if (result.ok) {
        return {
          kind: "denied",
          url: params.target.url,
          ok: false,
          status: result.status,
          error: `Denied loopback canary returned HTTP ${result.status} without the validation token`,
        };
      }
      return {
        kind: "denied",
        url: params.target.url,
        ok: true,
        status: result.status,
      };
    }
    return {
      kind: "denied",
      url: params.target.url,
      ok: false,
      status: result.status,
      error:
        params.target.expectedCanaryToken === undefined
          ? `Denied destination returned HTTP ${result.status}; expected the proxy to block the connection`
          : `Denied loopback canary was reachable through the proxy with HTTP ${result.status}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (params.target.transportErrorMeansBlocked) {
      return {
        kind: "denied",
        url: params.target.url,
        ok: true,
        error: message,
      };
    }
    return {
      kind: "denied",
      url: params.target.url,
      ok: false,
      error: `Denied destination failed without a verifiable proxy-deny signal: ${message}`,
    };
  }
}

async function runApnsReachabilityCheck(params: {
  authority: string;
  proxyUrl: string;
  timeoutMs: number;
  apnsCheck: ProxyValidationApnsCheck;
}): Promise<ProxyValidationCheck> {
  try {
    const result = await params.apnsCheck({
      proxyUrl: params.proxyUrl,
      authority: params.authority,
      timeoutMs: params.timeoutMs,
    });
    if (!hasApnsReachabilityProof(result)) {
      return {
        kind: "apns",
        url: params.authority,
        ok: false,
        error:
          "APNs reachability check failed: response did not include an apns-id header or APNs InvalidProviderToken body. " +
          "The proxy may be intercepting the connection instead of tunneling it.",
      };
    }
    return {
      kind: "apns",
      url: params.authority,
      ok: true,
      status: result.status,
    };
  } catch (err) {
    return {
      kind: "apns",
      url: params.authority,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runProxyValidation(
  options: RunProxyValidationOptions,
): Promise<ProxyValidationResult> {
  const config = resolveProxyValidationConfig(options);
  if (config.errors.length > 0) {
    return { ok: false, config, checks: [] };
  }
  if (!config.proxyUrl) {
    if (!config.enabled && config.source === "disabled") {
      return {
        ok: false,
        config: {
          ...config,
          errors: [
            "Proxy validation is disabled. Set proxy.enabled=true or pass --proxy-url to run validation.",
          ],
        },
        checks: [],
      };
    }
    return { ok: false, config, checks: [] };
  }

  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const fetchCheck = options.fetchCheck ?? defaultProxyValidationFetchCheck;
  const apnsCheck = options.apnsCheck ?? defaultProxyValidationApnsCheck;
  const apnsAuthority = options.apnsAuthority ?? DEFAULT_PROXY_VALIDATION_APNS_AUTHORITY;
  const allowedUrls = options.allowedUrls ?? DEFAULT_PROXY_VALIDATION_ALLOWED_URLS;
  const deniedTargets = await resolveDeniedTargets(options.deniedUrls);
  const checks: ProxyValidationCheck[] = [];

  try {
    for (const url of allowedUrls) {
      checks.push(await runAllowedCheck({ url, proxyUrl: config.proxyUrl, timeoutMs, fetchCheck }));
    }
    for (const target of deniedTargets.targets) {
      checks.push(
        await runDeniedCheck({ target, proxyUrl: config.proxyUrl, timeoutMs, fetchCheck }),
      );
    }
    if (options.apnsReachability === true) {
      checks.push(
        await runApnsReachabilityCheck({
          authority: apnsAuthority,
          proxyUrl: config.proxyUrl,
          timeoutMs,
          apnsCheck,
        }),
      );
    }
  } finally {
    await deniedTargets.close();
  }

  return {
    ok: checks.every((check) => check.ok),
    config,
    checks,
  };
}
