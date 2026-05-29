import type { Agent as HttpAgent } from "node:http";
import { createRequire } from "node:module";
import { matchesNoProxy, resolveEnvHttpProxyAgentOptions } from "./proxy-env.js";
import { resolveActiveManagedProxyTlsOptions } from "./proxy/managed-proxy-undici.js";

export const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE =
  "Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";

type NodeProxyProtocol = "http" | "https";
type ProxylineCreateAmbientNodeProxyAgent =
  typeof import("@openclaw/proxyline").createAmbientNodeProxyAgent;
type ProxylineAgentOptions = NonNullable<Parameters<ProxylineCreateAmbientNodeProxyAgent>[0]>;
type ProxylineEnvSnapshot = NonNullable<ProxylineAgentOptions["env"]>;
type ProxylineTlsOptions = ProxylineAgentOptions["proxyTls"];

const require = createRequire(import.meta.url);

export type CreateNodeProxyAgentOptions =
  | {
      mode: "env";
      targetUrl: string | URL;
      protocol?: NodeProxyProtocol;
    }
  | {
      mode: "explicit";
      proxyUrl: string | URL;
      protocol?: NodeProxyProtocol;
    };

function inferTargetProtocol(targetUrl: string | URL): NodeProxyProtocol | undefined {
  const parsed = parseTargetUrl(targetUrl);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "ws:") {
    return "http";
  }
  if (parsed.protocol === "https:" || parsed.protocol === "wss:") {
    return "https";
  }
  return undefined;
}

function parseTargetUrl(targetUrl: string | URL): URL | undefined {
  let parsed: URL;
  try {
    parsed = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
  } catch {
    return undefined;
  }
  return parsed;
}

function formatNoProxyTargetUrl(targetUrl: string | URL): string | undefined {
  const target = parseTargetUrl(targetUrl);
  if (target === undefined) {
    return undefined;
  }
  const parsed = new URL(target.href);
  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }
  return parsed.href;
}

function proxyUrlWithDefaultScheme(proxyUrl: string, protocol: NodeProxyProtocol): URL {
  const withScheme = proxyUrl.includes("://") ? proxyUrl : `${protocol}://${proxyUrl}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch (error) {
    throw new Error(
      `Invalid proxy URL ${JSON.stringify(proxyUrl)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${parsed.protocol}`);
  }
  return parsed;
}

function fixedProxyEnv(proxyUrl: URL): ProxylineEnvSnapshot {
  const href = proxyUrl.href;
  return {
    HTTP_PROXY: href,
    HTTPS_PROXY: href,
    ALL_PROXY: undefined,
    NO_PROXY: undefined,
    http_proxy: undefined,
    https_proxy: undefined,
    all_proxy: undefined,
    no_proxy: undefined,
  };
}

function loadCreateAmbientNodeProxyAgent(): ProxylineCreateAmbientNodeProxyAgent {
  return (require("@openclaw/proxyline") as typeof import("@openclaw/proxyline"))
    .createAmbientNodeProxyAgent;
}

export function resolveEnvNodeProxyUrlForTarget(
  targetUrl: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): URL | undefined {
  const protocol = inferTargetProtocol(targetUrl);
  if (protocol === undefined) {
    return undefined;
  }
  const formattedTarget = formatNoProxyTargetUrl(targetUrl);
  if (formattedTarget === undefined) {
    return undefined;
  }
  if (matchesNoProxy(formattedTarget, env)) {
    return undefined;
  }
  const proxyOptions = resolveEnvHttpProxyAgentOptions(env);
  const proxyUrl = protocol === "https" ? proxyOptions?.httpsProxy : proxyOptions?.httpProxy;
  return proxyUrl ? proxyUrlWithDefaultScheme(proxyUrl, protocol) : undefined;
}

function createFixedNodeProxyAgent(
  proxyUrl: string | URL,
  options: {
    protocol?: NodeProxyProtocol;
    proxyTls?: ProxylineTlsOptions;
  } = {},
): HttpAgent {
  const parsedProxyUrl =
    proxyUrl instanceof URL
      ? proxyUrl
      : proxyUrlWithDefaultScheme(proxyUrl, options.protocol ?? "https");
  const agent = loadCreateAmbientNodeProxyAgent()({
    env: fixedProxyEnv(parsedProxyUrl),
    protocol: options.protocol ?? "https",
    ...(options.proxyTls !== undefined ? { proxyTls: options.proxyTls } : {}),
  });
  if (agent === undefined) {
    throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${parsedProxyUrl.protocol}`);
  }
  return agent as HttpAgent;
}

export function createNodeProxyAgent(
  options: Extract<CreateNodeProxyAgentOptions, { mode: "explicit" }>,
): HttpAgent;
export function createNodeProxyAgent(
  options: Extract<CreateNodeProxyAgentOptions, { mode: "env" }>,
): HttpAgent | undefined;
export function createNodeProxyAgent(options: CreateNodeProxyAgentOptions): HttpAgent | undefined {
  if (options.mode === "explicit") {
    return createFixedNodeProxyAgent(options.proxyUrl, { protocol: options.protocol });
  }
  return createEnvNodeProxyAgentForTarget(options.targetUrl, { protocol: options.protocol });
}

function createEnvNodeProxyAgentForTarget(
  targetUrl: string | URL,
  options: {
    protocol?: NodeProxyProtocol;
  } = {},
): HttpAgent | undefined {
  const proxyUrl = resolveEnvNodeProxyUrlForTarget(targetUrl);
  if (proxyUrl === undefined) {
    return undefined;
  }
  return createFixedNodeProxyAgent(proxyUrl, {
    protocol: options.protocol ?? inferTargetProtocol(targetUrl) ?? "https",
    proxyTls: resolveActiveManagedProxyTlsOptions({ proxyUrl: proxyUrl.href }),
  });
}

export function createFixedNodeProxyAgentPair(proxyUrl: string | URL): {
  httpAgent: HttpAgent;
  httpsAgent: HttpAgent;
} {
  const parsedProxyUrl =
    proxyUrl instanceof URL ? proxyUrl : proxyUrlWithDefaultScheme(proxyUrl, "https");
  const proxyTls = resolveActiveManagedProxyTlsOptions({ proxyUrl: parsedProxyUrl.href });
  return {
    httpAgent: createFixedNodeProxyAgent(parsedProxyUrl, { protocol: "http", proxyTls }),
    httpsAgent: createFixedNodeProxyAgent(parsedProxyUrl, { protocol: "https", proxyTls }),
  };
}
