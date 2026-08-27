/** CLI runner for node-host stdin/stdout command dispatch. */
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/schema/frames.js";
import { WORKER_BUNDLE_PREWARM_VERSION } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { copyConfigResolutionFactsExcept } from "../config/resolution-facts.js";
import { startGatewayClientWhenEventLoopReady } from "../gateway/client-start-readiness.js";
import { GatewayClientRequestError, type GatewayReconnectPausedInfo } from "../gateway/client.js";
import { resolveGatewayCredentialsWithSecretInputs } from "../gateway/credentials-secret-inputs.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import {
  NODE_RUNNER_INVENTORY_UPDATE_METHOD,
  NODE_WORKER_BUNDLE_RETENTION_VERSION,
  NODE_WORKER_BUNDLE_STATUS_VERSION,
  NODE_WORKER_PORTAL_STREAM_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  type NodeWorkerCapacitySnapshot,
} from "../infra/node-runner-inventory.js";
import { VERSION } from "../version.js";
import { configureNodeHost, type NodeHostGatewayConfig } from "./config.js";
import { createNodeHostGatewayCandidateConnection } from "./gateway-candidate-connection.js";
import {
  resolveNodeHostCloudflareAccess,
  type NodeHostCloudflareAccessConfig,
} from "./gateway-cloudflare-access.js";
import { resolveNodeHostGatewayPlatformIdentity } from "./gateway-platform-identity.js";
import {
  coerceNodeInvokeCancelPayload,
  coerceNodeInvokeInputPayload,
  coerceNodeInvokePayload,
} from "./invoke-payload.js";
import { prepareNodeHostRuntime, type NodeHostInventory } from "./runtime.js";
import { runStartupMigrations } from "./startup-state-migrations.js";

type NodeHostRunOptions = {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: NodeHostCloudflareAccessConfig;
  gatewayCandidates?: NodeHostGatewayConfig[];
  gatewayBootstrapToken?: string;
  preferGatewayBootstrapToken?: boolean;
  /** Stop cleanly after the first authenticated hello (used before service install). */
  stopAfterFirstConnect?: boolean;
  /** Host worker sessions for this process even when durable node config is disabled. */
  forceWorkerRuns?: boolean;
  /** Optional WebSocket context path (e.g. "/openclaw-gw"). */
  gatewayContextPath?: string;
  nodeId?: string;
  displayName?: string;
  installedAppsSharing?: boolean;
};

function writeStderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

const NODE_HOST_EXIT_ON_RECONNECT_PAUSE_CODES: ReadonlySet<string> = new Set([
  ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
  ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
  ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
  ConnectErrorDetailCodes.AUTH_IDENTITY_HEADER_REQUIRED,
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

const NODE_PLUGIN_TOOLS_UPDATE_METHOD = "node.pluginTools.update";
const NODE_SKILLS_UPDATE_METHOD = "node.skills.update";
const NODE_OPTIONAL_PUBLICATION_RETRY_INITIAL_MS = 250;
const NODE_OPTIONAL_PUBLICATION_RETRY_MAX_MS = 5_000;

function isExactUnknownMethodError(error: unknown, method: string): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message === `unknown method: ${method}`
  );
}

function isExactLegacyNodeAuthorizationError(
  error: unknown,
  method: string,
  gatewayProtocol: number,
): boolean {
  const legacyUnknownMethodShape =
    gatewayProtocol === 3 ||
    (gatewayProtocol === 4 && method === NODE_RUNNER_INVENTORY_UPDATE_METHOD);
  return (
    legacyUnknownMethodShape &&
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message === "unauthorized role: node"
  );
}

function classifyNodeMethodFailure(
  error: unknown,
  method: string,
  gatewayProtocol: number,
): "legacy-unsupported" | "rejected" | "transient" {
  if (
    isExactUnknownMethodError(error, method) ||
    isExactLegacyNodeAuthorizationError(error, method, gatewayProtocol)
  ) {
    return "legacy-unsupported";
  }
  if (error instanceof GatewayClientRequestError && error.gatewayCode === "INVALID_REQUEST") {
    return "rejected";
  }
  return "transient";
}

type NodeOptionalPublicationMethod =
  | typeof NODE_RUNNER_INVENTORY_UPDATE_METHOD
  | typeof NODE_PLUGIN_TOOLS_UPDATE_METHOD
  | typeof NODE_SKILLS_UPDATE_METHOD;

type NodeOptionalPublicationState = {
  status: "unknown" | "supported" | "unsupported";
  hasPending: boolean;
  pendingParams?: unknown;
  hasPublishedParams: boolean;
  publishedParams?: unknown;
  hasRejectedParams: boolean;
  rejectedParams?: unknown;
  retryDelayMs: number;
  retryPending: boolean;
  retryTimer?: NodeJS.Timeout;
  hasInFlightParams: boolean;
  inFlightParams?: unknown;
  inFlight?: Promise<void>;
};

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
  copyConfigResolutionFactsExcept(config, nextConfig, [
    "gateway.remote.token",
    "gateway.remote.password",
  ]);
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
  const cfg = getRuntimeConfig();
  const plannedGateway: NodeHostGatewayConfig = {
    host: opts.gatewayHost,
    port: opts.gatewayPort,
    tls: opts.gatewayTls ?? cfg.gateway?.tls?.enabled ?? false,
    tlsFingerprint: opts.gatewayTlsFingerprint,
    contextPath: opts.gatewayContextPath,
    cloudflareAccess: opts.gatewayCloudflareAccess,
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
  const gatewayCandidates = opts.gatewayCandidates?.length
    ? opts.gatewayCandidates.map((candidate, index) =>
        index === 0 && gateway.cloudflareAccess && !candidate.cloudflareAccess
          ? { ...candidate, cloudflareAccess: gateway.cloudflareAccess }
          : candidate,
      )
    : [gateway];

  const plaintextAccessCandidate = gatewayCandidates.find(
    (candidate) => candidate.cloudflareAccess && candidate.tls !== true,
  );
  if (plaintextAccessCandidate) {
    throw new Error("Cloudflare Access credentials require a TLS Gateway connection");
  }

  const resolvedCloudflareAccess = await Promise.all(
    gatewayCandidates.map(
      async (candidate) =>
        await resolveNodeHostCloudflareAccess({
          value: candidate.cloudflareAccess,
          config: cfg,
          env: process.env,
        }),
    ),
  );
  const cloudflareAccessByCandidate = new Map<NodeHostGatewayConfig, CloudflareAccessCredentials>();
  gatewayCandidates.forEach((candidate, index) => {
    const credentials = resolvedCloudflareAccess[index];
    if (credentials) {
      cloudflareAccessByCandidate.set(candidate, credentials);
    }
  });
  const preparedRuntime = await prepareNodeHostRuntime({
    config: cfg,
    env: process.env,
    enableAgentRuns: true,
    enableWorkerRuns: true,
    forceWorkerRuns: opts.forceWorkerRuns,
    installedAppsSharingEnabled: config.installedAppsSharing,
  });
  let workerHostingEnabled = preparedRuntime.workerHostingEnabled;
  if (preparedRuntime.workerHostingDisabledReason) {
    writeStderrLine(
      `node host worker hosting disabled: ${preparedRuntime.workerHostingDisabledReason}`,
    );
  }
  const { token, password } = opts.gatewayBootstrapToken
    ? {}
    : await resolveNodeHostGatewayCredentials({
        config: cfg,
        env: process.env,
      });

  let inventory: NodeHostInventory = preparedRuntime.initialInventory;
  let workerCapacity: NodeWorkerCapacitySnapshot | undefined;
  let gatewayHelloReceived = false;
  let consecutivePermanentGatewayRejections = 0;
  let gatewayConnectionGeneration = 0;
  let connectedGatewayProtocol = 0;
  let gatewaySupportsBundleRetention = false;
  let gatewaySupportsBundleStatus = false;
  let gatewaySupportsPortalStream = false;
  let optionalPublicationStates = new Map<
    NodeOptionalPublicationMethod,
    NodeOptionalPublicationState
  >();
  const retireOptionalPublications = () => {
    for (const state of optionalPublicationStates.values()) {
      if (state.retryTimer) {
        clearTimeout(state.retryTimer);
      }
    }
    optionalPublicationStates.clear();
  };
  const retireGatewayConnection = () => {
    gatewayConnectionGeneration += 1;
    gatewayHelloReceived = false;
    connectedGatewayProtocol = 0;
    gatewaySupportsBundleRetention = false;
    gatewaySupportsBundleStatus = false;
    gatewaySupportsPortalStream = false;
    retireOptionalPublications();
  };

  const queueOptionalPublication = (
    method: NodeOptionalPublicationMethod,
    params: unknown,
    label: string,
    isRetry = false,
  ): void => {
    if (!gatewayHelloReceived) {
      return;
    }
    const connectionGeneration = gatewayConnectionGeneration;
    const gatewayProtocol = connectedGatewayProtocol;
    const connectionIsCurrent = () => connectionGeneration === gatewayConnectionGeneration;
    let state = optionalPublicationStates.get(method);
    if (!state) {
      state = {
        status: "unknown",
        hasPending: false,
        hasPublishedParams: false,
        hasRejectedParams: false,
        retryDelayMs: NODE_OPTIONAL_PUBLICATION_RETRY_INITIAL_MS,
        retryPending: false,
        hasInFlightParams: false,
      };
      optionalPublicationStates.set(method, state);
    }
    if (state.hasInFlightParams && isDeepStrictEqual(state.inFlightParams, params)) {
      // The latest desired value remains authoritative even when it matches the
      // active request. Replace a newer pending value so A -> B -> A cannot publish B.
      if (state.hasPending) {
        state.pendingParams = params;
      }
      return;
    }
    if (
      state.status === "unsupported" ||
      (state.hasRejectedParams && isDeepStrictEqual(state.rejectedParams, params)) ||
      (state.hasPending && isDeepStrictEqual(state.pendingParams, params)) ||
      (!state.inFlight &&
        state.hasPublishedParams &&
        isDeepStrictEqual(state.publishedParams, params))
    ) {
      return;
    }
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
    }
    if (!isRetry) {
      state.retryDelayMs = NODE_OPTIONAL_PUBLICATION_RETRY_INITIAL_MS;
    }
    state.hasRejectedParams = false;
    state.rejectedParams = undefined;
    state.pendingParams = params;
    state.hasPending = true;
    if (state.inFlight) {
      return;
    }
    const publish = async () => {
      while (state.hasPending && state.status !== "unsupported") {
        if (!connectionIsCurrent()) {
          return;
        }
        const nextParams = state.pendingParams;
        state.pendingParams = undefined;
        state.hasPending = false;
        if (state.hasPublishedParams && isDeepStrictEqual(state.publishedParams, nextParams)) {
          continue;
        }
        if (state.hasRejectedParams && !isDeepStrictEqual(state.rejectedParams, nextParams)) {
          // A different value reopens publication. Keeping the old rejection
          // would drop a later return to that value while this request is in flight.
          state.hasRejectedParams = false;
          state.rejectedParams = undefined;
        }
        state.inFlightParams = nextParams;
        state.hasInFlightParams = true;
        try {
          await client.request(method, nextParams);
          // Request settlement races reconnect teardown. Stale completions must
          // not mutate or report against the retired connection.
          if (!connectionIsCurrent()) {
            return;
          }
          state.status = "supported";
          state.publishedParams = nextParams;
          state.hasPublishedParams = true;
          state.hasRejectedParams = false;
          state.rejectedParams = undefined;
          state.retryDelayMs = NODE_OPTIONAL_PUBLICATION_RETRY_INITIAL_MS;
          state.retryPending = false;
        } catch (error) {
          if (!connectionIsCurrent()) {
            return;
          }
          const failure = classifyNodeMethodFailure(error, method, gatewayProtocol);
          if (failure === "legacy-unsupported") {
            state.status = "unsupported";
            state.pendingParams = undefined;
            state.hasPending = false;
            state.retryPending = false;
          } else {
            writeStderrLine(`node host ${label} publish failed: ${String(error)}`);
            if (failure === "rejected") {
              state.hasRejectedParams = true;
              state.rejectedParams = nextParams;
              state.retryPending = false;
              if (state.hasPending && isDeepStrictEqual(state.pendingParams, nextParams)) {
                state.pendingParams = undefined;
                state.hasPending = false;
              }
            } else {
              // A timeout or transport failure can occur after the Gateway applied
              // the update. Forget the acknowledged baseline so the next desired
              // value is never skipped against an uncertain remote state.
              state.hasPublishedParams = false;
              state.publishedParams = undefined;
              if (!state.hasPending || isDeepStrictEqual(state.pendingParams, nextParams)) {
                state.pendingParams = nextParams;
                state.hasPending = true;
                state.retryPending = true;
                break;
              }
            }
          }
        } finally {
          state.inFlightParams = undefined;
          state.hasInFlightParams = false;
        }
      }
    };
    const inFlight = publish().finally(() => {
      if (state.inFlight === inFlight) {
        state.inFlight = undefined;
        if (
          state.hasPending &&
          state.status !== "unsupported" &&
          gatewayHelloReceived &&
          connectionIsCurrent()
        ) {
          const pendingParams = state.pendingParams;
          const retryPending = state.retryPending;
          state.retryPending = false;
          if (retryPending) {
            const retryDelayMs = state.retryDelayMs;
            state.retryDelayMs = Math.min(retryDelayMs * 2, NODE_OPTIONAL_PUBLICATION_RETRY_MAX_MS);
            state.retryTimer = setTimeout(() => {
              state.retryTimer = undefined;
              if (
                state.hasPending &&
                isDeepStrictEqual(state.pendingParams, pendingParams) &&
                gatewayHelloReceived &&
                connectionIsCurrent()
              ) {
                state.pendingParams = undefined;
                state.hasPending = false;
                queueOptionalPublication(method, pendingParams, label, true);
              }
            }, retryDelayMs);
            state.retryTimer.unref?.();
          } else {
            state.pendingParams = undefined;
            state.hasPending = false;
            queueOptionalPublication(method, pendingParams, label);
          }
        }
      }
    });
    state.inFlight = inFlight;
  };

  const publishInventory = () => {
    if (!gatewayHelloReceived) {
      return;
    }
    if (inventory.skills) {
      queueOptionalPublication(NODE_SKILLS_UPDATE_METHOD, { skills: inventory.skills }, "skill");
    }
    queueOptionalPublication(
      NODE_PLUGIN_TOOLS_UPDATE_METHOD,
      { tools: inventory.pluginTools },
      "plugin tool",
    );
  };

  const publishRunnerInventory = () => {
    queueOptionalPublication(
      NODE_RUNNER_INVENTORY_UPDATE_METHOD,
      {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost:
          workerHostingEnabled && workerCapacity
            ? {
                enabled: true,
                capacity: workerCapacity,
                bundlePrewarm: WORKER_BUNDLE_PREWARM_VERSION,
                ...(gatewaySupportsBundleRetention
                  ? { bundleRetention: NODE_WORKER_BUNDLE_RETENTION_VERSION }
                  : {}),
                ...(gatewaySupportsBundleRetention && gatewaySupportsBundleStatus
                  ? { bundleStatus: NODE_WORKER_BUNDLE_STATUS_VERSION }
                  : {}),
                ...(gatewaySupportsPortalStream
                  ? { portalStream: NODE_WORKER_PORTAL_STREAM_VERSION }
                  : {}),
              }
            : { enabled: false },
      },
      "runner inventory",
    );
  };

  const persistWinningGateway = (winningGateway: NodeHostGatewayConfig) => {
    void configureNodeHost({
      nodeId,
      displayName,
      fallbackDisplayName,
      gateway: winningGateway,
      installedAppsSharing: config.installedAppsSharing,
    }).catch((error: unknown) => {
      writeStderrLine(`node host gateway endpoint persistence failed: ${String(error)}`);
    });
  };

  const client = createNodeHostGatewayCandidateConnection({
    candidates: gatewayCandidates,
    cloudflareAccessByCandidate,
    clientOptions: {
      token: token || undefined,
      bootstrapToken: opts.gatewayBootstrapToken,
      preferBootstrapToken: opts.preferGatewayBootstrapToken,
      password: password || undefined,
      instanceId: nodeId,
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: displayName,
      clientVersion: VERSION,
      ...resolveNodeHostGatewayPlatformIdentity(process.platform),
      mode: GATEWAY_CLIENT_MODES.NODE,
      role: "node",
      scopes: [],
      // Pair the built-in MCP command family up front. Server inventory is
      // restart-scoped availability, not a capability upgrade requiring re-pairing.
      caps: preparedRuntime.manifest.caps,
      commands: preparedRuntime.manifest.commands,
      computerUse: preparedRuntime.manifest.computerUse,
      pathEnv: preparedRuntime.manifest.pathEnv,
      permissions: undefined,
      deviceIdentity: loadOrCreateDeviceIdentity(),
    },
    onEvent: (evt) => {
      if (evt.event === "node.invoke.cancel") {
        const payload = coerceNodeInvokeCancelPayload(evt.payload);
        if (payload) {
          activeRuntime.cancel(payload.invokeId);
        }
        return;
      }
      if (evt.event === "node.invoke.input") {
        const payload = coerceNodeInvokeInputPayload(evt.payload);
        if (payload) {
          activeRuntime.handleInput(payload.invokeId, payload.seq, payload.payloadJSON);
        }
        return;
      }
      if (evt.event !== "node.invoke.request") {
        return;
      }
      const payload = coerceNodeInvokePayload(evt.payload);
      if (payload) {
        void activeRuntime.invoke(payload);
      }
    },
    onHelloOk: (hello, url, tlsFingerprint, cloudflareAccess) => {
      consecutivePermanentGatewayRejections = 0;
      writeStderrLine(`node host gateway connected: ${url}`);
      activeRuntime.updateGatewayConnection({
        url,
        ...(tlsFingerprint ? { tlsFingerprint } : {}),
        ...(cloudflareAccess ? { cloudflareAccess } : {}),
      });
      gatewayConnectionGeneration += 1;
      gatewayHelloReceived = true;
      connectedGatewayProtocol = hello.protocol;
      gatewaySupportsBundleRetention =
        hello.features?.capabilities?.includes(GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_RETENTION) ===
        true;
      gatewaySupportsBundleStatus =
        hello.features?.capabilities?.includes(GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_STATUS) ===
        true;
      gatewaySupportsPortalStream =
        hello.features?.capabilities?.includes(GATEWAY_SERVER_CAPS.NODE_WORKER_PORTAL_STREAM) ===
        true;
      retireOptionalPublications();
      optionalPublicationStates = new Map();
      if (opts.stopAfterFirstConnect) {
        void finish(0);
        return;
      }
      publishRunnerInventory();
      publishInventory();
    },
    onConnectError: (error) => {
      writeStderrLine(`node host gateway connect failed: ${error.message}`);
      const rejection =
        error instanceof GatewayClientRequestError && isRecord(error.details)
          ? error.details
          : undefined;
      if (
        rejection?.reason !== "websocket-upgrade-rejected" ||
        rejection.httpStatus !== 403 ||
        rejection.gatewayErrorType !== "proxy_attribution_required"
      ) {
        consecutivePermanentGatewayRejections = 0;
        return;
      }
      if (++consecutivePermanentGatewayRejections < 3) {
        return;
      }
      const remediation =
        typeof rejection.gatewayErrorMessage === "string"
          ? rejection.gatewayErrorMessage
          : error.message;
      writeStderrLine(
        `node host gateway permanently rejected connection (${rejection.gatewayErrorType}): ${remediation}; exiting`,
      );
      void finish(1);
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
      retireGatewayConnection();
      activeRuntime.updateGatewayConnection();
      activeRuntime.cancelAll();
      writeStderrLine(`node host gateway closed (${code}): ${reason}`);
    },
    onWinningCandidate: persistWinningGateway,
  });
  const activeRuntime = preparedRuntime.start({
    client,
    onInventoryChanged: (nextInventory) => {
      inventory = nextInventory;
      publishInventory();
    },
    onRunnerCapacityChanged: (capacity) => {
      workerCapacity = capacity;
      publishRunnerInventory();
    },
    onWorkerHostingDisabled: (reason) => {
      workerHostingEnabled = false;
      writeStderrLine(`node host worker hosting disabled: ${reason}`);
      publishRunnerInventory();
    },
    onManifestChanged: (manifest) => {
      // Manifest changes force a reconnect. Retire the current publication queue
      // now so it cannot drain against the closing connection.
      retireGatewayConnection();
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
    retireGatewayConnection();
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
