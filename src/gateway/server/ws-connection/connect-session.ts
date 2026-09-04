// Gateway WebSocket connect finalization attaches node/session state and sends hello-ok.
import os from "node:os";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../../config/io.js";
import { captureAuthenticatedNodePairingState } from "../../../infra/device-pairing-node-state.js";
import { upsertPresence } from "../../../infra/system-presence.js";
import { loadVoiceWakeRoutingConfig } from "../../../infra/voicewake-routing.js";
import { loadVoiceWakeConfig } from "../../../infra/voicewake.js";
import { resolveLocalNodeId } from "../../../node-host/local-id.js";
import { roleScopesAllow } from "../../../shared/operator-scope-compat.js";
import { recordRemoteNodeInfo, refreshRemoteNodeBins } from "../../../skills/runtime/remote.js";
import { classifyTailscaleLogin } from "../../../state/user-profiles-tailscale-login.js";
import { adoptTailscaleProfileAvatar } from "../../../state/user-profiles.js";
import {
  isBrowserCopilotClient,
  isEphemeralGatewayClient,
} from "../../../utils/message-channel.js";
import { resolveRuntimeServiceBuildId, resolveRuntimeServiceVersion } from "../../../version.js";
import { verifyAgentRuntimeIdentityToken } from "../../agent-runtime-identity-token.js";
import { buildAuthenticatedPresenceUser } from "../../authenticated-presence-user.js";
import { shouldUseGatewayOwnerProfile } from "../../gateway-owner-profile.js";
import { createAuthenticatedGitHubIdentitySync } from "../../github-user-identity.js";
import {
  attachGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "../../local-user-ingress.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../../method-scopes.js";
import { serializeEventPayload } from "../../node-registry.js";
import { isOperatorApprovalRuntimeToken } from "../../operator-approval-runtime-token.js";
import { resolveOperatorRolePolicyForProfile } from "../../operator-role-policy.js";
import {
  buildPluginNodeCapabilityScopedHostUrl,
  indexPluginNodeCapabilitySurfaces,
  mintPluginNodeCapabilityToken,
  resolvePluginNodeCapabilityExpiresAtMs,
  setClientPluginNodeCapability,
  type PluginNodeCapabilitySurface,
} from "../../plugin-node-capability.js";
import { WEBSOCKET_OPEN_READY_STATE } from "../../server-constants.js";
import { formatForLog, logWs } from "../../ws-log.js";
import { truncateCloseReason } from "../close-reason.js";
import { broadcastPresenceSnapshot } from "../presence-events.js";
import type { GatewayWsClient } from "../ws-types.js";
import {
  rejectGatewayConnectOrigin,
  rejectUnavailableProfileConnect,
  resolveEffectiveConnectionScopes,
  resolveGatewayConnectPolicyFailure,
} from "./connect-admission.js";
import { sendGatewayHello } from "./connect-hello.js";
import { prepareGatewayNodeConnect } from "./connect-node-session.js";
import {
  resolveAuthenticatedProfile,
  resolveGatewayConnectUserProfile,
} from "./connect-user-profile.js";
import { resolveControlUiBuildMismatch } from "./control-ui-build-admission.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";
import { prepareGatewayReceiverHandoff } from "./request-start.js";

/** Match production release versions (YYYY.M.PATCH or YYYY.M.PATCH-beta.N). */
const RELEASED_VERSION_RE = /^\d{4}\.\d+\.\d+/;

type AuthenticatedNodePairingAdmission = NonNullable<
  Awaited<ReturnType<typeof captureAuthenticatedNodePairingState>>
> & {
  authenticated: { nodeId: string; publicKey: string; token: string };
};

function isReleasedVersion(version: string): boolean {
  return RELEASED_VERSION_RE.test(version);
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
    requestHost,
    requestOrigin,
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
    scopes: deviceScopes,
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
      ...admittedPairingState,
      authenticated: authenticatedNodePairing,
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
  const tailscaleLogin = authResult.tailscaleIdentity
    ? classifyTailscaleLogin(authResult.tailscaleIdentity.login)
    : undefined;
  const authenticatedUserIsTailscaleProvider = tailscaleLogin?.kind === "provider";
  const resolveAuthenticatedGitHubIdentity = createAuthenticatedGitHubIdentitySync({
    authResult,
    authConfig: context.configSnapshot.gateway?.auth,
    requestHeaders: context.handler.upgradeReq.headers,
  });
  const rolesConfigured = Boolean(context.configSnapshot.gateway?.roles);
  const sharedSecretOperatorOwner =
    role === "operator" && (authMethod === "token" || authMethod === "password");
  // Synthetic callers bypass WS admission; ephemeral control-plane clients stay unprofiled.
  const ownerProfileExpected =
    shouldTrackPresence &&
    shouldUseGatewayOwnerProfile({ role, authenticatedUserId, authMethod, rolesConfigured });
  let authenticatedUserProfile: GatewayWsClient["authenticatedUserProfile"];
  if (
    ownerProfileExpected ||
    (authenticatedUserId && (!resolveAuthenticatedGitHubIdentity || rolesConfigured))
  ) {
    try {
      // The live profile callback refreshes edits and detached provider-avatar adoption.
      authenticatedUserProfile = await resolveGatewayConnectUserProfile({
        ownerProfileExpected,
        authenticatedUserId,
        authResult,
        resolveAuthenticatedGitHubIdentity,
      });
    } catch (error) {
      logWsControl.warn(
        `user profile resolution failed conn=${connId} user=${formatForLog(authenticatedUserId)}: ${formatForLog(error)}`,
      );
      if (
        !ownerProfileExpected &&
        rolesConfigured &&
        role === "operator" &&
        !sharedSecretOperatorOwner
      ) {
        await rejectUnavailableProfileConnect(context, error);
        return;
      }
    }
  }
  // Identity-derived scopes must be capped only after their durable profile is known.
  // Configured roles fail closed if profile storage or provider verification is unavailable.
  const effectiveScopes = resolveEffectiveConnectionScopes({
    role,
    deviceScopes,
    verifiedIdentity: authenticatedUserId,
    identityScopes: context.configSnapshot.gateway?.auth?.identityScopes,
    upgradeReq: context.handler.upgradeReq,
  });
  const rolePolicy =
    role === "operator" && !sharedSecretOperatorOwner
      ? resolveOperatorRolePolicyForProfile(
          authenticatedUserProfile?.profileId,
          context.configSnapshot,
        )
      : undefined;
  const scopes = rolePolicy
    ? effectiveScopes.scopes.filter((scope) =>
        roleScopesAllow({
          role: "operator",
          requestedScopes: [scope],
          allowedScopes: rolePolicy.scopes,
        }),
      )
    : effectiveScopes.scopes;
  state.scopes = scopes;
  connectParams.scopes = scopes;
  const addedIdentityScopes = effectiveScopes.addedIdentityScopes.filter((scope) =>
    scopes.includes(scope),
  );
  if (authenticatedUserId && addedIdentityScopes.length > 0) {
    logGateway.warn(
      `security audit: identity scope grant elevated connection identity=${formatForLog(authenticatedUserId)} addedScopes=${addedIdentityScopes.join(",")} conn=${connId}`,
    );
  }

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
  const effectiveNodeCaps = role === "node" ? new Set(connectParams.caps ?? []) : undefined;
  if (pluginSurfaceBaseUrl && !usesLegacyNodeProtocol) {
    for (const pluginCapabilitySurface of Object.values(pluginNodeCapabilitySurfaces)) {
      // Node reconciliation replaces declared caps with the approved surface.
      // Issuing a route capability for a withheld cap would bypass node.pair.approve.
      if (effectiveNodeCaps && !effectiveNodeCaps.has(pluginCapabilitySurface.surface)) {
        continue;
      }
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
  const controlUiBuildMismatch = resolveControlUiBuildMismatch({
    clientId: connectParams.client.id,
    clientBuildId: connectParams.client.buildId,
    gatewayBuildId: resolveRuntimeServiceBuildId(),
    configuredControlUiRoot: context.configSnapshot.gateway?.controlUi?.root,
    requestHost,
    requestOrigin,
  });
  if (controlUiBuildMismatch) {
    // Build identity predates this rejection. Frozen clients recognize the shipped
    // protocol-mismatch signal and surface its literal reload guidance.
    const message = "protocol mismatch: Control UI updated; reload this page to continue";
    markHandshakeFailure("control-ui-build-mismatch", {
      clientBuildId: controlUiBuildMismatch.clientBuildId ?? "legacy",
      gatewayBuildId: controlUiBuildMismatch.gatewayBuildId,
    });
    sendHandshakeErrorResponse(ErrorCodes.UNAVAILABLE, message, {
      retryable: false,
      details: {
        code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
        gatewayBuildId: controlUiBuildMismatch.gatewayBuildId,
        reloadRequired: true,
      },
    });
    logWsControl.warn(
      `control ui build rejected conn=${connId} clientBuild=${formatForLog(controlUiBuildMismatch.clientBuildId ?? "legacy")} gatewayBuild=${formatForLog(controlUiBuildMismatch.gatewayBuildId)}; reload required`,
    );
    await releasePendingNodePairingCleanup();
    close(1008, truncateCloseReason(message));
    return;
  }
  // Record the authenticated ingress after device and role scope restrictions.
  // Later turns must not infer management authority from names or session routing.
  const controlUiAdmin =
    role === "operator" &&
    authMethod !== undefined &&
    authMethod !== "none" &&
    connectParams.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI &&
    scopes.includes(ADMIN_SCOPE);
  const internal = {
    ...(isLocalClient ? { isLocalClient: true as const } : {}),
    ...(controlUiAdmin ? { controlUiAdmin: true as const } : {}),
    ...(isTrustedApprovalRuntime ? { approvalRuntime: true } : {}),
    ...(trustedAgentRuntimeIdentity ? { agentRuntimeIdentity: trustedAgentRuntimeIdentity } : {}),
    ...(sharedSecretOperatorOwner ? { operatorRoleActor: { kind: "system" as const } } : {}),
  };
  const prepareLocalUserIngress = (profile = authenticatedUserProfile) =>
    prepareGatewayLocalUserIngress({
      authMethod,
      authenticatedUserExpected: Boolean(authenticatedUserId) || ownerProfileExpected,
      ...(profile
        ? {
            profile: {
              profileId: profile.profileId,
              displayName: profile.displayName,
            },
          }
        : {}),
      ...(device?.id ? { pairedDeviceId: device.id } : {}),
      isLocalClient,
    });
  const localUserIngress = prepareLocalUserIngress();
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
    pairedClientId: isBrowserCopilotClient(connectParams.client)
      ? connectParams.client.id
      : undefined,
    usesSharedGatewayAuth: sessionUsesSharedGatewayAuth,
    sharedGatewaySessionGeneration: sessionSharedGatewaySessionGeneration,
    presenceKey,
    ...(authenticatedUserId ? { authenticatedUserId } : {}),
    ...(authenticatedUserIsTailscaleProvider ? { authenticatedUserIsTailscaleProvider: true } : {}),
    ...(authenticatedUserProfile ? { authenticatedUserProfile } : {}),
    clientIp: reportedClientIp,
    ...(context.browserOrigin ? { browserOrigin: context.browserOrigin } : {}),
    ...(Object.keys(internal).length > 0 ? { internal } : {}),
    ...(Object.keys(pluginSurfaceUrls).length > 0 ? { pluginSurfaceUrls } : {}),
    ...(Object.keys(pluginNodeCapabilitySurfaces).length > 0
      ? { pluginNodeCapabilitySurfaces }
      : {}),
  };
  attachGatewayLocalUserIngress(nextClient, localUserIngress);
  const attachAuthenticatedProfile = (profileId: string, updatedAt: number) => {
    if (
      isClosed() ||
      context.handler.getClient() !== nextClient ||
      nextClient.invalidated ||
      socket.readyState !== WEBSOCKET_OPEN_READY_STATE
    ) {
      return;
    }
    const profile = resolveAuthenticatedProfile(profileId, updatedAt);
    if (nextClient.authenticatedUserProfile) {
      Object.assign(nextClient.authenticatedUserProfile, profile);
    } else {
      nextClient.authenticatedUserProfile = profile;
    }
    attachGatewayLocalUserIngress(
      nextClient,
      prepareLocalUserIngress(nextClient.authenticatedUserProfile),
    );
    const { profileId: id, ...display } = profile;
    buildRequestContext().refreshConnectedUserProfile?.({ id, ...display });
  };
  if (resolveAuthenticatedGitHubIdentity) {
    nextClient.authenticatedGitHubIdentitySync = async () => {
      const result = await resolveAuthenticatedGitHubIdentity();
      attachAuthenticatedProfile(result.profileId, result.updatedAt);
      return result;
    };
  }
  for (const entry of pendingPluginNodeCapabilities) {
    setClientPluginNodeCapability({
      client: nextClient,
      surface: entry.surface,
      capability: entry.capability,
      expiresAtMs: entry.expiresAtMs,
    });
  }

  // Only an exact cryptographic device match proves the same install; independent
  // SSH-tunneled or separate-state nodes are exempt even when they appear local.
  // Reject before registration/presence so supervisor restarts leave no phantom online state.
  if (role === "node" && isLocalClient) {
    const localNodeId = await resolveLocalNodeId();
    if (localNodeId && device?.id === localNodeId) {
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

  const policyFailure = resolveGatewayConnectPolicyFailure(context, state);
  if (policyFailure) {
    await releasePendingNodePairingCleanup();
    if (policyFailure.kind === "auth") {
      setCloseCause("gateway-auth-rotated", { authGenerationStale: true });
      close(4001, "gateway auth changed");
    } else {
      rejectGatewayConnectOrigin(context, policyFailure.reason);
    }
    return;
  }
  const handoffReceiver = prepareGatewayReceiverHandoff(socket, role);
  if (!handoffReceiver) {
    const message = "unsupported Gateway WebSocket receiver";
    markHandshakeFailure("unsupported-websocket-receiver", {});
    sendHandshakeErrorResponse(ErrorCodes.UNAVAILABLE, message);
    await releasePendingNodePairingCleanup();
    close(1011, message);
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
  // Only registered operators use bounded router starts. Node lifecycle traffic,
  // workers and preauth retain native yielding and their existing queue/drain rules.
  handoffReceiver();
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
    const clientBuildId = connectParams.client.buildId?.trim();
    logWsControl.info(
      `webchat connected conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version} build=${formatForLog(clientBuildId ?? "legacy")}`,
    );
  }

  const currentAuthenticatedPresenceUser = () =>
    nextClient.authenticatedGitHubIdentitySync && !nextClient.authenticatedUserProfile
      ? undefined
      : buildAuthenticatedPresenceUser({
          authenticatedUserId,
          authenticatedUserIsTailscaleProvider,
          authenticatedUserProfile: nextClient.authenticatedUserProfile,
        });

  if (presenceKey) {
    const authenticatedPresenceUser = currentAuthenticatedPresenceUser();
    upsertPresence(presenceKey, {
      host: connectParams.client.displayName ?? connectParams.client.id ?? os.hostname(),
      ip: isLocalClient ? undefined : reportedClientIp,
      version: connectParams.client.version,
      platform: connectParams.client.platform,
      deviceFamily: connectParams.client.deviceFamily,
      modelIdentifier: connectParams.client.modelIdentifier,
      timeZone: connectParams.client.timeZone,
      mode: connectParams.client.mode,
      deviceId: device?.id,
      roles: [role],
      scopes,
      instanceId: role === "node" ? (device?.id ?? instanceId) : instanceId,
      ...(authenticatedPresenceUser ? { user: authenticatedPresenceUser } : {}),
      reason: "connect",
    });
    // Publish the completed row before hello snapshots it; existing readers do
    // not receive this connection's hello and must not wait for later activity.
    broadcastPresenceSnapshot(buildRequestContext());
  }
  if (admittedNodePairing) {
    const pairingGeneration = admittedNodePairing.generation?.key;
    const requestContext = buildRequestContext();
    const nodeSession = requestContext.nodeRegistry.register(nextClient, {
      remoteIp: reportedClientIp,
      pairingIdentity: admittedNodePairing.identity.key,
      approvedSurface: admittedNodePairing.approvedSurface,
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

  await sendGatewayHello(context, state, pluginSurfaceUrls, authenticatedUserProfile?.profileId);

  if (nextClient.authenticatedGitHubIdentitySync) {
    runDetachedConnectWork(
      async () => {
        const result = await nextClient.authenticatedGitHubIdentitySync!();
        const profile = nextClient.authenticatedUserProfile;
        const profilePic = authResult.tailscaleIdentity?.profilePic;
        if (!profile?.hasAvatar && profilePic) {
          try {
            const updated = await adoptTailscaleProfileAvatar(result.profileId, profilePic);
            if (updated.avatarMime) {
              attachAuthenticatedProfile(updated.id, updated.updatedAt);
            }
          } catch (error) {
            logGateway.warn(
              `Tailscale avatar adoption failed conn=${connId}: ${formatForLog(error)}`,
            );
          }
        }
      },
      (error) => {
        logGateway.warn(`GitHub identity sync failed conn=${connId}: ${formatForLog(error)}`);
      },
    );
  }

  const tailscaleProfilePic = authResult.tailscaleIdentity?.profilePic;
  const tailscaleProfileId = nextClient.authenticatedUserProfile?.profileId;
  if (
    !nextClient.authenticatedGitHubIdentitySync &&
    tailscaleProfileId &&
    !nextClient.authenticatedUserProfile?.hasAvatar &&
    tailscaleProfilePic
  ) {
    runDetachedConnectWork(
      async () => {
        const updated = await adoptTailscaleProfileAvatar(tailscaleProfileId, tailscaleProfilePic);
        if (!updated.avatarMime) {
          return;
        }
        attachAuthenticatedProfile(updated.id, updated.updatedAt);
      },
      (error) =>
        logGateway.warn(`Tailscale avatar adoption failed conn=${connId}: ${formatForLog(error)}`),
    );
  }
}
