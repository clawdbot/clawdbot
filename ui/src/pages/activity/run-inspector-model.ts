import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { pathForRoute } from "../../app-route-paths.ts";
import { parseSessionActivityFilters, type SessionActivityFilters } from "./session-activity.ts";

export type RunInspectorSelector = { kind: "run" | "execution"; id: string };

export type ActivityRouteData =
  | { mode: "sessions"; filters: SessionActivityFilters; selector: null }
  | { mode: "live"; selector: null }
  | { mode: "run"; selector: RunInspectorSelector | null };

export function activityRunInspectorHref(runId: string, basePath: string): string {
  return `${pathForRoute("activity", basePath)}?view=run&run=${encodeURIComponent(runId)}`;
}

export function resolveActivityRouteData(search: string): ActivityRouteData {
  const params = new URLSearchParams(search);
  if (params.get("view") === "live") {
    return { mode: "live", selector: null };
  }
  if (params.get("view") !== "run") {
    return { mode: "sessions", filters: parseSessionActivityFilters(search), selector: null };
  }
  const executionId = params.get("execution");
  if (executionId?.trim()) {
    return { mode: "run", selector: { kind: "execution", id: executionId } };
  }
  const runId = params.get("run");
  return {
    mode: "run",
    selector: runId?.trim() ? { kind: "run", id: runId } : null,
  };
}

export type RunInspectorState =
  | { status: "empty" }
  | { status: "loading"; waitingForGateway: boolean }
  | { status: "disconnected" }
  | { status: "unauthorized" }
  | { status: "unsupported" }
  | { status: "error" }
  | {
      status: "ready";
      result: AuditRunInspectResult;
      executionPageStatus?: "loading" | "error";
    };

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
