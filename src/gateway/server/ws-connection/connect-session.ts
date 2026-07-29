// Gateway WebSocket connect finalization attaches node/session state and sends hello-ok.
import os from "node:os";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../../config/io.js";
import {
  captureAuthenticatedNodePairingState,
  type NodePairingGeneration,
  type NodePairingIdentity,
} from "../../../infra/node-pairing-state.js";
import { upsertPresence } from "../../../infra/system-presence.js";
import { loadVoiceWakeRoutingConfig } from "../../../infra/voicewake-routing.js";
import { loadVoiceWakeConfig } from "../../../infra/voicewake.js";
import { loadNodeHostConfig } from "../../../node-host/config.js";
import { recordRemoteNodeInfo, refreshRemoteNodeBins } from "../../../skills/runtime/remote.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import {
  isBrowserCopilotClient,
  isEphemeralGatewayClient,
} from "../../../utils/message-channel.js";
import { resolveRuntimeServiceVersion } from "../../../version.js";
import { verifyAgentRuntimeIdentityToken } from "../../agent-runtime-identity-token.js";
import { APPROVALS_SCOPE } from "../../method-scopes.js";
import { serializeEventPayload } from "../../node-registry.js";
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
import { formatUserProfileAvatarPath } from "../../user-profiles-http-path.js";
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

type AuthenticatedNodePairingAdmission = {
  authenticated: { nodeId: string; publicKey: string; token: string };
  identity: NodePairingIdentity;
  generation?: NodePairingGeneration;
};

function isReleasedVersion(version: string): boolean {
  return RELEASED_VERSION_RE.test(version);
}

/**
 * Lazily resolve the local node host's nodeId from canonical shared SQLite state.
 * Process-stable: only changes on `openclaw node install`, which requires restart.
 */
let cachedLocalNodeId: Promise<string | null> | undefined;
async function resolveLocalNodeId(): Promise<string | null> {
  cachedLocalNodeId ??= loadNodeHostConfig().then((config) => config?.nodeId ?? null);
  return await cachedLocalNodeId;
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
    devicePublicKey,
    deviceToken,
    authResult,
    authMethod,
    pairingLocality,
    sessionUsesSharedGatewayAuth,
    sessionSharedGatewaySessionGeneration,
  } = state;
  if (!(await prepareGatewayNodeConnect(context, state))) {
    return;
  }

  let nodePairingAdmission: AuthenticatedNodePairingAdmission | undefined;
  if (role === "node") {
    const nodeId = device?.id ?? connectParams.client.id;
    const authenticatedNodeToken =
      authMethod === "device-token"
        ? normalizeOptionalString(connectParams.auth?.deviceToken ?? connectParams.auth?.token)
        : deviceToken?.token;
    if (!device || !devicePublicKey || !authenticatedNodeToken) {
      const message = "authenticated node pairing identity unavailable";
      markHandshakeFailure("node-pairing-generation-changed", {});
      sendHandshakeErrorResponse(ErrorCodes.NOT_PAIRED, message);
      await releasePendingNodePairingCleanup();
      close(1008, truncateCloseReason(message));
      return;
    }
    const authenticatedNodePairing = {
      nodeId,
      publicKey: devicePublicKey,
      token: authenticatedNodeToken,
    };
    const admittedPairingState =
      await captureAuthenticatedNodePairingState(authenticatedNodePairing);
    if (!admittedPairingState) {
      const message = "node pairing changed during connect";
      markHandshakeFailure(
        "node-pairing-generation-changed",
        device?.id ? { deviceId: device.id } : {},
      );
      sendHandshakeErrorResponse(ErrorCodes.NOT_PAIRED, message);
      await releasePendingNodePairingCleanup();
      close(1008, truncateCloseReason(message));
      return;
    }
    nodePairingAdmission = {
      authenticated: authenticatedNodePairing,
      identity: admittedPairingState.identity,
      ...(admittedPairingState.generation ? { generation: admittedPairingState.generation } : {}),
    };
  }

  // Presence lists user-visible clients/nodes. Ephemeral control-plane connections
  // (CLI, backend RPC probes, tests) churn for the full TTL and stay excluded.
  const shouldTrackPresence = !isEphemeralGatewayClient(connectParams.client);
  const clientId = connectParams.client.id;
  const instanceId = connectParams.client.instanceId;
  // Nodes retain device-owned presence. User clients need one row per connection
  // so two tabs watching different sessions cannot overwrite each other.
  const presenceKey = shouldTrackPresence
    ? role === "node"
      ? (device?.id ?? instanceId ?? connId)
      : connId
    : undefined;
  const authenticatedUserId = normalizeOptionalString(authResult.user);

  if (isClosed()) {
    await releasePendingNodePairingCleanup();
    setCloseCause("connect-aborted-before-register", {
      ...clientMeta,
      auth: authMethod,
    });
    return;
  }

  let authenticatedUserProfile: GatewayWsClient["authenticatedUserProfile"];
  if (authenticatedUserId) {
    try {
      const profile = ensureProfileForEmail(authenticatedUserId);
      // Profile metadata is a connect-time snapshot; edits become visible after reconnect.
      authenticatedUserProfile = {
        profileId: profile.id,
        displayName: profile.displayName,
        hasAvatar: profile.avatarMime !== null,
        updatedAt: profile.updatedAt,
      };
    } catch (error) {
      // Profile storage must not block login; retain the legacy email-only identity on failure.
      logWsControl.warn(
        `user profile resolution failed conn=${connId} user=${formatForLog(authenticatedUserId)}: ${formatForLog(error)}`,
      );
    }
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
    connect: state.controlUiDeviceAuthMigrationPending
      ? { ...connectParams, scopes }
      : connectParams,
    connId,
    connectionKind: "gateway",
    isDeviceTokenAuth: authMethod === "device-token",
    isControlUiDeviceAuthMigrationSession: state.controlUiDeviceAuthMigrationPending,
    // Only identity-bearing migration sessions may use bounded self-pairing.
    // Device-less sessions remain pairing-scoped until reopened securely.
    isControlUiDeviceAuthMigration:
      state.controlUiDeviceAuthMigrationPending && Boolean(connectParams.device),
    pairedClientId: isBrowserCopilotClient(connectParams.client)
      ? connectParams.client.id
      : undefined,
    usesSharedGatewayAuth: sessionUsesSharedGatewayAuth,
    sharedGatewaySessionGeneration: sessionSharedGatewaySessionGeneration,
    presenceKey,
    ...(authenticatedUserId ? { authenticatedUserId } : {}),
    ...(authenticatedUserProfile ? { authenticatedUserProfile } : {}),
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
  // matching instanceId against the local node-host config row). SSH-tunneled remote
  // nodes also appear as loopback but have different instanceIds, so they are exempt.
  // Placed before setClient/presence to avoid phantom online state on rejection.
  if (role === "node" && isLocalClient) {
    const localNodeId = await resolveLocalNodeId();
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

  const admittedNodePairing = role === "node" ? nodePairingAdmission : undefined;
  if (admittedNodePairing) {
    const currentPairingState = await captureAuthenticatedNodePairingState(
      admittedNodePairing.authenticated,
    );
    if (
      !currentPairingState ||
      currentPairingState.identity.key !== admittedNodePairing.identity.key ||
      currentPairingState.generation?.key !== admittedNodePairing.generation?.key
    ) {
      const message = "node pairing changed during connect";
      markHandshakeFailure("node-pairing-generation-changed", {
        deviceId: admittedNodePairing.identity.nodeId,
      });
      sendHandshakeErrorResponse(ErrorCodes.NOT_PAIRED, message);
      await releasePendingNodePairingCleanup();
      close(1008, truncateCloseReason(message));
      return;
    }
  }

  if (
    state.controlUiDeviceAuthMigrationPending &&
    context.handler.isControlUiDeviceAuthMigrationPending?.() !== true
  ) {
    const hasDeviceIdentity = Boolean(device);
    const message = "device auth migration completed during connect; reconnect";
    markHandshakeFailure("control-ui-device-auth-migration-completed", {
      device: hasDeviceIdentity ? "yes" : "no",
    });
    sendHandshakeErrorResponse(
      hasDeviceIdentity ? ErrorCodes.NOT_PAIRED : ErrorCodes.INVALID_REQUEST,
      message,
      {
        details: {
          code: hasDeviceIdentity
            ? ConnectErrorDetailCodes.PAIRING_REQUIRED
            : ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
        },
      },
    );
    await releasePendingNodePairingCleanup();
    close(1008, truncateCloseReason(message));
    return;
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

  if (authenticatedUserId) {
    logWsControl.info(
      `authenticated user connected conn=${connId} user=${formatForLog(authenticatedUserId)}`,
    );
  }

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
      instanceId: role === "node" ? (device?.id ?? instanceId) : instanceId,
      ...(authenticatedUserId
        ? {
            user: authenticatedUserProfile
              ? {
                  id: authenticatedUserProfile.profileId,
                  email: authenticatedUserId,
                  ...(authenticatedUserProfile.displayName
                    ? { name: authenticatedUserProfile.displayName }
                    : {}),
                  // This authenticated route resolves the uploaded avatar first, then the
                  // gateway-side Gravatar proxy, so clients never need an email-hash URL.
                  // The ?v=<updatedAt> revision changes when the profile (avatar) is
                  // updated, so a reconnecting viewer's <img> refetches instead of reusing
                  // a stale cached image for the unchanged route.
                  avatarUrl: `${formatUserProfileAvatarPath(authenticatedUserProfile.profileId)}?v=${authenticatedUserProfile.updatedAt}`,
                }
              : { id: authenticatedUserId, email: authenticatedUserId },
          }
        : {}),
      reason: "connect",
    });
    incrementPresenceVersion();
  }
  if (admittedNodePairing) {
    const pairingGeneration = admittedNodePairing.generation?.key;
    const requestContext = buildRequestContext();
    const nodeSession = requestContext.nodeRegistry.register(nextClient, {
      remoteIp: reportedClientIp,
      pairingIdentity: admittedNodePairing.identity.key,
      ...(pairingGeneration ? { pairingGeneration } : {}),
    });
    recordRemoteNodeInfo({
      nodeId: nodeSession.nodeId,
      connId: nodeSession.connId,
      displayName: nodeSession.displayName,
      platform: nodeSession.platform,
      deviceFamily: nodeSession.deviceFamily,
      commands: nodeSession.commands,
      remoteIp: nodeSession.remoteIp,
      pairingGeneration: nodeSession.pairingGeneration,
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
    const sendConnectSnapshot = async (event: string, payload: unknown) => {
      if (pairingGeneration) {
        await requestContext.nodeRegistry.sendEventRawForPairingGeneration(
          nodeSession.nodeId,
          pairingGeneration,
          event,
          serializeEventPayload(payload),
        );
        return;
      }
      await requestContext.nodeRegistry.sendEventForPairingIdentity({
        nodeId: nodeSession.nodeId,
        connId: nodeSession.connId,
        pairingIdentity: admittedNodePairing.identity.key,
        event,
        payload,
      });
    };
    runDetachedConnectWork(
      async () => {
        const cfg = await loadVoiceWakeConfig();
        await sendConnectSnapshot("voicewake.changed", { triggers: cfg.triggers });
      },
      (err) =>
        logGateway.warn(
          `voicewake snapshot failed for ${nodeSession.nodeId}: ${formatForLog(err)}`,
        ),
    );
    runDetachedConnectWork(
      async () => {
        const routing = await loadVoiceWakeRoutingConfig();
        await sendConnectSnapshot("voicewake.routing.changed", { config: routing });
      },
      (err) =>
        logGateway.warn(
          `voicewake routing snapshot failed for ${nodeSession.nodeId}: ${formatForLog(err)}`,
        ),
    );
  }

  await sendGatewayHello(context, state, pluginSurfaceUrls);
}
