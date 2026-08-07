/** CLI runner for node-host stdin/stdout command dispatch. */
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { NODE_INVOKE_SESSION_KEY_ENVELOPE_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/nodes.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { startGatewayClientWhenEventLoopReady } from "../gateway/client-start-readiness.js";
import {
  GatewayClient,
  GatewayClientRequestError,
  type GatewayReconnectPausedInfo,
} from "../gateway/client.js";
import { resolveGatewayCredentialsWithSecretInputs } from "../gateway/credentials-secret-inputs.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { VERSION } from "../version.js";
import { configureNodeHost, type NodeHostGatewayConfig } from "./config.js";
import {
  coerceNodeInvokeCancelPayload,
  coerceNodeInvokeInputPayload,
  coerceNodeInvokePayload,
} from "./invoke-payload.js";
import type { NodeInvokeRequestPayload } from "./invoke-types.js";
import { prepareNodeHostRuntime, type NodeHostInventory } from "./runtime.js";
import { runStartupMigrations } from "./startup-state-migrations.js";

type NodeHostRunOptions = {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprint?: string;
  /** Optional WebSocket context path (e.g. "/openclaw-gw"). */
  gatewayContextPath?: string;
  nodeId?: string;
  displayName?: string;
  installedAppsSharing?: boolean;
};

function resolveNodeHostGatewayPlatform(platform: NodeJS.Platform): string {
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

function resolveNodeHostGatewayDeviceFamily(platform: NodeJS.Platform): string | undefined {
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

function shouldExitNodeHostOnReconnectPaused(detailCode: string | null): boolean {
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

function handleNodeHostReconnectPaused(
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

function isUnsupportedNodeProtocolFeaturesUpdateError(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("unknown method: node.protocolFeatures.update")
  );
}

type NodeInvokeSessionEnvelopeMode = "authoritative" | "legacy";

async function negotiateNodeInvokeSessionEnvelope(
  client: GatewayClient,
): Promise<NodeInvokeSessionEnvelopeMode> {
  try {
    await client.request("node.protocolFeatures.update", {
      features: [NODE_INVOKE_SESSION_KEY_ENVELOPE_PROTOCOL_FEATURE],
    });
    return "authoritative";
  } catch (error) {
    if (isUnsupportedNodeProtocolFeaturesUpdateError(error)) {
      return "legacy";
    }
    writeStderrLine(`node host protocol feature publish failed: ${String(error)}`);
    // Only a confirmed unknown-method response enables the legacy nested field.
    // Other failures keep omitted envelopes fail-closed while the connection lives.
    return "authoritative";
  }
}

async function publishNodePluginTools(client: GatewayClient, tools: unknown[]): Promise<void> {
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

async function resolveNodeHostGatewayCredentials(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ token?: string; password?: string }> {
  const mode = params.config.gateway?.mode === "remote" ? "remote" : "local";
  const configForResolution =
    mode === "local" ? buildNodeHostLocalAuthConfig(params.config) : params.config;
  return await resolveGatewayCredentialsWithSecretInputs({
    config: configForResolution,
    env: params.env,
    localPrecedence: "env-first",
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
  // Operator-approved startup is a second authorized entry point for Doctor-owned
  // state migrators. Runtime invokes those owners here and never migrates inline.
  await runStartupMigrations({ log: { info: writeStderrLine, warn: writeStderrLine } });
  const plannedGateway: NodeHostGatewayConfig = {
    host: opts.gatewayHost,
    port: opts.gatewayPort,
    tls: opts.gatewayTls ?? getRuntimeConfig().gateway?.tls?.enabled ?? false,
    tlsFingerprint: opts.gatewayTlsFingerprint,
    contextPath: opts.gatewayContextPath,
  };
  const fallbackDisplayName = await getMachineDisplayName();
  const config = await configureNodeHost({
    nodeId: opts.nodeId,
    displayName: opts.displayName,
    fallbackDisplayName,
    gateway: plannedGateway,
    installedAppsSharing: opts.installedAppsSharing,
  });
  const nodeId = config.nodeId;
  const displayName = config.displayName ?? fallbackDisplayName;
  const gateway = config.gateway ?? plannedGateway;

  const cfg = getRuntimeConfig();
  const preparedRuntime = await prepareNodeHostRuntime({
    config: cfg,
    env: process.env,
    enableAgentRuns: true,
    installedAppsSharingEnabled: config.installedAppsSharing,
  });
  const { token, password } = await resolveNodeHostGatewayCredentials({
    config: cfg,
    env: process.env,
  });

  const host = gateway.host ?? "127.0.0.1";
  const urlHost =
    host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host;
  const port = gateway.port ?? 18789;
  const scheme = gateway.tls ? "wss" : "ws";
  const contextPath = gateway.contextPath
    ? gateway.contextPath.startsWith("/")
      ? gateway.contextPath
      : `/${gateway.contextPath}`
    : "";
  const url = `${scheme}://${urlHost}:${port}${contextPath}`;
  let inventory: NodeHostInventory = preparedRuntime.initialInventory;
  let gatewayHelloReceived = false;
  let gatewayConnectionGeneration = 0;
  let nodeInvokeSessionEnvelopeMode =
    Promise.resolve<NodeInvokeSessionEnvelopeMode>("authoritative");
  let nodeInvokeSessionEnvelopeNegotiationComplete = true;
  const nodeInvokeEventDispatchByInvokeId = new Map<string, Promise<void>>();
  // Cancellation can arrive before the queued request dispatches. Mark it immediately
  // so the request cannot start before its queued cancel runs.
  const queuedNodeInvokeCancellations = new Set<string>();
  const queueNodeInvokeEvent = (
    invokeId: string,
    dispatch: (mode: NodeInvokeSessionEnvelopeMode) => void,
    envelopeMode: Promise<NodeInvokeSessionEnvelopeMode> = Promise.resolve("authoritative"),
  ): void => {
    const connectionGeneration = gatewayConnectionGeneration;
    const previous = nodeInvokeEventDispatchByInvokeId.get(invokeId) ?? Promise.resolve();
    const queued = previous
      .then(async () => {
        const mode = await envelopeMode;
        if (connectionGeneration === gatewayConnectionGeneration) {
          dispatch(mode);
        }
      })
      .catch((error: unknown) => {
        writeStderrLine(`node host invoke event dispatch failed: ${String(error)}`);
      });
    nodeInvokeEventDispatchByInvokeId.set(invokeId, queued);
    void queued.then(() => {
      if (nodeInvokeEventDispatchByInvokeId.get(invokeId) === queued) {
        nodeInvokeEventDispatchByInvokeId.delete(invokeId);
      }
    });
  };

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
          queuedNodeInvokeCancellations.add(payload.invokeId);
          queueNodeInvokeEvent(payload.invokeId, () => {
            activeRuntime.cancel(payload.invokeId);
            queuedNodeInvokeCancellations.delete(payload.invokeId);
          });
        }
        return;
      }
      if (evt.event === "node.invoke.input") {
        const payload = coerceNodeInvokeInputPayload(evt.payload);
        if (payload) {
          queueNodeInvokeEvent(payload.invokeId, () => {
            activeRuntime.handleInput(payload.invokeId, payload.seq, payload.payloadJSON);
          });
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
      const receivedAtMs = Date.now();
      const hasSessionKeyEnvelope = Object.hasOwn(payload, "sessionKey");
      // Omitted envelopes received before negotiation completes still use the legacy
      // nested session field. Do not reinterpret them after the response arrives.
      const envelopeModeAtReceipt = hasSessionKeyEnvelope
        ? Promise.resolve<NodeInvokeSessionEnvelopeMode>("authoritative")
        : nodeInvokeSessionEnvelopeNegotiationComplete
          ? nodeInvokeSessionEnvelopeMode
          : Promise.resolve<NodeInvokeSessionEnvelopeMode>("legacy");
      queueNodeInvokeEvent(
        payload.id,
        (mode) => {
          if (queuedNodeInvokeCancellations.delete(payload.id)) {
            return;
          }
          // Older gateways may send non-empty attribution before negotiation.
          // Preserve that envelope while still upgrading omitted negotiated requests to a clear.
          let invokePayload: NodeInvokeRequestPayload =
            mode === "authoritative" && !hasSessionKeyEnvelope
              ? { ...payload, sessionKey: null }
              : payload;
          if (typeof invokePayload.timeoutMs === "number" && invokePayload.timeoutMs > 0) {
            // The Gateway sends its remaining deadline budget. Charge negotiation
            // time here so delayed state-changing commands cannot run after expiry.
            const elapsedMs = Math.max(0, Date.now() - receivedAtMs);
            const remainingTimeoutMs = Math.max(0, invokePayload.timeoutMs - elapsedMs);
            if (remainingTimeoutMs === 0) {
              return;
            }
            invokePayload = { ...invokePayload, timeoutMs: remainingTimeoutMs };
          }
          void activeRuntime.invoke(invokePayload);
        },
        envelopeModeAtReceipt,
      );
    },
    onHelloOk: () => {
      writeStderrLine(`node host gateway connected: ${url}`);
      gatewayConnectionGeneration += 1;
      const connectionGeneration = gatewayConnectionGeneration;
      nodeInvokeEventDispatchByInvokeId.clear();
      queuedNodeInvokeCancellations.clear();
      gatewayHelloReceived = true;
      nodeInvokeSessionEnvelopeNegotiationComplete = false;
      nodeInvokeSessionEnvelopeMode = negotiateNodeInvokeSessionEnvelope(client).then((mode) => {
        if (connectionGeneration === gatewayConnectionGeneration) {
          nodeInvokeSessionEnvelopeNegotiationComplete = true;
        }
        return mode;
      });
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
      gatewayConnectionGeneration += 1;
      nodeInvokeEventDispatchByInvokeId.clear();
      queuedNodeInvokeCancellations.clear();
      gatewayHelloReceived = false;
      nodeInvokeSessionEnvelopeMode = Promise.resolve("authoritative");
      nodeInvokeSessionEnvelopeNegotiationComplete = true;
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
    onManifestChanged: (manifest) => {
      gatewayHelloReceived = false;
      client.updateNodeManifest(manifest);
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

  const readinessPromise = startGatewayClientWhenEventLoopReady(client);
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
