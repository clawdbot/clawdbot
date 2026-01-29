import type { IncomingMessage } from "node:http";
import os from "node:os";

import type { WebSocket } from "ws";
import {
  deriveDeviceIdFromPublicKey,
  normalizeDevicePublicKeyBase64Url,
  verifyDeviceSignature,
} from "../../../infra/device-identity.js";
import {
  approveDevicePairing,
  ensureDeviceToken,
  getPairedDevice,
  requestDevicePairing,
  updatePairedDeviceMetadata,
  verifyDeviceToken,
} from "../../../infra/device-pairing.js";
import { updatePairedNodeMetadata } from "../../../infra/node-pairing.js";
import { recordRemoteNodeInfo, refreshRemoteNodeBins } from "../../../infra/skills-remote.js";
import { loadVoiceWakeConfig } from "../../../infra/voicewake.js";
import { upsertPresence } from "../../../infra/system-presence.js";
import { rawDataToString } from "../../../infra/ws.js";
import type { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isGatewayCliClient, isWebchatClient } from "../../../utils/message-channel.js";
import type { ResolvedGatewayAuth } from "../../auth.js";
import { authorizeGatewayConnect, isLocalDirectRequest } from "../../auth.js";
import { loadConfig } from "../../../config/config.js";
import { buildDeviceAuthPayload } from "../../device-auth.js";
import { isLoopbackAddress, isTrustedProxyAddress, resolveGatewayClientIp } from "../../net.js";
import { resolveNodeCommandAllowlist } from "../../node-command-policy.js";
import {
  type ConnectParams,
  ErrorCodes,
  type ErrorShape,
  errorShape,
  formatValidationErrors,
  PROTOCOL_VERSION,
  type RequestFrame,
  validateConnectParams,
  validateRequestFrame,
} from "../../protocol/index.js";
import { GATEWAY_CLIENT_IDS } from "../../protocol/client-info.js";
import { MAX_BUFFERED_BYTES, MAX_PAYLOAD_BYTES, TICK_INTERVAL_MS } from "../../server-constants.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import { handleGatewayRequest } from "../../server-methods.js";
import { formatError } from "../../server-utils.js";
import { formatForLog, logWs } from "../../ws-log.js";

import { truncateCloseReason } from "../close-reason.js";
import {
  buildGatewaySnapshot,
  getHealthCache,
  getHealthVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "../health-state.js";
import type { GatewayWsClient } from "../ws-types.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const DEVICE_SIGNATURE_SKEW_MS = 10 * 60 * 1000;

function resolveHostName(hostHeader?: string): string {
  const host = (hostHeader ?? "").trim().toLowerCase();
  if (!host) return "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) return host.slice(1, end);
  }
  const [name] = host.split(":");
  return name ?? "";
}

type AuthProvidedKind = "token" | "password" | "none";

function formatGatewayAuthFailureMessage(params: {
  authMode: ResolvedGatewayAuth["mode"];
  authProvided: AuthProvidedKind;
  reason?: string;
  client?: { id?: string | null; mode?: string | null };
}): string {
  const { authMode, authProvided, reason, client } = params;
  const isCli = isGatewayCliClient(client);
  const isControlUi = client?.id === GATEWAY_CLIENT_IDS.CONTROL_UI;
  const isWebchat = isWebchatClient(client);
  const uiHint = "open a tokenized dashboard URL or use 'clawdbot devices approve' to pair";
  const tokenHint = isCli
    ? "set gateway.remote.token to match gateway.auth.token"
    : isControlUi || isWebchat
      ? uiHint
      : "provide gateway auth token";
  const passwordHint = isCli
    ? "set gateway.remote.password to match gateway.auth.password"
    : isControlUi || isWebchat
      ? "enter the password in Control UI settings"
      : "provide gateway auth password";
  switch (reason) {
    case "token_missing":
      return `unauthorized: gateway token missing (${tokenHint})`;
    case "token_mismatch":
      return `unauthorized: gateway token mismatch (${tokenHint})`;
    case "token_missing_config":
      return "unauthorized: gateway token not configured on gateway (set gateway.auth.token)";
    case "password_missing":
      return `unauthorized: gateway password missing (${passwordHint})`;
    case "password_mismatch":
      return `unauthorized: gateway password mismatch (${passwordHint})`;
    case "password_missing_config":
      return "unauthorized: gateway password not configured on gateway (set gateway.auth.password)";
    case "tailscale_user_missing":
      return "unauthorized: tailscale identity missing (use Tailscale Serve auth or gateway token/password)";
    case "tailscale_proxy_missing":
      return "unauthorized: tailscale proxy headers missing (use Tailscale Serve or gateway token/password)";
    case "tailscale_whois_failed":
      return "unauthorized: tailscale identity check failed (use Tailscale Serve auth or gateway token/password)";
    case "tailscale_user_mismatch":
      return "unauthorized: tailscale identity mismatch (use Tailscale Serve auth or gateway token/password)";
    default:
      break;
  }

  if (authMode === "token" && authProvided === "none") {
    return `unauthorized: gateway token missing (${tokenHint})`;
  }
  if (authMode === "password" && authProvided === "none") {
    return `unauthorized: gateway password missing (${passwordHint})`;
  }
  return "unauthorized";
}

export function attachGatewayWsMessageHandler(params: {
  socket: WebSocket;
  upgradeReq: IncomingMessage;
  connId: string;
  remoteAddr?: string;
  forwardedFor?: string;
  realIp?: string;
  requestHost?: string;
  requestOrigin?: string;
  requestUserAgent?: string;
  canvasHostUrl?: string;
  connectNonce: string;
  resolvedAuth: ResolvedGatewayAuth;
  gatewayMethods: string[];
  events: string[];
  extraHandlers: GatewayRequestHandlers;
  buildRequestContext: () => GatewayRequestContext;
  send: (obj: unknown) => void;
  close: (code?: number, reason?: string) => void;
  isClosed: () => boolean;
  clearHandshakeTimer: () => void;
  getClient: () => GatewayWsClient | null;
  setClient: (next: GatewayWsClient) => void;
  setHandshakeState: (state: "pending" | "connected" | "failed") => void;
  setCloseCause: (cause: string, meta?: Record<string, unknown>) => void;
  setLastFrameMeta: (meta: { type?: string; method?: string; id?: string }) => void;
  logGateway: SubsystemLogger;
  logHealth: SubsystemLogger;
  logWsControl: SubsystemLogger;
}) {
  const {
    socket,
    upgradeReq,
    connId,
    remoteAddr,
    forwardedFor,
    realIp,
    requestHost,
    requestOrigin,
    requestUserAgent,
    canvasHostUrl,
    connectNonce,
    resolvedAuth,
    gatewayMethods,
    events,
    extraHandlers,
    buildRequestContext,
    send,
    close,
    isClosed,
    clearHandshakeTimer,
    getClient,
    setClient,
    setHandshakeState,
    setCloseCause,
    setLastFrameMeta,
    logGateway,
    logHealth,
    logWsControl,
  } = params;

  const configSnapshot = loadConfig();
  const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
  const clientIp = resolveGatewayClientIp({ remoteAddr, forwardedFor, realIp, trustedProxies });

  // If proxy headers are present but the remote address isn't trusted, don't treat
  // the connection as local. This prevents auth bypass when running behind a reverse
  // proxy without proper configuration - the proxy's loopback connection would otherwise
  // cause all external requests to be treated as trusted local clients.
  const hasProxyHeaders = Boolean(forwardedFor || realIp);
  const remoteIsTrustedProxy = isTrustedProxyAddress(remoteAddr, trustedProxies);
  const hasUntrustedProxyHeaders = hasProxyHeaders && !remoteIsTrustedProxy;
  const hostName = resolveHostName(requestHost);
  const hostIsLocal = hostName === "localhost" || hostName === "127.0.0.1" || hostName === "::1";
  const hostIsTailscaleServe = hostName.endsWith(".ts.net");
  const hostIsLocalish = hostIsLocal || hostIsTailscaleServe;
  const isLocalClient = isLocalDirectRequest(upgradeReq, trustedProxies);
  const reportedClientIp =
    isLocalClient || hasUntrustedProxyHeaders
      ? undefined
      : clientIp && !isLoopbackAddress(clientIp)
        ? clientIp
        : undefined;

  if (hasUntrustedProxyHeaders) {
    logWsControl.warn(
      "Proxy headers detected from untrusted address. " +
        "Connection will not be treated as local. " +
        "Configure gateway.trustedProxies to restore local client detection behind your proxy.",
    );
  }
  if (!hostIsLocalish && isLoopbackAddress(remoteAddr) && !hasProxyHeaders) {
    logWsControl.warn(
      "Loopback connection with non-local Host header. " +
        "Treating it as remote. If you're behind a reverse proxy, " +
        "set gateway.trustedProxies and forward X-Forwarded-For/X-Real-IP.",
    );
  }

  const isWebchatConnect = (p: ConnectParams | null | undefined) => isWebchatClient(p?.client);

  socket.on("message", async (data) => {
    if (isClosed()) return;
    const text = rawDataToString(data);
    try {
      const parsed = JSON.parse(text);
      const frameType =
        parsed && typeof parsed === "object" && "type" in parsed
          ? typeof (parsed as { type?: unknown }).type === "string"
            ? String((parsed as { type?: unknown }).type)
            : undefined
          : undefined;
      const frameMethod =
        parsed && typeof parsed === "object" && "method" in parsed
          ? typeof (parsed as { method?: unknown }).method === "string"
            ? String((parsed as { method?: unknown }).method)
            : undefined
          : undefined;
      const frameId =
        parsed && typeof parsed === "object" && "id" in parsed
          ? typeof (parsed as { id?: unknown }).id === "string"
            ? String((parsed as { id?: unknown }).id)
            : undefined
          : undefined;
      if (frameType || frameMethod || frameId) {
        setLastFrameMeta({ type: frameType, method: frameMethod, id: frameId });
      }

      const client = getClient();
      if (!client) {
        // Handshake must be a normal request:
        // { type:"req", method:"connect", params: ConnectParams }.
        const isRequestFrame = validateRequestFrame(parsed);
        if (
          !isRequestFrame ||
          (parsed as RequestFrame).method !== "connect" ||
          !validateConnectParams((parsed as RequestFrame).params)
        ) {
          const handshakeError = isRequestFrame
            ? (parsed as RequestFrame).method === "connect"
              ? `invalid connect params: ${formatValidationErrors(validateConnectParams.errors)}`
              : "invalid handshake: first request must be connect"
            : "invalid request frame";
          setHandshakeState("failed");
          setCloseCause("invalid-handshake", {
            frameType,
            frameMethod,
            frameId,
            handshakeError,
          });
          if (isRequestFrame) {
            const req = parsed as RequestFrame;
            send({
              type: "res",
              id: req.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, handshakeError),
            });
          } else {
            logWsControl.warn(
              `invalid handshake conn=${connId} remote=${remoteAddr ?? "?"} fwd=${forwardedFor ?? "n/a"} origin=${requestOrigin ?? "n/a"} host=${requestHost ?? "n/a"} ua=${requestUserAgent ?? "n/a"}`,
            );
          }
          const closeReason = truncateCloseReason(handshakeError || "invalid handshake");
          if (isRequestFrame) {
            queueMicrotask(() => close(1008, closeReason));
          } else {
            close(1008, closeReason);
          }
          return;
        }

        const frame = parsed as RequestFrame;
        const connectParams = frame.params as ConnectParams;
        const clientLabel = connectParams.client.displayName ?? connectParams.client.id;

        // protocol negotiation
        const { minProtocol, maxProtocol } = connectParams;
        if (maxProtocol < PROTOCOL_VERSION || minProtocol > PROTOCOL_VERSION) {
          setHandshakeState("failed");
          logWsControl.warn(
            `protocol mismatch conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version}`,
          );
          setCloseCause("protocol-mismatch", {
            minProtocol,
            maxProtocol,
            expectedProtocol: PROTOCOL_VERSION,
            client: connectParams.client.id,
            clientDisplayName: connectParams.client.displayName,
            mode: connectParams.client.mode,
            version: connectParams.client.version,
          });
          send({
            type: "res",
            id: frame.id,
            ok: false,
            error: errorShape(ErrorCodes.INVALID_REQUEST, "protocol mismatch", {
              details: { expectedProtocol: PROTOCOL_VERSION },
            }),
          });
          close(1002, "protocol mismatch");
          return;
        }

        const roleRaw = connectParams.role ?? "operator";
        const role = roleRaw === "operator" || roleRaw === "node" ? roleRaw : null;
        if (!role) {
          setHandshakeState("failed");
          setCloseCause("invalid-role", {
            role: roleRaw,
            client: connectParams.client.id,
            clientDisplayName: connectParams.client.displayName,
            mode: connectParams.client.mode,
            version: connectParams.client.version,
          });
          send({
            type: "res",
            id: frame.id,
            ok: false,
            error: errorShape(ErrorCodes.INVALID_REQUEST, "invalid role"),
          });
          close(1008, "invalid role");
          return;
        }
        const requestedScopes = Array.isArray(connectParams.scopes) ? connectParams.scopes : [];
        const scopes =
          requestedScopes.length > 0
            ? requestedScopes
            : role === "operator"
              ? ["operator.admin"]
              : [];
        connectParams.role = role;
        connectParams.scopes = scopes;

        const deviceRaw = connectParams.device;
        let devicePublicKey: string | null = null;
        const hasTokenAuth = Boolean(connectParams.auth?.token);
        const hasPasswordAuth = Boolean(connectParams.auth?.password);
        const hasSharedAuth = hasTokenAuth || hasPasswordAuth;
        const isControlUi = connectParams.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI;
        const allowInsecureControlUi =
          isControlUi && configSnapshot.gateway?.controlUi?.allowInsecureAuth === true;
        const disableControlUiDeviceAuth =
          isControlUi && configSnapshot.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true;
        const allowControlUiBypass = allowInsecureControlUi || disableControlUiDeviceAuth;
        const device = disableControlUiDeviceAuth ? null : deviceRaw;
        if (!device) {
          const canSkipDevice = allowControlUiBypass ? hasSharedAuth : hasTokenAuth;

          if (isControlUi && !allowControlUiBypass) {
            const errorMessage = "control ui requires HTTPS or localhost (secure context)";
            setHandshakeState("failed");
            setCloseCause("control-ui-insecure-auth", {
              client: connectParams.client.id,
              clientDisplayName: connectParams.client.displayName,
              mode: connectParams.client.mode,
              version: connectParams.client.version,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, errorMessage),
            });
            close(1008, errorMessage);
            return;
          }

          // Allow token-authenticated connections (e.g., control-ui) to skip device identity
          if (!canSkipDevice) {
            setHandshakeState("failed");
            setCloseCause("device-required", {
              client: connectParams.client.id,
              clientDisplayName: connectParams.client.displayName,
              mode: connectParams.client.mode,
              version: connectParams.client.version,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.NOT_PAIRED, "device identity required"),
            });
            close(1008, "device identity required");
            return;
          }
        }
        if (device) {
          const derivedId = deriveDeviceIdFromPublicKey(device.publicKey);
          if (!derivedId || derivedId !== device.id) {
            setHandshakeState("failed");
            setCloseCause("device-auth-invalid", {
              reason: "device-id-mismatch",
              client: connectParams.client.id,
              deviceId: device.id,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, "device identity mismatch"),
            });
            close(1008, "device identity mismatch");
            return;
          }
          const signedAt = device.signedAt;
          if (
            typeof signedAt !== "number" ||
            Math.abs(Date.now() - signedAt) > DEVICE_SIGNATURE_SKEW_MS
          ) {
            setHandshakeState("failed");
            setCloseCause("device-auth-invalid", {
              reason: "device-signature-stale",
              client: connectParams.client.id,
              deviceId: device.id,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, "device signature expired"),
            });
            close(1008, "device signature expired");
            return;
          }
          const nonceRequired = !isLocalClient;
          const providedNonce = typeof device.nonce === "string" ? device.nonce.trim() : "";
          if (nonceRequired && !providedNonce) {
            setHandshakeState("failed");
            setCloseCause("device-auth-invalid", {
              reason: "device-nonce-missing",
              client: connectParams.client.id,
              deviceId: device.id,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, "device nonce required"),
            });
            close(1008, "device nonce required");
            return;
          }
          if (providedNonce && providedNonce !== connectNonce) {
            setHandshakeState("failed");
            setCloseCause("device-auth-invalid", {
              reason: "device-nonce-mismatch",
              client: connectParams.client.id,
              deviceId: device.id,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, "device nonce mismatch"),
            });
            close(1008, "device nonce mismatch");
            return;
          }
          const payload = buildDeviceAuthPayload({
            deviceId: device.id,
            clientId: connectParams.client.id,
            clientMode: connectParams.client.mode,
            role,
            scopes: requestedScopes,
            signedAtMs: signedAt,
            token: connectParams.auth?.token ?? null,
            nonce: providedNonce || undefined,
            version: providedNonce ? "v2" : "v1",
          });
          const signatureOk = verifyDeviceSignature(device.publicKey, payload, device.signature);
          const allowLegacy = !nonceRequired && !providedNonce;
          if (!signatureOk && allowLegacy) {
            const legacyPayload = buildDeviceAuthPayload({
              deviceId: device.id,
              clientId: connectParams.client.id,
              clientMode: connectParams.client.mode,
              role,
              scopes: requestedScopes,
              signedAtMs: signedAt,
              token: connectParams.auth?.token ?? null,
              version: "v1",
            });
            if (verifyDeviceSignature(device.publicKey, legacyPayload, device.signature)) {
              // accepted legacy loopback signature
            } else {
              setHandshakeState("failed");
              setCloseCause("device-auth-invalid", {
                reason: "device-signature",
                client: connectParams.client.id,
                deviceId: device.id,
              });
              send({
                type: "res",
                id: frame.id,
                ok: false,
                error: errorShape(ErrorCodes.INVALID_REQUEST, "device signature invalid"),
              });
              close(1008, "device signature invalid");
              return;
            }
          } else if (!signatureOk) {
            setHandshakeState("failed");
            setCloseCause("device-auth-invalid", {
              reason: "device-signature",
              client: connectParams.client.id,
              deviceId: device.id,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, "device signature invalid"),
            });
            close(1008, "device signature invalid");
            return;
          }
          devicePublicKey = normalizeDevicePublicKeyBase64Url(device.publicKey);
          if (!devicePublicKey) {
            setHandshakeState("failed");
            setCloseCause("device-auth-invalid", {
              reason: "device-public-key",
              client: connectParams.client.id,
              deviceId: device.id,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, "device public key invalid"),
            });
            close(1008, "device public key invalid");
            return;
          }
        }

        const authResult = await authorizeGatewayConnect({
          auth: resolvedAuth,
          connectAuth: connectParams.auth,
          req: upgradeReq,
          trustedProxies,
        });
        let authOk = authResult.ok;
        let authMethod =
          authResult.method ?? (resolvedAuth.mode === "password" ? "password" : "token");
        if (!authOk && connectParams.auth?.token && device) {
          const tokenCheck = await verifyDeviceToken({
            deviceId: device.id,
            token: connectParams.auth.token,
            role,
            scopes,
          });
          if (tokenCheck.ok) {
            authOk = true;
            authMethod = "device-token";
          }
        }
        if (!authOk) {
          setHandshakeState("failed");
          logWsControl.warn(
            `unauthorized conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version} reason=${authResult.reason ?? "unknown"}`,
          );
          const authProvided: AuthProvidedKind = connectParams.auth?.token
            ? "token"
            : connectParams.auth?.password
              ? "password"
              : "none";
          const authMessage = formatGatewayAuthFailureMessage({
            authMode: resolvedAuth.mode,
            authProvided,
            reason: authResult.reason,
            client: connectParams.client,
          });
          setCloseCause("unauthorized", {
            authMode: resolvedAuth.mode,
            authProvided,
            authReason: authResult.reason,
            allowTailscale: resolvedAuth.allowTailscale,
            client: connectParams.client.id,
            clientDisplayName: connectParams.client.displayName,
            mode: connectParams.client.mode,
            version: connectParams.client.version,
          });
          send({
            type: "res",
            id: frame.id,
            ok: false,
            error: errorShape(ErrorCodes.INVALID_REQUEST, authMessage),
          });
          close(1008, truncateCloseReason(authMessage));
          return;
        }

        const skipPairing = allowControlUiBypass && hasSharedAuth;
        if (device && devicePublicKey && !skipPairing) {
          const requirePairing = async (reason: string, _paired?: { deviceId: string }) => {
            const pairing = await requestDevicePairing({
              deviceId: device.id,
              publicKey: devicePublicKey,
              displayName: connectParams.client.displayName,
              platform: connectParams.client.platform,
              clientId: connectParams.client.id,
              clientMode: connectParams.client.mode,
              role,
              scopes,
              remoteIp: reportedClientIp,
              silent: isLocalClient,
            });
            const context = buildRequestContext();
            if (pairing.request.silent === true) {
              const approved = await approveDevicePairing(pairing.request.requestId);
              if (approved) {
                logGateway.info(
                  `device pairing auto-approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`,
                );
                context.broadcast(
                  "device.pair.resolved",
                  {
                    requestId: pairing.request.requestId,
                    deviceId: approved.device.deviceId,
                    decision: "approved",
                    ts: Date.now(),
                  },
                  { dropIfSlow: true },
                );
              }
            } else if (pairing.created) {
              context.broadcast("device.pair.requested", pairing.request, { dropIfSlow: true });
            }
            if (pairing.request.silent !== true) {
              setHandshakeState("failed");
              setCloseCause("pairing-required", {
                deviceId: device.id,
                requestId: pairing.request.requestId,
                reason,
              });
              send({
                type: "res",
                id: frame.id,
                ok: false,
                error: errorShape(ErrorCodes.NOT_PAIRED, "pairing required", {
                  details: { requestId: pairing.request.requestId },
                }),
              });
              close(1008, "pairing required");
              return false;
            }
            return true;
          };

          const paired = await getPairedDevice(device.id);
          const isPaired = paired?.publicKey === devicePublicKey;
          if (!isPaired) {
            const ok = await requirePairing("not-paired");
            if (!ok) return;
          } else {
            const allowedRoles = new Set(
              Array.isArray(paired.roles) ? paired.roles : paired.role ? [paired.role] : [],
            );
            if (allowedRoles.size === 0) {
              const ok = await requirePairing("role-upgrade", paired);
              if (!ok) return;
            } else if (!allowedRoles.has(role)) {
              const ok = await requirePairing("role-upgrade", paired);
              if (!ok) return;
            }

            const pairedScopes = Array.isArray(paired.scopes) ? paired.scopes : [];
            if (scopes.length > 0) {
              if (pairedScopes.length === 0) {
                const ok = await requirePairing("scope-upgrade", paired);
                if (!ok) return;
              } else {
                const allowedScopes = new Set(pairedScopes);
                const missingScope = scopes.find((scope) => !allowedScopes.has(scope));
                if (missingScope) {
                  const ok = await requirePairing("scope-upgrade", paired);
                  if (!ok) return;
                }
              }
            }

            await updatePairedDeviceMetadata(device.id, {
              displayName: connectParams.client.displayName,
              platform: connectParams.client.platform,
              clientId: connectParams.client.id,
              clientMode: connectParams.client.mode,
              role,
              scopes,
              remoteIp: reportedClientIp,
            });
          }
        }

        const deviceToken = device
          ? await ensureDeviceToken({ deviceId: device.id, role, scopes })
          : null;

        if (role === "node") {
          const cfg = loadConfig();
          const allowlist = resolveNodeCommandAllowlist(cfg, {
            platform: connectParams.client.platform,
            deviceFamily: connectParams.client.deviceFamily,
          });
          const declared = Array.isArray(connectParams.commands) ? connectParams.commands : [];
          const filtered = declared
            .map((cmd) => cmd.trim())
            .filter((cmd) => cmd.length > 0 && allowlist.has(cmd));
          connectParams.commands = filtered;
        }

        const shouldTrackPresence = !isGatewayCliClient(connectParams.client);
        const clientId = connectParams.client.id;
        const instanceId = connectParams.client.instanceId;
        const presenceKey = shouldTrackPresence ? (device?.id ?? instanceId ?? connId) : undefined;

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

        const snapshot = buildGatewaySnapshot();
        const cachedHealth = getHealthCache();
        if (cachedHealth) {
          snapshot.health = cachedHealth;
          snapshot.stateVersion.health = getHealthVersion();
        }
        const helloOk = {
          type: "hello-ok",
          protocol: PROTOCOL_VERSION,
          server: {
            version: process.env.CLAWDBOT_VERSION ?? process.env.npm_package_version ?? "dev",
            commit: process.env.GIT_COMMIT,
            host: os.hostname(),
            connId,
          },
          features: { methods: gatewayMethods, events },
          snapshot,
          canvasHostUrl,
          auth: deviceToken
            ? {
                deviceToken: deviceToken.token,
                role: deviceToken.role,
                scopes: deviceToken.scopes,
                issuedAtMs: deviceToken.rotatedAtMs ?? deviceToken.createdAtMs,
              }
            : undefined,
          policy: {
            maxPayload: MAX_PAYLOAD_BYTES,
            maxBufferedBytes: MAX_BUFFERED_BYTES,
            tickIntervalMs: TICK_INTERVAL_MS,
          },
        };

        clearHandshakeTimer();
        const nextClient: GatewayWsClient = {
          socket,
          connect: connectParams,
          connId,
          presenceKey,
        };
        setClient(nextClient);
        setHandshakeState("connected");
        if (role === "node") {
          const context = buildRequestContext();
          const nodeSession = context.nodeRegistry.register(nextClient, {
            remoteIp: reportedClientIp,
          });
          const instanceIdRaw = connectParams.client.instanceId;
          const instanceId = typeof instanceIdRaw === "string" ? instanceIdRaw.trim() : "";
          const nodeIdsForPairing = new Set<string>([nodeSession.nodeId]);
          if (instanceId) nodeIdsForPairing.add(instanceId);
          for (const nodeId of nodeIdsForPairing) {
            void updatePairedNodeMetadata(nodeId, {
              lastConnectedAtMs: nodeSession.connectedAtMs,
            }).catch((err) =>
              logGateway.warn(`failed to record last connect for ${nodeId}: ${formatForLog(err)}`),
            );
          }
          recordRemoteNodeInfo({
            nodeId: nodeSession.nodeId,
            displayName: nodeSession.displayName,
            platform: nodeSession.platform,
            deviceFamily: nodeSession.deviceFamily,
            commands: nodeSession.commands,
            remoteIp: nodeSession.remoteIp,
          });
          void refreshRemoteNodeBins({
            nodeId: nodeSession.nodeId,
            platform: nodeSession.platform,
            deviceFamily: nodeSession.deviceFamily,
            commands: nodeSession.commands,
            cfg: loadConfig(),
          }).catch((err) =>
            logGateway.warn(
              `remote bin probe failed for ${nodeSession.nodeId}: ${formatForLog(err)}`,
            ),
          );
          void loadVoiceWakeConfig()
            .then((cfg) => {
              context.nodeRegistry.sendEvent(nodeSession.nodeId, "voicewake.changed", {
                triggers: cfg.triggers,
              });
            })
            .catch((err) =>
              logGateway.warn(
                `voicewake snapshot failed for ${nodeSession.nodeId}: ${formatForLog(err)}`,
              ),
            );
        }

        logWs("out", "hello-ok", {
          connId,
          methods: gatewayMethods.length,
          events: events.length,
          presence: snapshot.presence.length,
          stateVersion: snapshot.stateVersion.presence,
        });

        send({ type: "res", id: frame.id, ok: true, payload: helloOk });
        void refreshGatewayHealthSnapshot({ probe: true }).catch((err) =>
          logHealth.error(`post-connect health refresh failed: ${formatError(err)}`),
        );
        return;
      }

      // After handshake, accept only req frames
      if (!validateRequestFrame(parsed)) {
        send({
          type: "res",
          id: (parsed as { id?: unknown })?.id ?? "invalid",
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid request frame: ${formatValidationErrors(validateRequestFrame.errors)}`,
          ),
        });
        return;
      }
      const req = parsed as RequestFrame;
      logWs("in", "req", { connId, id: req.id, method: req.method });
      const respond = (
        ok: boolean,
        payload?: unknown,
        error?: ErrorShape,
        meta?: Record<string, unknown>,
      ) => {
        send({ type: "res", id: req.id, ok, payload, error });
        logWs("out", "res", {
          connId,
          id: req.id,
          ok,
          method: req.method,
          errorCode: error?.code,
          errorMessage: error?.message,
          ...meta,
        });
      };

      void (async () => {
        await handleGatewayRequest({
          req,
          respond,
          client,
          isWebchatConnect,
          extraHandlers,
          context: buildRequestContext(),
        });
      })().catch((err) => {
        logGateway.error(`request handler failed: ${formatForLog(err)}`);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
      });
    } catch (err) {
      logGateway.error(`parse/handle error: ${String(err)}`);
      logWs("out", "parse-error", { connId, error: formatForLog(err) });
      if (!getClient()) {
        close();
      }
    }
  });
}
