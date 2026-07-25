import { sha256HexPrefix } from "../../infra/crypto-digest.js";
import {
  emitTrustedSecurityEvent,
  type DiagnosticSecurityEventInput,
} from "../../infra/diagnostic-events.js";
import type { DeviceSessionAuthz } from "./device-management-authz.js";

type DeviceSecurityDecision = NonNullable<DiagnosticSecurityEventInput["policy"]>["decision"];

function hashDeviceSecurityId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return `sha256:${sha256HexPrefix(normalized, 12)}`;
}

export function emitDeviceManagementSecurityEvent(params: {
  action: string;
  outcome: DiagnosticSecurityEventInput["outcome"];
  severity: DiagnosticSecurityEventInput["severity"];
  authz: DeviceSessionAuthz;
  targetDeviceId?: string;
  policyId: string;
  decision: DeviceSecurityDecision;
  controlId: string;
  reason?: string;
  attributes?: Record<string, string | number | boolean>;
}) {
  emitTrustedSecurityEvent({
    category: "auth",
    action: params.action,
    outcome: params.outcome,
    severity: params.severity,
    actor: {
      kind: "operator",
      ...(params.authz.callerDeviceId
        ? { deviceIdHash: hashDeviceSecurityId(params.authz.callerDeviceId) }
        : {}),
      role: params.authz.isAdminCaller ? "admin" : "operator",
    },
    target: {
      kind: "device",
      ...(params.targetDeviceId ? { idHash: hashDeviceSecurityId(params.targetDeviceId) } : {}),
    },
    policy: {
      id: params.policyId,
      decision: params.decision,
      ...(params.reason ? { reason: params.reason } : {}),
    },
    control: { id: params.controlId, family: "auth" },
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.attributes ? { attributes: params.attributes } : {}),
  });
}
