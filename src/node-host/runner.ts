import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { startGatewayClientWhenEventLoopReady } from "../gateway/client-start-readiness.js";
import { GatewayClient, type GatewayReconnectPausedInfo } from "../gateway/client.js";
import { resolveGatewayConnectionAuth } from "../gateway/connection-auth.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import { ConnectErrorDetailCodes } from "../gateway/protocol/connect-error-details.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import type { SkillBinTrustEntry } from "../infra/exec-approvals.js";
import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { NODE_EXEC_APPROVALS_COMMANDS, NODE_SYSTEM_RUN_COMMANDS } from "../infra/node-commands.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { VERSION } from "../version.js";
import { ensureNodeHostConfig, saveNodeHostConfig, type NodeHostGatewayConfig } from "./config.js";
import {
  coerceNodeInvokePayload,
  type SkillBinsProvider,
  buildNodeInvokeResultParams,
  handleInvoke,
} from "./invoke.js";
import {
  ensureNodeHostPluginRegistry,
  listRegisteredNodeHostCapsAndCommands,
} from "./plugin-node-host.js";

export { buildNodeInvokeResultParams };

type NodeHostRunOptions = {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
};

const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function writeStderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

const NODE_HOST_EXIT_ON_RECONNECT_PAUSE_CODES: ReadonlySet<string> = new Set([
  ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
  ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
  ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
]);

type NodeHostReconnectPausedDeps = {
  writeLine?: (message: string) => void;
  exit?: (code: number) => never;
};

export function shouldExitNodeHostOnReconnectPaused(detailCode: string | null): boolean {
  return detailCode !== null && NODE_HOST_EXIT_ON_RECONNECT_PAUSE_CODES.has(detailCode);
}

export function formatNodeHostReconnectPausedMessage(
  info: GatewayReconnectPausedInfo,
  params?: { exiting?: boolean },
): string {
  const detail = info.detailCode ? ` detail=${info.detailCode}` : "";
  const reason = info.reason.trim() || "no close reason";
  const action = params?.exiting ? "exiting for supervisor restart" : "waiting for operator action";
  return `node host gateway reconnect paused after close (${info.code}): ${reason}${detail}; ${action}`;
}

export function handleNodeHostReconnectPaused(
  info: GatewayReconnectPausedInfo,
  deps: NodeHostReconnectPausedDeps = {},
): void {
  const shouldExit = shouldExitNodeHostOnReconnectPaused(info.detailCode);
  const writeLine = deps.writeLine ?? writeStderrLine;
  writeLine(formatNodeHostReconnectPausedMessage(info, { exiting: shouldExit }));
  if (!shouldExit) {
    return;
  }
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  exit(1);
}

function resolveExecutablePathFromEnv(bin: string, pathEnv: string): string | null {
  if (bin.includes("/") || bin.includes("\\")) {
    return null;
  }
  return resolveExecutableFromPathEnv(bin, pathEnv) ?? null;
}

function resolveSkillBinTrustEntries(bins: string[], pathEnv: string): SkillBinTrustEntry[] {
  const trustEntries: SkillBinTrustEntry[] = [];
  const seen = new Set<string>();
  for (const bin of bins) {
    const name = bin.trim();
    if (!name) {
      continue;
    }
    const resolvedPath = resolveExecutablePathFromEnv(name, pathEnv);
    if (!resolvedPath) {
      continue;
    }
    const key = `${name}\u0000${resolvedPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    trustEntries.push({ name, resolvedPath });
  }
  return trustEntries.toSorted(
    (left, right) =>
      left.name.localeCompare(right.name) || left.resolvedPath.localeCompare(right.resolvedPath),
  );
}

class SkillBinsCache implements SkillBinsProvider {
  private bins: SkillBinTrustEntry[] = [];
  private lastRefresh = 0;
  private readonly ttlMs = 90_000;
  private readonly fetch: () => Promise<string[]>;
  private readonly pathEnv: string;

  constructor(fetch: () => Promise<string[]>, pathEnv: string) {
    this.fetch = fetch;
    this.pathEnv = pathEnv;
  }

  async current(force = false): Promise<SkillBinTrustEntry[]> {
    if (force || Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
    return this.bins;
  }

  private async refresh() {
    try {
      const bins = await this.fetch();
      this.bins = resolveSkillBinTrustEntries(bins, this.pathEnv);
      this.lastRefresh = Date.now();
    } catch {
      if (!this.lastRefresh) {
        this.bins = [];
      }
    }
  }
}

function ensureNodePathEnv(): string {
  ensureOpenClawCliOnPath({ pathEnv: process.env.PATH ?? "" });
  const current = process.env.PATH ?? "";
  if (current.trim()) {
    return current;
  }
  process.env.PATH = DEFAULT_NODE_PATH;
  return DEFAULT_NODE_PATH;
}

export async function resolveNodeHostGatewayCredentials(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ token?: string; password?: string }> {
  const mode = params.config.gateway?.mode === "remote" ? "remote" : "local";
  const configForResolution =
    mode === "local" ? buildNodeHostLocalAuthConfig(params.config) : params.config;
  return await resolveGatewayConnectionAuth({
    config: configForResolution,
    env: params.env,
    localTokenPrecedence: "env-first",
    localPasswordPrecedence: "env-first", // pragma: allowlist secret
    remoteTokenPrecedence: "env-first",
    remotePasswordPrecedence: "env-first", // pragma: allowlist secret
  });
}

function buildNodeHostLocalAuthConfig(config: OpenClawConfig): OpenClawConfig {
  if (!config.gateway?.remote?.token && !config.gateway?.remote?.password) {
    return config;
  }
  const nextConfig = structuredClone(config);
  if (nextConfig.gateway?.remote) {
    // Local node-host must not inherit gateway.remote.* auth material, which can
    // suppress GatewayClient device-token fallback and cause local token mismatches.
    nextConfig.gateway.remote.token = undefined;
    nextConfig.gateway.remote.password = undefined;
  }
  return nextConfig;
}

export async function runNodeHost(opts: NodeHostRunOptions): Promise<void> {
  const config = await ensureNodeHostConfig();
  const nodeId = opts.nodeId?.trim() || config.nodeId;
  if (nodeId !== config.nodeId) {
    config.nodeId = nodeId;
  }
  const displayName =
    opts.displayName?.trim() || config.displayName || (await getMachineDisplayName());
  config.displayName = displayName;

  const gateway: NodeHostGatewayConfig = {
    host: opts.gatewayHost,
    port: opts.gatewayPort,
    tls: opts.gatewayTls ?? getRuntimeConfig().gateway?.tls?.enabled ?? false,
    tlsFingerprint: opts.gatewayTlsFingerprint,
  };
  config.gateway = gateway;
  await saveNodeHostConfig(config);

  const cfg = getRuntimeConfig();
  await ensureNodeHostPluginRegistry({ config: cfg, env: process.env });
  const pluginNodeHost = listRegisteredNodeHostCapsAndCommands();
  const { token, password } = await resolveNodeHostGatewayCredentials({
    config: cfg,
    env: process.env,
  });

  const host = gateway.host ?? "127.0.0.1";
  const port = gateway.port ?? 18789;
  const scheme = gateway.tls ? "wss" : "ws";
  const url = `${scheme}://${host}:${port}`;
  const pathEnv = ensureNodePathEnv();

  const client = new GatewayClient({
    url,
    token: token || undefined,
    password: password || undefined,
    preauthHandshakeTimeoutMs: cfg.gateway?.handshakeTimeoutMs,
    instanceId: nodeId,
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: displayName,
    clientVersion: VERSION,
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.NODE,
    role: "node",
    scopes: [],
    caps: ["system", ...pluginNodeHost.caps],
    commands: [
      ...NODE_SYSTEM_RUN_COMMANDS,
      ...NODE_EXEC_APPROVALS_COMMANDS,
      ...pluginNodeHost.commands,
    ],
    pathEnv,
    permissions: undefined,
    deviceIdentity: loadOrCreateDeviceIdentity(),
    tlsFingerprint: gateway.tlsFingerprint,
    onEvent: (evt) => {
      if (evt.event !== "node.invoke.request") {
        return;
      }
      const payload = coerceNodeInvokePayload(evt.payload);
      if (!payload) {
        return;
      }
      void handleInvoke(payload, client, skillBins);
    },
    onConnectError: (err) => {
      // keep retrying (handled by GatewayClient)
      writeStderrLine(`node host gateway connect failed: ${err.message}`);
    },
    onReconnectPaused: (info) => {
      handleNodeHostReconnectPaused(info);
    },
    onClose: (code, reason) => {
      writeStderrLine(`node host gateway closed (${code}): ${reason}`);
    },
  });

  const skillBins = new SkillBinsCache(async () => {
    const res = await client.request<{ bins: Array<unknown> }>("skills.bins", {});
    const bins = Array.isArray(res?.bins) ? res.bins.map((bin) => String(bin)) : [];
    return bins;
  }, pathEnv);

  const readiness = await startGatewayClientWhenEventLoopReady(client, {
    clientOptions: { preauthHandshakeTimeoutMs: cfg.gateway?.handshakeTimeoutMs },
  });
  if (!readiness.ready) {
    throw new Error("node host gateway event loop readiness timeout");
  }
  await new Promise(() => {});
}
