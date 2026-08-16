// Gateway WebSocket connect completion sends hello-ok and commits post-handshake state.
import {
  GATEWAY_SERVER_CAPS,
  PROTOCOL_VERSION,
} from "../../../../packages/gateway-protocol/src/index.js";
import { sha256Base64Url } from "../../../infra/crypto-digest.js";
import {
  redeemDeviceBootstrapTokenProfile,
  restoreGenericDeviceBootstrapToken,
} from "../../../infra/device-bootstrap.js";
import {
  finalizeNodePairingCleanupClaim,
  recordPairedNodeConnection,
} from "../../../infra/device-pairing-node.js";
import { hasMultipleSessionSharingIdentities } from "../../../state/user-profiles.js";
import { resolveRuntimeServiceBuildId, resolveRuntimeServiceVersion } from "../../../version.js";
import { resolveChatAttachmentPolicy } from "../../chat-attachment-policy.js";
import {
  listControlUiPluginTabs,
  listControlUiPluginWidgetKinds,
} from "../../control-ui-plugin-tabs.js";
import {
  broadcastSetupHandoffDeliveryUncertain,
  broadcastSetupHandoffCompletion,
  confirmSetupHandoffDelivery,
  consumeSetupHandoff,
  type SetupHandoff,
} from "../../device-pair-setup-completion.js";
import { canReadDetailedUpdateMetadata } from "../../events.js";
import { ADMIN_SCOPE } from "../../method-scopes.js";
import { scheduleNodeConnectionNotification } from "../../node-connection-notifications.js";
import { MAX_BUFFERED_BYTES, MAX_PAYLOAD_BYTES, TICK_INTERVAL_MS } from "../../server-constants.js";
import { formatError } from "../../server-utils.js";
import { allowedSessionVisibilities } from "../../session-sharing.js";
import { formatForLog, logWs } from "../../ws-log.js";
import { buildGatewaySnapshot, getHealthCache, getHealthVersion } from "../health-state.js";
import { emitGatewayAuthSecurityEvent } from "./connect-auth-security.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

export async function sendGatewayHello(
  context: GatewayConnectPhaseContext,
  state: DeviceAuthorizedGatewayConnect,
  pluginSurfaceUrls: Record<string, string>,
  authenticatedUserProfileId?: string,
): Promise<void> {
  const {
    connId,
    nodeReapprovalCoordinator,
    gatewayMethods,
    events,
    buildRequestContext,
    refreshHealthSnapshot,
    close,
    advanceHandshakePhase,
    setCloseCause,
    logGateway,
    logHealth,
  } = context.handler;
  const {
    frame,
    connectParams,
    sendFrame,
    pendingNodePairingCleanup,
    releasePendingNodePairingCleanup,
  } = context;
  const {
    resolvedAuth,
    role,
    scopes,
    device,
    devicePublicKey,
    hasTokenAuth,
    hasPasswordAuth,
    bootstrapTokenCandidate,
    authResult,
    authMethod,
    sessionSharedGatewaySessionGeneration,
    issuedBootstrapProfile,
    handoffBootstrapProfile,
    deviceToken,
    bootstrapDeviceTokens,
    controlUiDeviceAuthMigrationPending,
  } = state;
  // Prefer the authenticated human; principal scopes never inherit device-token rows.
  const authenticatedPrincipal = authenticatedUserProfileId ?? authResult.user;
  const recoveryScopeMaterial = authenticatedPrincipal
    ? ["principal", authenticatedPrincipal, device?.id ?? ""]
    : deviceToken?.token
      ? ["device-token", deviceToken.token]
      : sessionSharedGatewaySessionGeneration
        ? ["shared-auth", sessionSharedGatewaySessionGeneration, device?.id ?? ""]
        : device?.id
          ? ["device", device.id]
          : undefined;
  const recoveryScope =
    role === "operator" && recoveryScopeMaterial
      ? sha256Base64Url(JSON.stringify(recoveryScopeMaterial))
      : undefined;
  const canMigrateRecovery = role === "operator" && !authenticatedPrincipal && Boolean(deviceToken);
  const snapshot = buildGatewaySnapshot({
    includeSensitive: scopes.includes(ADMIN_SCOPE),
    includeUpdateDetails: canReadDetailedUpdateMetadata(role, scopes),
  });
  const cachedHealth = getHealthCache();
  if (cachedHealth) {
    snapshot.health = cachedHealth;
    snapshot.stateVersion.health = getHealthVersion();
  }
  const controlUiTabs = listControlUiPluginTabs(scopes, {
    requireGatewayAuthGrant: resolvedAuth.mode !== "none",
  });
  const controlUiWidgetKinds = listControlUiPluginWidgetKinds(scopes);
  // A configured UI root can be built independently from the Gateway. Exact
  // comparison is authoritative only for the package-owned bundled artifact.
  const controlUiBuildSource = context.configSnapshot.gateway?.controlUi?.root
    ? ("configured" as const)
    : ("bundled" as const);
  const serverBuildId = controlUiBuildSource === "bundled" ? resolveRuntimeServiceBuildId() : null;
  const helloOk = {
    type: "hello-ok",
    // Admission already verified range overlap; this field reports the server's current protocol.
    protocol: PROTOCOL_VERSION,
    server: {
      version: resolveRuntimeServiceVersion(process.env),
      ...(serverBuildId ? { buildId: serverBuildId } : {}),
      controlUiBuildSource,
      connId,
    },
    features: {
      methods: gatewayMethods,
      events,
      capabilities: [
        GATEWAY_SERVER_CAPS.BOARD_WIDGET_PUT_CANVAS_DOC,
        GATEWAY_SERVER_CAPS.CHAT_SEND_ROUTING_CONTRACT,
        GATEWAY_SERVER_CAPS.GATEWAY_RESTART_TARGET_SAFE,
        GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_RETENTION,
        GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_STATUS,
        GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_CANCEL,
        GATEWAY_SERVER_CAPS.SYSTEM_AGENT_SETUP_MODEL_REF,
        GATEWAY_SERVER_CAPS.TASK_SUGGESTIONS_ACCEPT_MODES,
      ],
    },
    snapshot,
    ...(controlUiTabs.length > 0 ? { controlUiTabs } : {}),
    ...(controlUiWidgetKinds.length > 0 ? { controlUiWidgetKinds } : {}),
    ...(Object.keys(pluginSurfaceUrls).length > 0 ? { pluginSurfaceUrls } : {}),
    ...(controlUiDeviceAuthMigrationPending
      ? { deviceAuthMigration: { pending: true as const } }
      : {}),
    auth: {
      role,
      scopes,
      ...(recoveryScope ? { recoveryScope } : {}),
      ...(canMigrateRecovery ? { recoveryMigrationAllowed: true as const } : {}),
      ...(deviceToken
        ? {
            deviceToken: deviceToken.token,
            issuedAtMs: deviceToken.rotatedAtMs ?? deviceToken.createdAtMs,
            ...(bootstrapDeviceTokens.length > 1
              ? { deviceTokens: bootstrapDeviceTokens.slice(1) }
              : {}),
          }
        : {}),
    },
    policy: {
      maxPayload: MAX_PAYLOAD_BYTES,
      maxBufferedBytes: MAX_BUFFERED_BYTES,
      tickIntervalMs: TICK_INTERVAL_MS,
      attachments: resolveChatAttachmentPolicy(context.configSnapshot),
      allowedSessionVisibilities: allowedSessionVisibilities(context.configSnapshot),
      hasMultipleSessionSharingIdentities: hasMultipleSessionSharingIdentities(),
    },
  };
  advanceHandshakePhase("hello_payload_prepared");

  let bootstrapHandoff: SetupHandoff | undefined;
  if (authMethod === "bootstrap-token" && bootstrapTokenCandidate && device) {
    try {
      if (handoffBootstrapProfile || issuedBootstrapProfile) {
        const redemption = await redeemDeviceBootstrapTokenProfile({
          token: bootstrapTokenCandidate,
          role,
          scopes,
        });
        if (handoffBootstrapProfile || redemption.fullyRedeemed) {
          const consumed = await consumeSetupHandoff({
            token: bootstrapTokenCandidate,
            deviceId: device.id,
            pairedDeviceMatches: (paired) => paired?.publicKey === devicePublicKey,
          });
          if (!consumed) {
            await releasePendingNodePairingCleanup();
            setCloseCause("bootstrap-token-consume-failed");
            close();
            return;
          }
          bootstrapHandoff = consumed;
        }
      }
    } catch (err) {
      logGateway.warn(
        `bootstrap token post-connect bookkeeping failed device=${device.id}: ${formatForLog(err)}`,
      );
      await releasePendingNodePairingCleanup();
      setCloseCause("bootstrap-token-consume-failed", { error: formatForLog(err) });
      close();
      return;
    }
  }
  try {
    await sendFrame({ type: "res", id: frame.id, ok: true, payload: helloOk });
  } catch (err) {
    if (bootstrapHandoff) {
      if (bootstrapHandoff.completion) {
        try {
          broadcastSetupHandoffDeliveryUncertain({
            handoff: bootstrapHandoff,
            broadcast: buildRequestContext().broadcast,
          });
        } catch (broadcastError) {
          logGateway.warn(
            `setup delivery-uncertain broadcast failed device=${device?.id ?? "unknown"}: ${formatForLog(broadcastError)}`,
          );
        }
      } else {
        try {
          await restoreGenericDeviceBootstrapToken({ record: bootstrapHandoff.record });
        } catch (restoreError) {
          logGateway.warn(
            `generic bootstrap token restore after hello-send failure failed device=${device?.id ?? "unknown"}: ${formatForLog(restoreError)}`,
          );
        }
      }
    }
    await releasePendingNodePairingCleanup();
    setCloseCause("hello-send-failed", { error: formatForLog(err) });
    close();
    return;
  }
  if (bootstrapHandoff) {
    try {
      const confirmedHandoff = await confirmSetupHandoffDelivery({ handoff: bootstrapHandoff });
      if (confirmedHandoff) {
        broadcastSetupHandoffCompletion({
          handoff: confirmedHandoff,
          broadcast: buildRequestContext().broadcast,
        });
      } else {
        broadcastSetupHandoffDeliveryUncertain({
          handoff: bootstrapHandoff,
          broadcast: buildRequestContext().broadcast,
        });
      }
    } catch (err) {
      logGateway.warn(
        `setup completion confirmation failed device=${device?.id ?? "unknown"}: ${formatForLog(err)}`,
      );
      try {
        broadcastSetupHandoffDeliveryUncertain({
          handoff: bootstrapHandoff,
          broadcast: buildRequestContext().broadcast,
        });
      } catch {
        // The durable uncertain row remains the status-reconciliation path.
      }
    }
  }
  let authProvided = authMethod;
  if (authMethod !== "device-token" && authMethod !== "bootstrap-token") {
    if (hasPasswordAuth) {
      authProvided = "password";
    } else if (hasTokenAuth) {
      authProvided = "token";
    }
  }
  emitGatewayAuthSecurityEvent({
    action: "gateway.auth.succeeded",
    outcome: "success",
    severity: "low",
    authMode: resolvedAuth.mode,
    authMethod,
    authProvided,
    role,
    scopes,
    clientMode: connectParams.client.mode,
    deviceId: device?.id,
  });
  advanceHandshakePhase("ready");
  if (role === "node") {
    const requestContext = buildRequestContext();
    const nodeId = connectParams.device?.id ?? connectParams.client.id;
    const nodeSession = requestContext.nodeRegistry.get(nodeId);
    const pairingGeneration = nodeSession?.pairingGeneration;
    if (nodeSession?.connId === connId && pairingGeneration) {
      try {
        const connection = await recordPairedNodeConnection(
          nodeSession.nodeId,
          nodeSession.connectedAtMs,
          undefined,
          { nodeId: nodeSession.nodeId, key: pairingGeneration },
        );
        if (!connection.recorded) {
          logGateway.warn(`failed to record last connect for ${nodeSession.nodeId}: not paired`);
        } else {
          const currentSession = requestContext.nodeRegistry.getForPairingGeneration(
            nodeSession.nodeId,
            pairingGeneration,
          );
          // A rapid same-generation reconnect may take over the durable
          // first-connection claim; generation lookup excludes stale replacements.
          if (currentSession) {
            scheduleNodeConnectionNotification(requestContext.nodeRegistry, currentSession, {
              isFirstConnection: connection.firstConnection,
            });
          }
        }
      } catch (err) {
        logGateway.warn(
          `failed to record last connect for ${nodeSession.nodeId}: ${formatForLog(err)}`,
        );
      }
    }
  }
  if (pendingNodePairingCleanup.value) {
    const requestContext = buildRequestContext();
    const cleanupClaim = pendingNodePairingCleanup.value;
    pendingNodePairingCleanup.value = undefined;
    try {
      const resolvedPairings = nodeReapprovalCoordinator
        ? await nodeReapprovalCoordinator.finalizeCleanup(cleanupClaim)
        : await finalizeNodePairingCleanupClaim(cleanupClaim);
      const resolvedAt = Date.now();
      for (const resolved of resolvedPairings) {
        requestContext.broadcast(
          "node.pair.resolved",
          {
            requestId: resolved.requestId,
            nodeId: resolved.nodeId,
            decision: "rejected",
            ts: resolvedAt,
          },
          { dropIfSlow: true },
        );
      }
    } catch (error) {
      logGateway.warn(
        `failed to clear stale pending pairings for ${cleanupClaim.nodeId}: ${formatForLog(error)}`,
      );
    }
  }
  logWs("out", "hello-ok", {
    connId,
    methods: gatewayMethods.length,
    events: events.length,
    presence: snapshot.presence.length,
    stateVersion: snapshot.stateVersion.presence,
  });
  // Post-connect refresh only needs a cached/config snapshot for UI state;
  // live channel probes here pulled slow Discord/Telegram HTTP checks into
  // reply-adjacent websocket handshakes.
  void refreshHealthSnapshot({ probe: false }).catch((err: unknown) =>
    logHealth.error(`post-connect health refresh failed: ${formatError(err)}`),
  );
}
