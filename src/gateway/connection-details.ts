// Gateway connection detail builder for CLI/user-facing target diagnostics.
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveConfigPath, resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { isSecureWebSocketUrl } from "./net.js";

/** Resolved gateway target plus redacted display text for diagnostics. */
export type GatewayConnectionDetails = {
  url: string;
  urlSource: string;
  bindDetail?: string;
  remoteFallbackNote?: string;
  message: string;
};

export type GatewayConnectionTarget = "local" | "remote";

/** Resolve the configured Gateway owner before a caller crosses the RPC boundary. */
export function resolveDefaultGatewayConnectionTarget(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): GatewayConnectionTarget {
  if (normalizeOptionalString((params.env ?? process.env).OPENCLAW_GATEWAY_URL)) {
    // An ambient override may be a tunnel or another machine even when its URL
    // looks loopback-local, so only the remote Gateway may own its durable state.
    return "remote";
  }
  return params.config.gateway?.mode === "remote" &&
    normalizeOptionalString(params.config.gateway.remote?.url)
    ? "remote"
    : "local";
}

/** Project raw transport details into the credential-safe CLI/report shape. */
export function projectGatewayConnectionDetailsForDiagnostics(
  details: GatewayConnectionDetails,
): GatewayConnectionDetails {
  return {
    ...details,
    url: redactSensitiveUrlLikeString(details.url),
    message: redactSensitiveUrlLikeString(details.message),
  };
}

/** Redact one Gateway URL before it crosses an operator-visible diagnostic boundary. */
export function projectGatewayUrlForDiagnostics(url: string): string {
  return redactSensitiveUrlLikeString(url);
}

type GatewayConnectionDetailResolvers = {
  getRuntimeConfig?: () => OpenClawConfig;
  resolveConfigPath?: (env: NodeJS.ProcessEnv) => string;
  resolveGatewayPort?: (cfg?: OpenClawConfig, env?: NodeJS.ProcessEnv) => number;
};

/** Build gateway target details and reject unsafe remote plaintext websocket URLs. */
export function buildGatewayConnectionDetailsWithResolvers(
  options: {
    config?: OpenClawConfig;
    url?: string;
    configPath?: string;
    urlSource?: "cli" | "env";
    ignoreEnvUrlOverride?: boolean;
    localPortOverride?: number;
  } = {},
  resolvers: GatewayConnectionDetailResolvers = {},
): GatewayConnectionDetails {
  const config = options.config ?? resolvers.getRuntimeConfig?.() ?? {};
  const configPath =
    options.configPath ??
    resolvers.resolveConfigPath?.(process.env) ??
    resolveConfigPath(process.env);
  const isRemoteMode = options.localPortOverride === undefined && config.gateway?.mode === "remote";
  const remote = isRemoteMode ? config.gateway?.remote : undefined;
  const tlsEnabled = config.gateway?.tls?.enabled === true;
  const localPort =
    options.localPortOverride ??
    resolvers.resolveGatewayPort?.(config, process.env) ??
    resolveGatewayPort(config);
  const bindMode = config.gateway?.bind ?? "loopback";
  const scheme = tlsEnabled ? "wss" : "ws";
  const localUrl = `${scheme}://127.0.0.1:${localPort}`;
  const cliUrlOverride = normalizeOptionalString(options.url);
  const envUrlOverride =
    cliUrlOverride || options.ignoreEnvUrlOverride || options.localPortOverride !== undefined
      ? undefined
      : normalizeOptionalString(process.env.OPENCLAW_GATEWAY_URL);
  const urlOverride = cliUrlOverride ?? envUrlOverride;
  const remoteUrl = normalizeOptionalString(remote?.url);
  const remoteMisconfigured = isRemoteMode && !urlOverride && !remoteUrl;
  const urlSourceHint =
    options.urlSource ?? (cliUrlOverride ? "cli" : envUrlOverride ? "env" : undefined);
  const url = urlOverride || remoteUrl || localUrl;
  const displayUrl = redactSensitiveUrlLikeString(url);
  const urlSource = urlOverride
    ? urlSourceHint === "env"
      ? "env OPENCLAW_GATEWAY_URL"
      : "cli --url"
    : remoteUrl
      ? "config gateway.remote.url"
      : remoteMisconfigured
        ? "missing gateway.remote.url (fallback local)"
        : "local loopback";
  const bindDetail = !urlOverride && !remoteUrl ? `Bind: ${bindMode}` : undefined;
  const remoteFallbackNote = remoteMisconfigured
    ? "Warn: gateway.mode=remote but gateway.remote.url is missing; set gateway.remote.url or switch gateway.mode=local."
    : undefined;

  const allowPrivateWs = process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1";
  if (!isSecureWebSocketUrl(url, { allowPrivateWs })) {
    throw new Error(
      [
        `SECURITY ERROR: Gateway URL "${displayUrl}" uses plaintext ws:// to a non-loopback address.`,
        "Both credentials and chat data would be exposed to network interception.",
        `Source: ${urlSource}`,
        `Config: ${configPath}`,
        "Fix: Use wss:// for remote gateway URLs.",
        "Safe remote access defaults:",
        "- keep gateway.bind=loopback and use an SSH tunnel (ssh -N -L 18789:127.0.0.1:18789 user@gateway-host)",
        "- or use Tailscale Serve/Funnel for HTTPS remote access",
        allowPrivateWs
          ? undefined
          : "Break-glass (trusted private networks only): set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1",
        "Doctor: openclaw doctor --fix",
        "Docs: https://docs.openclaw.ai/gateway/remote",
      ].join("\n"),
    );
  }

  const message = [
    `Gateway target: ${displayUrl}`,
    `Source: ${urlSource}`,
    `Config: ${configPath}`,
    bindDetail,
    remoteFallbackNote,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    url,
    urlSource,
    bindDetail,
    remoteFallbackNote,
    message,
  };
}
