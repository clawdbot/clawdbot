/** CLI runner for node-host stdin/stdout command dispatch. */
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { startGatewayClientWhenEventLoopReady } from "../gateway/client-start-readiness.js";
import {
  GatewayClient,
  GatewayClientRequestError,
  type GatewayReconnectPausedInfo,
} from "../gateway/client.js";
import { resolveGatewayConnectionAuth } from "../gateway/connection-auth.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { VERSION } from "../version.js";
import { ensureNodeHostConfig, saveNodeHostConfig, type NodeHostGatewayConfig } from "./config.js";
import { coerceNodeInvokeCancelPayload, coerceNodeInvokePayload } from "./invoke-payload.js";
import { buildNodeInvokeResultParams } from "./invoke.js";
import { prepareNodeHostRuntime, type NodeHostInventory } from "./runtime.js";

export { buildNodeInvokeResultParams };

type NodeHostRunOptions = {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprint?: string;
  /** Optional WebSocket context path (e.g. "/openclaw-gw"). */
  gatewayContextPath?: string;
  nodeId?: string;
  displayName?: string;
};

export function resolveNodeHostGatewayPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

export function resolveNodeHostGatewayDeviceFamily(platform: NodeJS.Platform): string | undefined {
  switch (platform) {
    case "darwin":
      return "Mac";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return undefined;
  }
}

function writeStderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

const NODE_HOST_EXIT_ON_RECONNECT_PAUSE_CODES: ReadonlySet<string> = new Set([
  ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
  ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
  ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
  ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH,
]);

type NodeHostReconnectPausedDeps = {
  writeLine?: (message: string) => void;
  exit?: (code: number) => void;
};

export function shouldExitNodeHostOnReconnectPaused(detailCode: string | null): boolean {
  return detailCode !== null && NODE_HOST_EXIT_ON_RECONNECT_PAUSE_CODES.has(detailCode);
}

function formatNodeHostReconnectPausedMessage(
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

function isUnsupportedNodePluginToolsUpdateError(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("unknown method: node.pluginTools.update")
  );
}

function isUnsupportedNodeSkillsUpdateError(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("unknown method: node.skills.update")
  );
}

async function publishNodePluginTools(client: GatewayClient, tools: unknown[]): Promise<void> {
  if (tools.length === 0) {
    return;
  }
  try {
    await client.request("node.pluginTools.update", { tools });
  } catch (error) {
    if (isUnsupportedNodePluginToolsUpdateError(error)) {
      return;
    }
    writeStderrLine(`node host plugin tool publish failed: ${String(error)}`);
  }
}

async function publishNodeSkills(client: GatewayClient, skills: unknown[]): Promise<void> {
  try {
    await client.request("node.skills.update", { skills });
  } catch (error) {
    if (isUnsupportedNodeSkillsUpdateError(error)) {
      return;
    }
    writeStderrLine(`node host skill publish failed: ${String(error)}`);
  }
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
    contextPath: opts.gatewayContextPath,
  };
  config.gateway = gateway;
  await saveNodeHostConfig(config);

  const cfg = getRuntimeConfig();
  const preparedRuntime = await prepareNodeHostRuntime({
    config: cfg,
    env: process.env,
    enableAgentRuns: true,
  });
  const { token, password } = await resolveNodeHostGatewayCredentials({
    config: cfg,
    env: process.env,
  });

  const host = gateway.host ?? "127.0.0.1";
  const port = gateway.port ?? 18789;
  const scheme = gateway.tls ? "wss" : "ws";
  const contextPath = gateway.contextPath
    ? gateway.contextPath.startsWith("/")
      ? gateway.contextPath
      : `/${gateway.contextPath}`
    : "";
  const url = `${scheme}://${host}:${port}${contextPath}`;
  let inventory: NodeHostInventory = preparedRuntime.initialInventory;
  let gatewayHelloReceived = false;

  const publishInventory = () => {
    if (!gatewayHelloReceived) {
      return;
    }
    if (inventory.skills) {
      void publishNodeSkills(client, inventory.skills);
    }
    void publishNodePluginTools(client, inventory.pluginTools);
  };

  const client = new GatewayClient({
    url,
    token: token || undefined,
    password: password || undefined,
    preauthHandshakeTimeoutMs: cfg.gateway?.handshakeTimeoutMs,
    instanceId: nodeId,
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: displayName,
    clientVersion: VERSION,
    platform: resolveNodeHostGatewayPlatform(process.platform),
    deviceFamily: resolveNodeHostGatewayDeviceFamily(process.platform),
    mode: GATEWAY_CLIENT_MODES.NODE,
    role: "node",
    scopes: [],
    // Pair the built-in MCP command family up front. Server inventory is
    // restart-scoped availability, not a capability upgrade requiring re-pairing.
    caps: preparedRuntime.manifest.caps,
    commands: preparedRuntime.manifest.commands,
    pathEnv: preparedRuntime.manifest.pathEnv,
    permissions: undefined,
    deviceIdentity: loadOrCreateDeviceIdentity(),
    tlsFingerprint: gateway.tlsFingerprint,
    onEvent: (evt) => {
      if (evt.event === "node.invoke.cancel") {
        const payload = coerceNodeInvokeCancelPayload(evt.payload);
        if (payload) {
          activeRuntime.cancel(payload.invokeId);
        }
        return;
      }
      if (evt.event !== "node.invoke.request") {
        return;
      }
      const payload = coerceNodeInvokePayload(evt.payload);
      if (!payload) {
        return;
      }
      void activeRuntime.invoke(payload);
    },
    onHelloOk: () => {
      writeStderrLine(`node host gateway connected: ${url}`);
      gatewayHelloReceived = true;
      publishInventory();
    },
    onConnectError: (err) => {
      // keep retrying (handled by GatewayClient)
      writeStderrLine(`node host gateway connect failed: ${err.message}`);
    },
    onReconnectPaused: (info) => {
      handleNodeHostReconnectPaused(info, {
        exit: (code) => {
          client.stop();
          // Terminal auth/version pauses restart under a supervisor; close MCP
          // subprocesses first so restart loops cannot orphan server processes.
          void activeRuntime.close().finally(() => process.exit(code));
        },
      });
    },
    onClose: (code, reason) => {
      activeRuntime.cancelAll();
      writeStderrLine(`node host gateway closed (${code}): ${reason}`);
    },
  });
  const activeRuntime = preparedRuntime.start({
    client,
    onInventoryChanged: (nextInventory) => {
      inventory = nextInventory;
      publishInventory();
    },
  });

  let stopping = false;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  // A pending Promise alone does not keep Node alive. Pairing pauses can close
  // the last socket, so retain a handle until a signal finishes the foreground host.
  const lifetimeInterval = setInterval(() => {}, 1_000_000);
  const removeSignalHandlers = () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
  const stopClientAndMcp = async () => {
    client.stop();
    try {
      await activeRuntime.close();
    } finally {
      clearInterval(lifetimeInterval);
    }
  };
  const finish = async (exitCode: number) => {
    if (stopping) {
      return;
    }
    stopping = true;
    removeSignalHandlers();
    try {
      await stopClientAndMcp();
    } finally {
      process.exitCode = exitCode;
      resolveStopped?.();
    }
  };
  const onSigint = () => void finish(130);
  const onSigterm = () => void finish(143);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const readinessPromise = startGatewayClientWhenEventLoopReady(client, {
    clientOptions: { preauthHandshakeTimeoutMs: cfg.gateway?.handshakeTimeoutMs },
  });
  let readiness;
  try {
    readiness = await readinessPromise;
  } catch (error) {
    if (stopping) {
      await stopped;
      return;
    }
    removeSignalHandlers();
    await stopClientAndMcp();
    throw error;
  }
  if (!readiness.ready) {
    if (stopping) {
      await stopped;
      return;
    }
    removeSignalHandlers();
    await stopClientAndMcp();
    throw new Error("node host gateway event loop readiness timeout");
  }
  await stopped;
}
