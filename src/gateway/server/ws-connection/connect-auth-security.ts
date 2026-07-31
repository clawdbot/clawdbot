// Gateway WebSocket authentication security events keep identifiers redacted.
import { sha256HexPrefix } from "../../../infra/crypto-digest.js";
import {
  emitTrustedSecurityEvent,
  type DiagnosticSecurityEventInput,
} from "../../../infra/diagnostic-events.js";

function hashGatewaySecurityId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return `sha256:${sha256HexPrefix(normalized, 12)}`;
}

export function emitGatewayAuthSecurityEvent(params: {
  action: "gateway.auth.succeeded" | "gateway.auth.failed";
  outcome: DiagnosticSecurityEventInput["outcome"];
  severity: DiagnosticSecurityEventInput["severity"];
  authMode: string;
  authMethod?: string;
  authProvided?: string;
  role: string;
  scopes: readonly string[];
  clientMode?: string;
  deviceId?: string;
  reason?: string;
  rateLimited?: boolean;
}) {
  emitTrustedSecurityEvent({
    category: "auth",
    action: params.action,
    outcome: params.outcome,
    severity: params.severity,
    actor: {
      kind: params.role === "node" ? "node" : "operator",
      ...(params.deviceId ? { deviceIdHash: hashGatewaySecurityId(params.deviceId) } : {}),
      role: params.role,
    },
    target: { kind: "gateway", name: "websocket" },
    policy: {
      id: "gateway.websocket-auth",
      decision: params.outcome === "success" ? "allow" : "deny",
      ...(params.reason ? { reason: params.reason } : {}),
    },
    control: { id: "gateway.ws.connect", family: "auth" },
    ...(params.reason ? { reason: params.reason } : {}),
    attributes: {
      auth_mode: params.authMode,
      auth_method: params.authMethod ?? "unknown",
      auth_provided: params.authProvided ?? "unknown",
      client_mode: params.clientMode ?? "unknown",
      has_device_identity: Boolean(params.deviceId),
      scope_count: params.scopes.length,
      ...(params.rateLimited !== undefined ? { rate_limited: params.rateLimited } : {}),
    },
  });
}
