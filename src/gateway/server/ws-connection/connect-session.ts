// Gateway WebSocket connect finalization attaches node/session state and sends hello-ok.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../../config/io.js";
import { resolveStateDir } from "../../../config/paths.js";
import { updatePairedNodeMetadata } from "../../../infra/node-pairing.js";
import { upsertPresence } from "../../../infra/system-presence.js";
import { loadVoiceWakeRoutingConfig } from "../../../infra/voicewake-routing.js";
import { loadVoiceWakeConfig } from "../../../infra/voicewake.js";
import { recordRemoteNodeInfo, refreshRemoteNodeBins } from "../../../skills/runtime/remote.js";
import { isEphemeralGatewayClient } from "../../../utils/message-channel.js";
import { resolveRuntimeServiceVersion } from "../../../version.js";
import { verifyAgentRuntimeIdentityToken } from "../../agent-runtime-identity-token.js";
import { APPROVALS_SCOPE } from "../../method-scopes.js";
import { isOperatorApprovalRuntimeToken } from "../../operator-approval-runtime-token.js";
import {
  buildPluginNodeCapabilityScopedHostUrl,
  indexPluginNodeCapabilitySurfaces,
  mintPluginNodeCapabilityToken,
  resolvePluginNodeCapabilityExpiresAtMs,
  setClientPluginNodeCapability,
  type PluginNodeCapabilitySurface,
} from "../../plugin-node-capability.js";
import { MAX_PAYLOAD_BYTES } from "../../server-constants.js";
import { formatForLog, logWs } from "../../ws-log.js";
import { truncateCloseReason } from "../close-reason.js";
import { incrementPresenceVersion } from "../health-state.js";
import type { GatewayWsClient } from "../ws-types.js";
import { sendGatewayHello } from "./connect-hello.js";
import { prepareGatewayNodeConnect } from "./connect-node-session.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

/** Match production release versions (YYYY.M.PATCH or YYYY.M.PATCH-beta.N). */
const RELEASED_VERSION_RE = /^\d{4}\.\d+\.\d+/;

function isReleasedVersion(version: string): boolean {
  return RELEASED_VERSION_RE.test(version);
}

/**
 * Lazily resolve the local node host's nodeId from ~/.openclaw/node.json.
 * Process-stable: only changes on `openclaw node install`, which requires restart.
 */
let cachedLocalNodeId: string | null | undefined;
function resolveLocalNodeId(): string | null {
  if (cachedLocalNodeId !== undefined) {
    return cachedLocalNodeId;
  }
  try {
    const raw = fs.readFileSync(path.join(resolveStateDir(), "node.json"), "utf8");
    const parsed = JSON.parse(raw) as { nodeId?: string };
    cachedLocalNodeId = typeof parsed.nodeId === "string" ? parsed.nodeId.trim() || null : null;
  } catch {
    cachedLocalNodeId = null;
  }
  return cachedLocalNodeId;
}

function setSocketMaxPayload(socket: WebSocket, maxPayload: number): void {
  const receiver = (socket as { _receiver?: { _maxPayload?: number } })["_receiver"];
  if (receiver) {
    receiver["_maxPayload"] = maxPayload;
  }
}

export async function attachAuthenticatedGatewayConnect(
  context: GatewayConnectPhaseContext,
  state: DeviceAuthorizedGatewayConnect,
): Promise<void> {
  const {
    socket,
    connId,
    remoteAddr,
    pluginSurfaceBaseUrl,
    pluginNodeCapabilities = [],
    buildRequestContext,
    close,
    isClosed,
    clearHandshakeTimer,
    setClient,
    setHandshakeState,
    advanceHandshakePhase,
    setCloseCause,
    logGateway,
    logWsControl,
  } = context.handler;
  const {
    connectParams,
    isLocalClient,
    reportedClientIp,
    runDetachedConnectWork,
    isWebchatConnect,
    clientLabel,
    clientMeta,
    markHandshakeFailure,
    sendHandshakeErrorResponse,
    releasePendingNodePairingCleanup,
  } = context;
  const {
    minProtocol,
    maxProtocol,
    usesLegacyNodeProtocol,
    role,
    scopes,
    device,
    authMethod,
    pairingLocality,
    sessionUsesSharedGatewayAuth,
    sessionSharedGatewaySessionGeneration,
  } = state;
  if (!(await prepareGatewayNodeConnect(context, state))) {
    return;
  }

  // Presence lists user-visible clients/nodes. Ephemeral control-plane connections
  // (CLI, backend RPC probes, tests) churn for the full TTL and stay excluded.
  const shouldTrackPresence = !isEphemeralGatewayClient(connectParams.client);
  const clientId = connectParams.client.id;
  const instanceId = connectParams.client.instanceId;
  const presenceKey = shouldTrackPresence ? (device?.id ?? instanceId ?? connId) : undefined;

  if (isClosed()) {
    await releasePendingNodePairingCleanup();
    setCloseCause("connect-aborted-before-register", {
      ...clientMeta,
      auth: authMethod,
    });
    return;
  }

  const pluginSurfaceUrls: Record<string, string> = {};
  const pluginNodeCapabilitySurfaces = indexPluginNodeCapabilitySurfaces(pluginNodeCapabilities);
  const pendingPluginNodeCapabilities: Array<{
    surface: PluginNodeCapabilitySurface;
    capability: string;
    expiresAtMs: number;
  }> = [];
  if (pluginSurfaceBaseUrl && !usesLegacyNodeProtocol) {
    for (const pluginCapabilitySurface of Object.values(pluginNodeCapabilitySurfaces)) {
      const capability = mintPluginNodeCapabilityToken();
      const expiresAtMs = resolvePluginNodeCapabilityExpiresAtMs(pluginCapabilitySurface);
      if (expiresAtMs === undefined) {
        continue;
      }
      const scopedUrl =
        buildPluginNodeCapabilityScopedHostUrl(pluginSurfaceBaseUrl, capability) ??
        pluginSurfaceBaseUrl;
      pluginSurfaceUrls[pluginCapabilitySurface.surface] = scopedUrl;
      pendingPluginNodeCapabilities.push({
        surface: pluginCapabilitySurface,
        capability,
        expiresAtMs,
      });
    }
  }
  const isTrustedApprovalRuntime =
    pairingLocality !== "remote" &&
    scopes.includes(APPROVALS_SCOPE) &&
    connectParams.client.id === GATEWAY_CLIENT_IDS.GATEWAY_CLIENT &&
    connectParams.client.mode === GATEWAY_CLIENT_MODES.BACKEND &&
    isOperatorApprovalRuntimeToken(connectParams.auth?.approvalRuntimeToken);
  const agentRuntimeIdentityProof = connectParams.auth?.agentRuntimeIdentityToken;
  const canAcceptAgentRuntimeIdentity =
    pairingLocality !== "remote" &&
    connectParams.client.id === GATEWAY_CLIENT_IDS.GATEWAY_CLIENT &&
    connectParams.client.mode === GATEWAY_CLIENT_MODES.BACKEND;
  let trustedAgentRuntimeIdentity:
    | Awaited<ReturnType<typeof verifyAgentRuntimeIdentityToken>>
    | undefined;
  if (typeof agentRuntimeIdentityProof === "string") {
    if (!canAcceptAgentRuntimeIdentity) {
      const message =
        "agent runtime identity token is only accepted from local backend gateway clients";
      markHandshakeFailure("agent-runtime-identity-untrusted-client", {
        client: connectParams.client.id,
        mode: connectParams.client.mode,
        pairingLocality,
      });
      sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, message);
      close(1008, truncateCloseReason(message));
      return;
    }
    trustedAgentRuntimeIdentity = await verifyAgentRuntimeIdentityToken(agentRuntimeIdentityProof);
    if (!trustedAgentRuntimeIdentity) {
      const message = "invalid agent runtime identity token";
      markHandshakeFailure("agent-runtime-identity-invalid", {
        client: connectParams.client.id,
        mode: connectParams.client.mode,
        pairingLocality,
      });
      sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, message);
      close(1008, message);
      return;
    }
  }
  const internal =
    isTrustedApprovalRuntime || trustedAgentRuntimeIdentity
      ? {
          ...(isTrustedApprovalRuntime ? { approvalRuntime: true } : {}),
          ...(trustedAgentRuntimeIdentity
            ? { agentRuntimeIdentity: trustedAgentRuntimeIdentity }
            : {}),
        }
      : undefined;
  if (usesLegacyNodeProtocol) {
    logWsControl.warn(
      `legacy node protocol accepted conn=${connId} client=${formatForLog(clientLabel)} v${formatForLog(connectParams.client.version)} min=${minProtocol} max=${maxProtocol} current=${PROTOCOL_VERSION}; upgrade recommended`,
    );
  }
  clearHandshakeTimer();
  const nextClient: GatewayWsClient = {
    socket,
    connect: connectParams,
    connId,
    connectionKind: "gateway",
    isDeviceTokenAuth: authMethod === "device-token",
    usesSharedGatewayAuth: sessionUsesSharedGatewayAuth,
    sharedGatewaySessionGeneration: sessionSharedGatewaySessionGeneration,
    presenceKey,
    clientIp: reportedClientIp,
    ...(internal ? { internal } : {}),
    ...(Object.keys(pluginSurfaceUrls).length > 0 ? { pluginSurfaceUrls } : {}),
    ...(Object.keys(pluginNodeCapabilitySurfaces).length > 0
      ? { pluginNodeCapabilitySurfaces }
      : {}),
  };
  for (const entry of pendingPluginNodeCapabilities) {
    setClientPluginNodeCapability({
      client: nextClient,
      surface: entry.surface,
      capability: entry.capability,
      expiresAtMs: entry.expiresAtMs,
    });
  }
  setSocketMaxPayload(socket, MAX_PAYLOAD_BYTES);

  // Version mismatch: kick the local node host so the OS supervisor restarts it.
  // Only applies when the connecting node is the same-install local node (verified by
  // matching instanceId against ~/.openclaw/node.json nodeId). SSH-tunneled remote
  // nodes also appear as loopback but have different instanceIds, so they are exempt.
  // Placed before setClient/presence to avoid phantom online state on rejection.
  if (role === "node" && isLocalClient) {
    const localNodeId = resolveLocalNodeId();
    const clientInstanceId = connectParams.client.instanceId?.trim();
    if (localNodeId && clientInstanceId && clientInstanceId === localNodeId) {
      const gatewayVersion = resolveRuntimeServiceVersion(process.env);
      const clientVersion = connectParams.client.version;
      if (
        clientVersion &&
        gatewayVersion &&
        clientVersion !== gatewayVersion &&
        isReleasedVersion(gatewayVersion) &&
        isReleasedVersion(clientVersion)
      ) {
        logWsControl.info(
          `node version mismatch conn=${connId} client=${formatForLog(clientLabel)} clientVersion=${formatForLog(clientVersion)} gatewayVersion=${gatewayVersion}; closing for supervisor restart`,
        );
        sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "client version mismatch", {
          details: {
            code: ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH,
            clientVersion,
            gatewayVersion,
          },
        });
        await releasePendingNodePairingCleanup();
        close(1008, "client version mismatch");
        return;
      }
    }
  }

  if (!setClient(nextClient)) {
    await releasePendingNodePairingCleanup();
    setCloseCause("connect-aborted-before-register", {
      ...clientMeta,
      auth: authMethod,
    });
    return;
  }
  setHandshakeState("connected");
  advanceHandshakePhase("session_attached");
  logWs("in", "connect", {
    connId,
    client: connectParams.client.id,
    clientDisplayName: connectParams.client.displayName,
    version: connectParams.client.version,
    mode: connectParams.client.mode,
    clientId,
    platform: connectParams.client.platform,
    auth: authMethod,
  });

  if (isWebchatConnect(connectParams)) {
    logWsControl.info(
      `webchat connected conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version}`,
    );
  }

  if (presenceKey) {
    upsertPresence(presenceKey, {
      host: connectParams.client.displayName ?? connectParams.client.id ?? os.hostname(),
      ip: isLocalClient ? undefined : reportedClientIp,
      version: connectParams.client.version,
      platform: connectParams.client.platform,
      deviceFamily: connectParams.client.deviceFamily,
      modelIdentifier: connectParams.client.modelIdentifier,
      mode: connectParams.client.mode,
      deviceId: device?.id,
      roles: [role],
      scopes,
      instanceId: device?.id ?? instanceId,
      reason: "connect",
    });
    incrementPresenceVersion();
  }
  if (role === "node") {
    const requestContext = buildRequestContext();
    const nodeSession = requestContext.nodeRegistry.register(nextClient, {
      remoteIp: reportedClientIp,
    });
    const instanceIdRaw = connectParams.client.instanceId;
    const instanceIdLocal = typeof instanceIdRaw === "string" ? instanceIdRaw.trim() : "";
    const nodeIdsForPairing = new Set<string>([nodeSession.nodeId]);
    if (instanceIdLocal) {
      nodeIdsForPairing.add(instanceIdLocal);
    }
    for (const nodeId of nodeIdsForPairing) {
      runDetachedConnectWork(
        async () => {
          await updatePairedNodeMetadata(nodeId, {
            lastConnectedAtMs: nodeSession.connectedAtMs,
          });
        },
        (err) =>
          logGateway.warn(`failed to record last connect for ${nodeId}: ${formatForLog(err)}`),
      );
    }
    recordRemoteNodeInfo({
      nodeId: nodeSession.nodeId,
      connId: nodeSession.connId,
      displayName: nodeSession.displayName,
      platform: nodeSession.platform,
      deviceFamily: nodeSession.deviceFamily,
      commands: nodeSession.commands,
      remoteIp: nodeSession.remoteIp,
    });
    runDetachedConnectWork(
      async () => {
        await refreshRemoteNodeBins({
          nodeId: nodeSession.nodeId,
          platform: nodeSession.platform,
          deviceFamily: nodeSession.deviceFamily,
          commands: nodeSession.commands,
          cfg: getRuntimeConfig(),
          // The node socket is registered before macOS app command handlers finish warming.
          // Delay only the connect-time probe; later skill refreshes use the live session.
          readinessDelayMs: 5_000,
        });
      },
      (err) =>
        logGateway.warn(`remote bin probe failed for ${nodeSession.nodeId}: ${formatForLog(err)}`),
    );
    runDetachedConnectWork(
      async () => {
        const cfg = await loadVoiceWakeConfig();
        requestContext.nodeRegistry.sendEvent(nodeSession.nodeId, "voicewake.changed", {
          triggers: cfg.triggers,
        });
      },
      (err) =>
        logGateway.warn(
          `voicewake snapshot failed for ${nodeSession.nodeId}: ${formatForLog(err)}`,
        ),
    );
    runDetachedConnectWork(
      async () => {
        const routing = await loadVoiceWakeRoutingConfig();
        requestContext.nodeRegistry.sendEvent(nodeSession.nodeId, "voicewake.routing.changed", {
          config: routing,
        });
      },
      (err) =>
        logGateway.warn(
          `voicewake routing snapshot failed for ${nodeSession.nodeId}: ${formatForLog(err)}`,
        ),
    );
  }

  await sendGatewayHello(context, state, pluginSurfaceUrls);
}
