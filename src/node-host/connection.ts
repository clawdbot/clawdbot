/** Connection-scoped publication shared by the CLI and native app node transports. */
import { isDeepStrictEqual } from "node:util";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/schema/frames.js";
import { WORKER_BUNDLE_PREWARM_VERSION } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import {
  NODE_RUNNER_INVENTORY_UPDATE_METHOD,
  NODE_WORKER_BUNDLE_RETENTION_VERSION,
  NODE_WORKER_BUNDLE_STATUS_VERSION,
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_PORTAL_STREAM_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  type NodeWorkerCapacitySnapshot,
} from "../infra/node-runner-inventory.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { NodeHostClient } from "./client.js";
import type { prepareNodeHostRuntime, NodeHostInventory } from "./runtime.js";

type PreparedRuntime = Awaited<ReturnType<typeof prepareNodeHostRuntime>>;
export type NodeHostGatewayConnection = NonNullable<
  Parameters<ReturnType<PreparedRuntime["start"]>["updateGatewayConnection"]>[0]
> & {
  protocol: number;
  capabilities: string[];
};

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

export function startNodeHostConnection({
  prepared,
  client,
  onManifestChanged,
  writeStderrLine,
}: {
  prepared: PreparedRuntime;
  client: NodeHostClient;
  onManifestChanged: NonNullable<Parameters<PreparedRuntime["start"]>[0]["onManifestChanged"]>;
  writeStderrLine: (message: string) => void;
}) {
  let publicationClient = client;
  let workerHostingEnabled = prepared.workerHostingEnabled;
  let inventory: NodeHostInventory = prepared.initialInventory;
  let workerCapacity: NodeWorkerCapacitySnapshot | undefined;
  let gatewayHelloReceived = false;
  let gatewayConnectionGeneration = 0;
  let connectedGatewayProtocol = 0;
  let gatewayCapabilities: ReadonlySet<string> = new Set();
  const optionalPublicationStates = new Map<
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
    gatewayCapabilities = new Set();
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
    const connectionClient = publicationClient;
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
          await connectionClient.request(method, nextParams);
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
                ...(gatewayCapabilities.has(GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_RETENTION)
                  ? { bundleRetention: NODE_WORKER_BUNDLE_RETENTION_VERSION }
                  : {}),
                ...(gatewayCapabilities.has(GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_RETENTION) &&
                gatewayCapabilities.has(GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_STATUS)
                  ? { bundleStatus: NODE_WORKER_BUNDLE_STATUS_VERSION }
                  : {}),
                ...(gatewayCapabilities.has(GATEWAY_SERVER_CAPS.NODE_WORKER_PORTAL_STREAM)
                  ? { portalStream: NODE_WORKER_PORTAL_STREAM_VERSION }
                  : {}),
                ...(gatewayCapabilities.has(GATEWAY_SERVER_CAPS.NODE_WORKER_ENVIRONMENT_SESSION)
                  ? { environmentSession: NODE_WORKER_ENVIRONMENT_SESSION_VERSION }
                  : {}),
              }
            : { enabled: false },
      },
      "runner inventory",
    );
  };

  const onWorkerHostingDisabled = (reason: string) => {
    workerHostingEnabled = false;
    writeStderrLine(`node host worker hosting disabled: ${redactSensitiveText(reason)}`);
    publishRunnerInventory();
  };
  // Preparation failures have no supervisor left to report them. Emit once before hello.
  if (prepared.workerHostingDisabledReason) {
    onWorkerHostingDisabled(prepared.workerHostingDisabledReason);
  }
  const disconnect = () => {
    retireGatewayConnection();
    runtime.updateGatewayConnection();
    runtime.cancelAll();
  };
  const runtime = prepared.start({
    client,
    onInventoryChanged: (nextInventory) => {
      inventory = nextInventory;
      publishInventory();
    },
    onRunnerCapacityChanged: (capacity) => {
      workerCapacity = capacity;
      publishRunnerInventory();
    },
    onWorkerHostingDisabled,
    onManifestChanged: (manifest) => {
      retireGatewayConnection();
      onManifestChanged(manifest);
    },
  });
  return {
    ...runtime,
    connect(connection: NodeHostGatewayConnection, connectionClient: NodeHostClient = client) {
      retireGatewayConnection();
      publicationClient = connectionClient;
      runtime.updateGatewayConnection({
        url: connection.url,
        ...(connection.tlsFingerprint ? { tlsFingerprint: connection.tlsFingerprint } : {}),
        ...(connection.cloudflareAccess ? { cloudflareAccess: connection.cloudflareAccess } : {}),
      });
      gatewayHelloReceived = true;
      connectedGatewayProtocol = connection.protocol;
      gatewayCapabilities = new Set(connection.capabilities);
      publishRunnerInventory();
      publishInventory();
    },
    disconnect,
    close() {
      retireGatewayConnection();
      runtime.updateGatewayConnection();
      return runtime.close();
    },
  };
}
