import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";

export type ActivityRouteData = {
  mode: "live" | "run";
  runId: string | null;
};

export type RunInspectorState =
  | { status: "empty" }
  | { status: "loading"; runId: string; waitingForGateway: boolean }
  | { status: "disconnected"; runId: string }
  | { status: "unauthorized"; runId: string }
  | { status: "unsupported"; runId: string }
  | { status: "error"; runId: string }
  | { status: "ready"; runId: string; result: AuditRunInspectResult };

type RunInspectorDiagnosticKind =
  | "present"
  | "not-found"
  | "expired"
  | "corrupt"
  | "ambiguous"
  | "unknown"
  | "unsupported";

export function classifyRunInspection(result: AuditRunInspectResult): RunInspectorDiagnosticKind {
  const identity = result.identity;
  if (identity.state === "present") {
    return "present";
  }
  if (identity.state === "ambiguous") {
    return "ambiguous";
  }
  if (identity.reasonCode === "run_not_found" || identity.reasonCode === "execution_not_found") {
    return "not-found";
  }
  if (identity.reasonCode === "identity_context_corrupt") {
    return "corrupt";
  }
  if (
    identity.state === "unsupported" &&
    identity.remediation.some((item) => item.code === "run_again_after_expiry")
  ) {
    return "expired";
  }
  return identity.state;
}
