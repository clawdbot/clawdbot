// Node proxy agent helpers adapt env or explicit proxy settings for libraries
// that need node:http Agent instances.
import type { Agent as HttpAgent, AgentOptions as HttpAgentOptions } from "node:http";
import type { AgentOptions as HttpsAgentOptions } from "node:https";
import { createRequire } from "node:module";
import { matchesNoProxy, resolveEnvHttpProxyAgentOptions } from "./proxy-env.js";
import { resolveActiveManagedProxyTlsOptions } from "./proxy/active-managed-proxy-tls.js";

const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE =
  "Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";

type NodeProxyProtocol = "http" | "https";
type ProxylineCreateAmbientNodeProxyAgent =
  typeof import("@openclaw/proxyline").createAmbientNodeProxyAgent;
type ProxylineAgentOptions = NonNullable<Parameters<ProxylineCreateAmbientNodeProxyAgent>[0]>;
type ProxylineEnvSnapshot = NonNullable<ProxylineAgentOptions["env"]>;
type ProxylineTlsOptions = ProxylineAgentOptions["proxyTls"];
type NodeProxyAgentOptions = HttpAgentOptions & HttpsAgentOptions;
type NodeProxyAgentWithOptions = HttpAgent & {
  keepAlive: boolean;
  keepAliveMsecs: number;
  maxFreeSockets: number;
  maxSockets: number;
  maxTotalSockets: number;
  options?: NodeProxyAgentOptions;
  scheduling?: "fifo" | "lifo";
  timeout?: number;
};

const require = createRequire(import.meta.url);

/** Selects either ambient env proxy resolution or a caller-supplied fixed proxy URL. */
export type CreateNodeProxyAgentOptions =
  | {
      mode: "env";
      targetUrl: string | URL;
      protocol?: NodeProxyProtocol;
      agentOptions?: NodeProxyAgentOptions;
    }
  | {
      mode: "explicit";
      proxyUrl: string | URL;
      protocol?: NodeProxyProtocol;
      agentOptions?: NodeProxyAgentOptions;
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
  // WebSocket proxy bypass uses HTTP(S) semantics so NO_PROXY default ports and
  // hostname matching stay aligned with normal requests.
  const target = parseTargetUrl(targetUrl);
  if (target === undefined) {
    return undefined;
  }
  const parsed = new URL(target.href);
  // Bypass matching uses web request semantics. Map WebSocket schemes to the
  // equivalent request schemes so default ports and host rules line up.
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
  // Proxyline's ambient agent only reads env-shaped input. Pin both request
  // scheme slots to the explicit URL and clear bypass rules for a fixed agent.
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

function applyNodeAgentOptions(agent: HttpAgent, options: NodeProxyAgentOptions | undefined): void {
  if (options === undefined) {
    return;
  }
  const agentWithOptions = agent as NodeProxyAgentWithOptions;
  agentWithOptions.options = {
    ...agentWithOptions.options,
    ...options,
  };
  if (typeof options.keepAlive === "boolean") {
    agentWithOptions.keepAlive = options.keepAlive;
  }
  if (typeof options.keepAliveMsecs === "number") {
    agentWithOptions.keepAliveMsecs = options.keepAliveMsecs;
  }
  if (typeof options.maxFreeSockets === "number") {
    agentWithOptions.maxFreeSockets = options.maxFreeSockets;
  }
  if (typeof options.maxSockets === "number") {
    agentWithOptions.maxSockets = options.maxSockets;
  }
  if (typeof options.maxTotalSockets === "number") {
    agentWithOptions.maxTotalSockets = options.maxTotalSockets;
  }
  if (options.scheduling === "fifo" || options.scheduling === "lifo") {
    agentWithOptions.scheduling = options.scheduling;
  }
  if (typeof options.timeout === "number") {
    agentWithOptions.timeout = options.timeout;
  }
}

/** Resolves the env proxy URL that should be used for a specific Node target. */
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
    agentOptions?: NodeProxyAgentOptions;
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
  applyNodeAgentOptions(agent as HttpAgent, options.agentOptions);
  return agent as HttpAgent;
}

/** Creates a Node HTTP(S) agent for explicit proxy URLs; unsupported protocols throw. */
export function createNodeProxyAgent(
  options: Extract<CreateNodeProxyAgentOptions, { mode: "explicit" }>,
): HttpAgent;
/** Creates a Node HTTP(S) agent from env proxy settings, or undefined when bypassed. */
export function createNodeProxyAgent(
  options: Extract<CreateNodeProxyAgentOptions, { mode: "env" }>,
): HttpAgent | undefined;
export function createNodeProxyAgent(options: CreateNodeProxyAgentOptions): HttpAgent | undefined {
  if (options.mode === "explicit") {
    return createFixedNodeProxyAgent(options.proxyUrl, {
      protocol: options.protocol,
      agentOptions: options.agentOptions,
    });
  }
  return createEnvNodeProxyAgentForTarget(options.targetUrl, {
    protocol: options.protocol,
    agentOptions: options.agentOptions,
  });
}

function createEnvNodeProxyAgentForTarget(
  targetUrl: string | URL,
  options: {
    protocol?: NodeProxyProtocol;
    agentOptions?: NodeProxyAgentOptions;
  } = {},
): HttpAgent | undefined {
  const proxyUrl = resolveEnvNodeProxyUrlForTarget(targetUrl);
  if (proxyUrl === undefined) {
    return undefined;
  }
  return createFixedNodeProxyAgent(proxyUrl, {
    protocol: options.protocol ?? inferTargetProtocol(targetUrl) ?? "https",
    proxyTls: resolveActiveManagedProxyTlsOptions({ proxyUrl: proxyUrl.href }),
    agentOptions: options.agentOptions,
  });
}

/** Builds paired HTTP and HTTPS agents for libraries that require both slots. */
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
