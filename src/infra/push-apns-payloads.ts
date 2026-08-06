// Builds portable APNs payloads for alerts, wakes, and approval lifecycle events.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const EXEC_APPROVAL_GENERIC_ALERT_BODY = "Open OpenClaw to review this request.";
const PLUGIN_APPROVAL_ALERT_BODY_MAX_LENGTH = 256;

function toPushMetadata(params: {
  kind: "push.test" | "node.wake";
  nodeId: string;
  reason?: string;
}): { kind: "push.test" | "node.wake"; nodeId: string; ts: number; reason?: string } {
  return {
    kind: params.kind,
    nodeId: params.nodeId,
    ts: Date.now(),
    ...(params.reason ? { reason: params.reason } : {}),
  };
}

export function createApnsAlertPayload(params: {
  nodeId: string;
  title: string;
  body: string;
}): object {
  return {
    aps: {
      alert: {
        title: params.title,
        body: params.body,
      },
      sound: "default",
    },
    openclaw: toPushMetadata({
      kind: "push.test",
      nodeId: params.nodeId,
    }),
  };
}

export function createApnsBackgroundPayload(params: {
  nodeId: string;
  wakeReason?: string;
}): object {
  return {
    aps: {
      "content-available": 1,
    },
    openclaw: toPushMetadata({
      kind: "node.wake",
      reason: params.wakeReason ?? "node.invoke",
      nodeId: params.nodeId,
    }),
  };
}

export function resolveExecApprovalAlertBody(): string {
  return EXEC_APPROVAL_GENERIC_ALERT_BODY;
}

export function createApnsApprovalAlertPayload(params: {
  kind: "exec" | "plugin";
  approvalId: string;
  gatewayDeviceId: string;
  title: string;
  body: string;
  category: string;
}): object {
  return {
    aps: {
      alert: {
        title: params.title,
        body: params.body,
      },
      sound: "default",
      category: params.category,
      "content-available": 1,
    },
    openclaw: {
      kind: `${params.kind}.approval.requested`,
      approvalId: params.approvalId,
      gatewayDeviceId: params.gatewayDeviceId,
      ts: Date.now(),
    },
  };
}

export function resolvePluginApprovalAlertBody(description: string): string {
  const body = normalizeOptionalString(description) ?? "";
  if (body.length <= PLUGIN_APPROVAL_ALERT_BODY_MAX_LENGTH) {
    return body;
  }
  return `${truncateUtf16Safe(body, PLUGIN_APPROVAL_ALERT_BODY_MAX_LENGTH - 1).trimEnd()}…`;
}

export function createApnsApprovalResolvedPayload(params: {
  kind: "exec" | "plugin";
  approvalId: string;
  gatewayDeviceId: string;
}): object {
  return {
    aps: {
      "content-available": 1,
    },
    openclaw: {
      kind: `${params.kind}.approval.resolved`,
      approvalId: params.approvalId,
      gatewayDeviceId: params.gatewayDeviceId,
      ts: Date.now(),
    },
  };
}
