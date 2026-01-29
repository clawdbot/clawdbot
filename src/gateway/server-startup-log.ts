import chalk from "chalk";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import type { loadConfig } from "../config/config.js";
import { getResolvedLoggerSettings } from "../logging.js";
import { DEFAULT_GATEWAY_AUTH_MIN_LENGTH, resolveGatewayAuth } from "./auth.js";

export function logGatewayStartup(params: {
  cfg: ReturnType<typeof loadConfig>;
  bindHost: string;
  bindHosts?: string[];
  port: number;
  tlsEnabled?: boolean;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void; warn?: (msg: string) => void };
  isNixMode: boolean;
}) {
  const { provider: agentProvider, model: agentModel } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const modelRef = `${agentProvider}/${agentModel}`;
  params.log.info(`agent model: ${modelRef}`, {
    consoleMessage: `agent model: ${chalk.whiteBright(modelRef)}`,
  });
  const scheme = params.tlsEnabled ? "wss" : "ws";
  const formatHost = (host: string) => (host.includes(":") ? `[${host}]` : host);
  const hosts =
    params.bindHosts && params.bindHosts.length > 0 ? params.bindHosts : [params.bindHost];
  const primaryHost = hosts[0] ?? params.bindHost;
  params.log.info(
    `listening on ${scheme}://${formatHost(primaryHost)}:${params.port} (PID ${process.pid})`,
  );
  for (const host of hosts.slice(1)) {
    params.log.info(`listening on ${scheme}://${formatHost(host)}:${params.port}`);
  }
  params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
  const minAuthLength = params.cfg.gateway?.auth?.minLength ?? DEFAULT_GATEWAY_AUTH_MIN_LENGTH;
  const tailscaleMode = params.cfg.gateway?.tailscale?.mode ?? "off";
  const resolvedAuth = resolveGatewayAuth({
    authConfig: params.cfg.gateway?.auth,
    env: process.env,
    tailscaleMode,
  });
  const tokenLength = resolvedAuth.token?.trim().length ?? 0;
  const passwordLength = resolvedAuth.password?.trim().length ?? 0;
  const activeLength = resolvedAuth.mode === "password" ? passwordLength : tokenLength;
  const label = resolvedAuth.mode === "password" ? "password" : "token";
  if (activeLength > 0) {
    const message = `gateway auth: ${label} length ${activeLength} (min ${minAuthLength})`;
    if (activeLength < minAuthLength) {
      params.log.warn?.(`${message} - weak`);
    } else {
      params.log.info(`${message} - ok`);
    }
  } else if (resolvedAuth.allowTailscale && tailscaleMode === "serve") {
    params.log.info("gateway auth: tailscale serve identity allowed (no shared secret configured)");
  } else {
    params.log.warn?.("gateway auth: no shared secret configured");
  }
  if (params.isNixMode) {
    params.log.info("gateway: running in Nix mode (config managed externally)");
  }
}
