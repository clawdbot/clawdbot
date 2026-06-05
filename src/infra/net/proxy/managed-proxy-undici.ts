// Bridges OpenClaw-managed proxy TLS trust into Undici EnvHttpProxyAgent and
// explicit ProxyAgent options without changing unrelated operator proxies.
import { isRecord as isProxyTlsRecord } from "@openclaw/normalization-core/record-coerce";
import type { EnvHttpProxyAgent } from "undici";
import { resolveEnvHttpProxyAgentOptions, resolveEnvHttpProxyUrl } from "../proxy-env.js";
import { getActiveManagedProxyTlsOptions, getActiveManagedProxyUrl } from "./active-proxy-state.js";
import {
  loadManagedProxyTlsOptionsSync,
  resolveManagedProxyCaFileForUrl,
  type ManagedProxyTlsOptions,
} from "./proxy-tls.js";

export type ManagedEnvHttpProxyAgentOptions = ConstructorParameters<typeof EnvHttpProxyAgent>[0];

function readProxyTlsRecord(options: object | undefined): Record<string, unknown> | undefined {
  if (!options || !("proxyTls" in options)) {
    return undefined;
  }
  return isProxyTlsRecord(options.proxyTls) ? options.proxyTls : undefined;
}

function readProxyUrlFromOptions(options: object | undefined): string | undefined {
  if (!options) {
    return undefined;
  }
  if ("uri" in options) {
    const uri: unknown = Reflect.get(options, "uri");
    return uri instanceof URL ? uri.href : typeof uri === "string" ? uri : undefined;
  }
  if ("httpsProxy" in options || "httpProxy" in options) {
    const httpsProxy: unknown = Reflect.get(options, "httpsProxy");
    const httpProxy: unknown = Reflect.get(options, "httpProxy");
    return typeof httpsProxy === "string"
      ? httpsProxy
      : typeof httpProxy === "string"
        ? httpProxy
        : undefined;
  }
  return undefined;
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).href;
  } catch {
    return undefined;
  }
}

type ManagedProxyTlsEnv = NodeJS.ProcessEnv;

type ResolveActiveManagedProxyTlsOptionsParams = {
  proxyUrl?: string;
  env?: ManagedProxyTlsEnv;
};

type AddActiveManagedProxyTlsOptionsParams = {
  env?: ManagedProxyTlsEnv;
};

function resolveManagedProxyUrl(env: ManagedProxyTlsEnv = process.env): string | undefined {
  const activeProxyUrl = getActiveManagedProxyUrl();
  if (activeProxyUrl) {
    return activeProxyUrl.href;
  }
  if (env["OPENCLAW_PROXY_ACTIVE"] !== "1") {
    return undefined;
  }
  // Child processes inherit only env, so recover the managed proxy URL from
  // HTTPS proxy settings when the active in-process registration is absent.
  return normalizeProxyUrl(resolveEnvHttpProxyUrl("https", env));
}

/** Resolves managed proxy TLS trust only when the target proxy is OpenClaw's active proxy. */
export function resolveActiveManagedProxyTlsOptions(
  params?: ResolveActiveManagedProxyTlsOptionsParams,
): ManagedProxyTlsOptions | undefined {
  const env = params?.env ?? process.env;
  const managedProxyUrl = resolveManagedProxyUrl(env);
  const targetProxyUrl = normalizeProxyUrl(
    params?.proxyUrl ?? resolveEnvHttpProxyUrl("https", env),
  );
  if (!managedProxyUrl || targetProxyUrl !== managedProxyUrl) {
    return undefined;
  }
  const activeProxyTls = getActiveManagedProxyTlsOptions();
  if (activeProxyTls) {
    return activeProxyTls;
  }
  const proxyCaFile = resolveManagedProxyCaFileForUrl({
    proxyUrl: managedProxyUrl,
    caFileOverride: env["OPENCLAW_PROXY_CA_FILE"],
  });
  try {
    return loadManagedProxyTlsOptionsSync(proxyCaFile);
  } catch {
    // Missing inherited CA files should not break non-managed or caller-owned proxies.
    return undefined;
  }
}

/** Adds active managed proxy TLS options to env proxy agent options. */
export function addActiveManagedProxyTlsOptions(
  options: undefined,
  params?: AddActiveManagedProxyTlsOptionsParams,
): { proxyTls: ManagedProxyTlsOptions } | undefined;
/** Adds active managed proxy TLS options to explicit proxy agent options. */
export function addActiveManagedProxyTlsOptions<TOptions extends object>(
  options: TOptions,
  params?: AddActiveManagedProxyTlsOptionsParams,
): TOptions | (TOptions & { proxyTls: Record<string, unknown> });
export function addActiveManagedProxyTlsOptions<TOptions extends object>(
  options: TOptions | undefined,
  params?: AddActiveManagedProxyTlsOptionsParams,
):
  | TOptions
  | (TOptions & { proxyTls: Record<string, unknown> })
  | {
      proxyTls: ManagedProxyTlsOptions;
    }
  | undefined;
export function addActiveManagedProxyTlsOptions<TOptions extends object>(
  options: TOptions | undefined,
  params?: AddActiveManagedProxyTlsOptionsParams,
):
  | TOptions
  | (TOptions & { proxyTls: Record<string, unknown> })
  | { proxyTls: ManagedProxyTlsOptions }
  | undefined {
  const proxyTls = resolveActiveManagedProxyTlsOptions({
    proxyUrl: readProxyUrlFromOptions(options),
    env: params?.env,
  });
  if (!proxyTls) {
    return options;
  }
  const existingProxyTls = readProxyTlsRecord(options);
  // Caller-supplied proxyTls wins over managed defaults so explicit TLS policy
  // is not overwritten while still inheriting missing managed CA fields.
  return {
    ...options,
    proxyTls: {
      ...proxyTls,
      ...existingProxyTls,
    },
  };
}

/** Resolves env proxy options with managed proxy TLS attached when applicable. */
export function resolveManagedEnvHttpProxyAgentOptions(
  env: NodeJS.ProcessEnv = process.env,
): ManagedEnvHttpProxyAgentOptions | undefined {
  return addActiveManagedProxyTlsOptions(resolveEnvHttpProxyAgentOptions(env), { env });
}
