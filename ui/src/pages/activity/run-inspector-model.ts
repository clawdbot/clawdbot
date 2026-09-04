import type {
  AuditRunInspectResult,
  DecisionReceiptDisplayV1,
} from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { pathForRoute } from "../../app-route-paths.ts";
import { parseSessionActivityFilters, type SessionActivityFilters } from "./session-activity.ts";

export type RunInspectorSelector = { kind: "run" | "execution"; id: string };

export type ActivityRouteData =
  | { mode: "sessions"; filters: SessionActivityFilters; selector: null }
  | { mode: "live"; selector: null }
  | {
      mode: "run";
      selector: RunInspectorSelector | null;
      selectorId: string | null;
      decisionCursor: string | null;
    };

export function activityRunInspectorSearch(
  selector: RunInspectorSelector,
  receipt?: { id: string; decisionCursor?: string },
): string {
  let search = `?view=run&${selector.kind}=${encodeURIComponent(selector.id)}`;
  if (receipt) {
    search += `&receipt=${encodeURIComponent(receipt.id)}`;
    if (receipt.decisionCursor) {
      search += `&decision=${encodeURIComponent(receipt.decisionCursor)}`;
    }
  }
  return search;
}

export function activityRunInspectorSelectorHref(
  selector: RunInspectorSelector,
  basePath: string,
  receipt?: { id: string; decisionCursor?: string },
): string {
  return `${pathForRoute("activity", basePath)}${activityRunInspectorSearch(selector, receipt)}`;
}

export function activityRunInspectorHref(runId: string, basePath: string): string {
  return activityRunInspectorSelectorHref({ kind: "run", id: runId }, basePath);
}

export function resolveActivityRouteData(
  search: string,
  pathPersonId?: string | null,
): ActivityRouteData {
  const params = new URLSearchParams(search);
  if (params.get("view") === "live") {
    return { mode: "live", selector: null };
  }
  if (params.get("view") !== "run") {
    return {
      mode: "sessions",
      filters: parseSessionActivityFilters(search, pathPersonId),
      selector: null,
    };
  }
  const executionId = params.get("execution");
  const selectorId = params.get("receipt")?.trim() || null;
  const decisionCursor = selectorId ? params.get("decision")?.trim() || null : null;
  if (executionId?.trim()) {
    return {
      mode: "run",
      selector: { kind: "execution", id: executionId },
      selectorId,
      decisionCursor,
    };
  }
  const runId = params.get("run");
  return {
    mode: "run",
    selector: runId?.trim() ? { kind: "run", id: runId } : null,
    selectorId,
    decisionCursor,
  };
}

type ReceiptPageCursorMap = ReadonlyMap<string, string | undefined>;

export type RunInspectorResult = AuditRunInspectResult;

export type RunInspectorState =
  | { status: "empty" }
  | { status: "loading"; waitingForGateway: boolean }
  | { status: "disconnected" }
  | { status: "unauthorized" }
  | { status: "unsupported" }
  | { status: "error"; recovery: "restart" | "retry" }
  | {
      status: "ready";
      result: RunInspectorResult;
      executionPageStatus?: "loading" | "error";
      decisionPageStatus?: "loading" | "error";
      receiptPageCursors: ReceiptPageCursorMap;
    };

export function receiptPageCursors(
  receipts: readonly DecisionReceiptDisplayV1[],
  cursor?: string,
): ReceiptPageCursorMap {
  return new Map(receipts.map((receipt) => [receipt.selectorId, cursor]));
}

export function mergeDecisionPage(
  previous: RunInspectorResult,
  page: RunInspectorResult,
): RunInspectorResult | null {
  if (
    previous.identity.state !== "present" ||
    page.identity.state !== "present" ||
    previous.run.executionId !== page.run.executionId ||
    previous.identity.context.contextId !== page.identity.context.contextId
  ) {
    return null;
  }
  const decisions = new Map(
    previous.decisionDisplays.map((receipt) => [receipt.selectorId, receipt]),
  );
  for (const receipt of page.decisionDisplays) {
    decisions.set(receipt.selectorId, receipt);
  }
  return {
    ...page,
    decisionDisplays: [...decisions.values()],
  };
}

type RunInspectorDiagnosticKind =
  | "present"
  | "not-found"
  | "expired"
  | "corrupt"
  | "ambiguous"
  | "unknown"
  | "unsupported";

export function classifyRunInspection(result: RunInspectorResult): RunInspectorDiagnosticKind {
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
