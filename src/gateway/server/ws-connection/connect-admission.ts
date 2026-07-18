// Gateway WebSocket connect admission validates protocol, role, and browser origin.
import type { IncomingMessage } from "node:http";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
  hasGatewayClientCap,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  ErrorCodes,
  errorShape,
  MIN_NODE_PROTOCOL_VERSION,
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  gatewayStartupUnavailableDetails,
  GATEWAY_STARTUP_CLOSE_CODE,
  GATEWAY_STARTUP_CLOSE_REASON,
  GATEWAY_STARTUP_PENDING_CLOSE_CAUSE,
  GATEWAY_STARTUP_RETRY_AFTER_MS,
} from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import {
  isBrowserCopilotClient,
  isBrowserOperatorUiClient,
  isOperatorUiClient,
} from "../../../utils/message-channel.js";
import { checkBrowserOrigin, normalizeChromeExtensionOrigin } from "../../origin-check.js";
import { parseGatewayRole } from "../../role-policy.js";
import { formatForLog } from "../../ws-log.js";
import { truncateCloseReason } from "../close-reason.js";
import type { GatewayConnectPhaseContext } from "./message-handler-types.js";

export function resolveTrustedProxyControlUiScopes(params: {
  requestedScopes: string[];
  upgradeReq: IncomingMessage;
}): string[] {
  const header = params.upgradeReq.headers["x-openclaw-scopes"];
  const rawHeader = Array.isArray(header) ? header[0] : header;
  if (rawHeader === undefined) {
    return params.requestedScopes;
  }
  const declaredScopes = new Set(
    rawHeader
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
  );
  return declaredScopes.size === 0
    ? []
    : params.requestedScopes.filter((scope) => declaredScopes.has(scope));
}

export async function admitGatewayConnect(context: GatewayConnectPhaseContext) {
  const {
    connId,
    remoteAddr,
    remotePort,
    requestHost,
    requestOrigin,
    close,
    isStartupPending,
    logGateway,
    logWsControl,
    originCheckMetrics,
  } = context.handler;
  const {
    connectParams,
    configSnapshot,
    peerLabel,
    isLocalClient,
    enforceOriginCheckForAnyClient,
    clientLabel,
    markHandshakeFailure,
    sendHandshakeErrorResponse,
    isWebchatConnect,
    frame,
    sendFrame,
  } = context;

  if (isStartupPending?.()) {
    markHandshakeFailure(GATEWAY_STARTUP_PENDING_CLOSE_CAUSE);
    await sendFrame({
      type: "res",
      id: frame.id,
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "gateway starting; retry shortly", {
        retryable: true,
        retryAfterMs: GATEWAY_STARTUP_RETRY_AFTER_MS,
        details: gatewayStartupUnavailableDetails(),
      }),
    }).catch(() => {});
    queueMicrotask(() => close(GATEWAY_STARTUP_CLOSE_CODE, GATEWAY_STARTUP_CLOSE_REASON));
    return undefined;
  }

  // protocol negotiation
  const { minProtocol, maxProtocol } = connectParams;
  const supportsCurrentProtocol =
    maxProtocol >= PROTOCOL_VERSION && minProtocol <= PROTOCOL_VERSION;
  const supportsProbeRestartProtocol =
    connectParams.client.mode === GATEWAY_CLIENT_MODES.PROBE &&
    maxProtocol >= MIN_PROBE_PROTOCOL_VERSION &&
    minProtocol <= PROTOCOL_VERSION;
  // Protocol v4 changed chat deltas, not node RPC frames. Keep N-1 limited to
  // the node role+mode so stale operator/UI clients cannot enter the v4 surface.
  const supportsPreviousNodeProtocol =
    connectParams.role === "node" &&
    connectParams.client.mode === GATEWAY_CLIENT_MODES.NODE &&
    maxProtocol >= MIN_NODE_PROTOCOL_VERSION &&
    minProtocol <= MIN_NODE_PROTOCOL_VERSION;
  const usesLegacyNodeProtocol = !supportsCurrentProtocol && supportsPreviousNodeProtocol;
  if (!supportsCurrentProtocol && !supportsProbeRestartProtocol && !supportsPreviousNodeProtocol) {
    markHandshakeFailure("protocol-mismatch", {
      minProtocol,
      maxProtocol,
      expectedProtocol: PROTOCOL_VERSION,
      minimumProbeProtocol: MIN_PROBE_PROTOCOL_VERSION,
    });
    logWsControl.warn(
      `protocol mismatch conn=${connId} peer=${formatForLog(peerLabel)} remote=${remoteAddr ?? "?"} remotePort=${remotePort ?? "?"} client=${formatForLog(clientLabel)} ${connectParams.client.mode} v${formatForLog(connectParams.client.version)} min=${minProtocol} max=${maxProtocol} expected=${PROTOCOL_VERSION} probeMin=${MIN_PROBE_PROTOCOL_VERSION} instance=${formatForLog(connectParams.client.instanceId ?? "n/a")}`,
    );
    sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "protocol mismatch", {
      details: {
        code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
        clientMinProtocol: minProtocol,
        clientMaxProtocol: maxProtocol,
        expectedProtocol: PROTOCOL_VERSION,
        minimumProbeProtocol: MIN_PROBE_PROTOCOL_VERSION,
      },
    });
    close(1002, "protocol mismatch");
    return undefined;
  }

  const roleRaw = connectParams.role ?? "operator";
  const role = parseGatewayRole(roleRaw);
  if (!role) {
    markHandshakeFailure("invalid-role", { role: roleRaw });
    sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "invalid role");
    close(1008, "invalid role");
    return undefined;
  }
  // Default-deny: scopes must be explicit. Empty/missing scopes means no permissions.
  // Note: If the client does not present a device identity, we can't bind scopes to a paired
  // device/token, so we will clear scopes after auth to avoid self-declared permissions.
  const scopes = Array.isArray(connectParams.scopes) ? connectParams.scopes : [];
  connectParams.role = role;
  connectParams.scopes = scopes;

  const isBrowserCopilot = isBrowserCopilotClient(connectParams.client);
  const browserCopilotOrigin = isBrowserCopilot
    ? normalizeChromeExtensionOrigin(requestOrigin ?? undefined)
    : undefined;
  if (
    isBrowserCopilot &&
    (connectParams.client.mode !== GATEWAY_CLIENT_MODES.UI ||
      !hasGatewayClientCap(connectParams.caps, GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS) ||
      !hasGatewayClientCap(connectParams.caps, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS))
  ) {
    const message =
      "browser copilot requires ui mode with run-tool-bindings and session-scoped-events capabilities";
    markHandshakeFailure("invalid-client", {
      client: connectParams.client.id,
      mode: connectParams.client.mode,
    });
    sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, message);
    close(1008, truncateCloseReason(message));
    return undefined;
  }
  if (isBrowserCopilot && !browserCopilotOrigin) {
    const message = "browser copilot requires a canonical Chrome extension origin";
    markHandshakeFailure("origin-mismatch", {
      origin: requestOrigin ?? "n/a",
      client: connectParams.client.id,
    });
    sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, message, {
      details: {
        code: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
        reason: "invalid browser copilot origin",
      },
    });
    close(1008, truncateCloseReason(message));
    return undefined;
  }
  const isControlUi = isOperatorUiClient(connectParams.client) && !isBrowserCopilot;
  const isBrowserOperatorUi = isBrowserOperatorUiClient(connectParams.client);
  const isWebchat = isWebchatConnect(connectParams);
  const isNativeAppUi =
    connectParams.client.mode === GATEWAY_CLIENT_MODES.UI &&
    (connectParams.client.id === GATEWAY_CLIENT_IDS.MACOS_APP ||
      connectParams.client.id === GATEWAY_CLIENT_IDS.IOS_APP ||
      connectParams.client.id === GATEWAY_CLIENT_IDS.ANDROID_APP);
  // Extension origins cannot match the gateway host. Admission validates their
  // canonical shape; device approval binds the exact origin before token issue.
  const hasCopilotExtensionOrigin = Boolean(browserCopilotOrigin);
  if (
    !hasCopilotExtensionOrigin &&
    (enforceOriginCheckForAnyClient || isBrowserOperatorUi || isWebchat)
  ) {
    const hostHeaderOriginFallbackEnabled =
      configSnapshot.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
    const originCheck = checkBrowserOrigin({
      requestHost,
      origin: requestOrigin,
      allowedOrigins: configSnapshot.gateway?.controlUi?.allowedOrigins,
      allowHostHeaderOriginFallback: hostHeaderOriginFallbackEnabled,
      isLocalClient,
    });
    if (!originCheck.ok) {
      const errorMessage =
        "origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)";
      markHandshakeFailure("origin-mismatch", {
        origin: requestOrigin ?? "n/a",
        host: requestHost ?? "n/a",
        reason: originCheck.reason,
      });
      sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, errorMessage, {
        details: {
          code: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
          reason: originCheck.reason,
        },
      });
      close(1008, truncateCloseReason(errorMessage));
      return undefined;
    }
    if (originCheck.matchedBy === "host-header-fallback") {
      originCheckMetrics.hostHeaderFallbackAccepted += 1;
      logWsControl.warn(
        `security warning: websocket origin accepted via Host-header fallback conn=${connId} count=${originCheckMetrics.hostHeaderFallbackAccepted} host=${requestHost ?? "n/a"} origin=${requestOrigin ?? "n/a"}`,
      );
      if (hostHeaderOriginFallbackEnabled) {
        logGateway.warn(
          "security metric: gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback accepted a websocket connect request",
        );
      }
    }
  }
  return {
    minProtocol,
    maxProtocol,
    usesLegacyNodeProtocol,
    role,
    scopes,
    isControlUi,
    isBrowserOperatorUi,
    isWebchat,
    isNativeAppUi,
  };
}
