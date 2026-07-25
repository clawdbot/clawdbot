// Bridges OpenClaw-managed proxy TLS trust into Undici EnvHttpProxyAgent and
// explicit ProxyAgent options without changing unrelated operator proxies.
import { isRecord as isProxyTlsRecord } from "@openclaw/normalization-core/record-coerce";
import type { EnvHttpProxyAgent } from "undici";
import { resolveEnvHttpProxyAgentOptions } from "../proxy-env.js";
import { resolveActiveManagedProxyTlsOptions } from "./active-managed-proxy-tls.js";
import type { ManagedProxyTlsOptions } from "./proxy-tls.js";

export { resolveActiveManagedProxyTlsOptions } from "./active-managed-proxy-tls.js";

type ManagedEnvHttpProxyAgentOptions = ConstructorParameters<typeof EnvHttpProxyAgent>[0];

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

type ManagedProxyTlsEnv = NodeJS.ProcessEnv;

type AddActiveManagedProxyTlsOptionsParams = {
  env?: ManagedProxyTlsEnv;
};

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
