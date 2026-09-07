/**
 * Runtime SDK subpath for approval handler adapters and approval view text helpers.
 */
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeApprovalRequest } from "../infra/approval-types.js";
import type { ApprovalRequestInput } from "../infra/approval-types.js";
import type {
  ExpiredApprovalView,
  ResolvedApprovalView,
} from "../infra/approval-view-model.types.js";
import type { ExecApprovalResolved } from "../infra/exec-approvals.js";
import {
  buildPluginApprovalExpiredMessage,
  buildPluginApprovalResolvedMessage,
  type PluginApprovalResolved,
} from "../infra/plugin-approvals.js";
import type { SystemAgentApprovalResolved } from "../infra/system-agent-approvals.js";
import { buildApprovalResolvedReplyPayload } from "./approval-renderers.js";
export {
  createChannelApprovalHandler,
  createChannelApprovalNativeRuntimeAdapter,
  createChannelApprovalHandlerFromCapability,
  createLazyChannelApprovalNativeRuntimeAdapter,
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  type ApprovalActionView,
  type ApprovalMetadataView,
  type ApprovalViewModel,
  type ExecApprovalExpiredView,
  type ExecApprovalPendingView,
  type ExecApprovalResolvedView,
  type ChannelApprovalNativeFinalAction,
  type ChannelApprovalNativeAvailabilityAdapter,
  type ChannelApprovalNativeInteractionAdapter,
  type ChannelApprovalNativeObserveAdapter,
  type ChannelApprovalNativePresentationAdapter,
  type ChannelApprovalNativeRuntimeAdapter,
  type ChannelApprovalNativeRuntimeSpec,
  type ChannelApprovalNativeTransportAdapter,
  type ChannelApprovalHandler,
  type ChannelApprovalHandlerAdapter,
  type ChannelApprovalCapabilityHandlerContext,
  type ExpiredApprovalView,
  type PendingApprovalView,
  type PluginApprovalExpiredView,
  type PluginApprovalPendingView,
  type PluginApprovalResolvedView,
  type ResolvedApprovalView,
} from "../infra/approval-handler-runtime.js";
export type { ChannelApprovalKind } from "../infra/approval-handler-runtime-types.js";
export { resolveApprovalOverGateway } from "./approval-gateway-runtime.js";

type ApprovalRequest = ApprovalRequestInput;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved | SystemAgentApprovalResolved;

type SystemAgentResolvedView = Extract<ResolvedApprovalView, { approvalKind: "system-agent" }>;
type ApprovalTerminalOutcome =
  | ResolvedApprovalView["decision"]
  | "cancelled"
  | "applied"
  | "not-applied";

const TERMINAL_LABELS = {
  "allow-once": "Allowed once",
  "allow-always": "Allowed always",
  deny: "Denied",
  cancelled: "Cancelled",
  applied: "Applied",
  "not-applied": "Not applied",
};

/** Label a recorded decision without implying that a system change was applied. */
export function formatApprovalDecisionLabel(decision: ResolvedApprovalView["decision"]): string {
  return TERMINAL_LABELS[decision];
}

function interpretApprovalTerminalOutcome(
  view: ResolvedApprovalView,
  precedence: "application" | "denial",
): ApprovalTerminalOutcome {
  if (view.approvalKind !== "system-agent") {
    return view.decision;
  }
  if (view.terminalStatus === "cancelled") {
    return "cancelled";
  }
  // Denied changes also publish not-applied. Preserve rich-label and prose precedence.
  return precedence === "denial" && view.decision === "deny"
    ? "deny"
    : (view.applicationStatus ?? view.decision);
}

/** Format a rich terminal label, retaining transport-specific decision spelling. */
export function formatChannelApprovalResolvedLabel(
  view: ResolvedApprovalView,
  formatDecision?: (decision: ResolvedApprovalView["decision"]) => string,
): string {
  const outcome = interpretApprovalTerminalOutcome(view, "application");
  return formatDecision && outcome === view.decision
    ? formatDecision(view.decision)
    : TERMINAL_LABELS[outcome];
}

/** Describe a system change using denial-first prose and a prepared operation summary. */
export function buildSystemAgentApprovalResolvedText(view: SystemAgentResolvedView): string {
  const outcome = interpretApprovalTerminalOutcome(view, "denial");
  return outcome === "cancelled"
    ? "⚠️ OpenClaw change was cancelled because its run ended. No change was made. Retry."
    : outcome === "deny"
      ? "❌ OpenClaw change denied. No change was made."
      : outcome === "applied"
        ? `✅ OpenClaw change approved and applied: ${view.operationSummary}`
        : outcome === "not-applied"
          ? "⚠️ OpenClaw change approved, but it was not applied. Check the Gateway and retry."
          : `✅ OpenClaw change approved. Applying: ${view.operationSummary}`;
}

/** Builds channel-visible resolved approval text for every approval kind. */
export function buildChannelApprovalResolvedText(params: {
  request: ApprovalRequest;
  resolved: ApprovalResolved;
  view: ResolvedApprovalView;
}): string {
  if (params.view.approvalKind === "system-agent") {
    return buildSystemAgentApprovalResolvedText({
      ...params.view,
      decision: params.resolved.decision,
    });
  }
  if (params.view.approvalKind === "plugin") {
    return buildPluginApprovalResolvedMessage(params.resolved as PluginApprovalResolved);
  }
  const resolvedByText = params.resolved.resolvedBy
    ? ` Resolved by ${params.resolved.resolvedBy}.`
    : "";
  const payload = buildApprovalResolvedReplyPayload({
    approvalId: params.request.id,
    approvalSlug: params.request.id.slice(0, 8),
    text: `✅ Exec approval ${params.resolved.decision}.${resolvedByText} ID: ${params.request.id}`,
  });
  return payload.text ?? "";
}

/** Builds channel-visible expiration text for exec and plugin approvals. */
export function buildChannelApprovalExpiredText(params: {
  request: ApprovalRequest;
  view: ExpiredApprovalView;
}): string {
  const request = normalizeApprovalRequest(params.request);
  if (request.approvalKind === "system-agent") {
    return "⏱️ OpenClaw change expired. No change was made.";
  }
  if (request.approvalKind === "plugin") {
    return buildPluginApprovalExpiredMessage(request);
  }
  return `⏱️ Exec approval expired. ID: ${request.id}`;
}

/** Resolves the account id prepared for approval routing with planned/context fallback order. */
export function resolvePreparedApprovalAccountId(params: {
  plannedAccountId?: string | null;
  contextAccountId?: string | null;
  fallbackAccountId: string;
}): string;
/** Resolve prepared approval account id when every source may be missing. */
export function resolvePreparedApprovalAccountId(params: {
  plannedAccountId?: string | null;
  contextAccountId?: string | null;
  fallbackAccountId?: string | null;
}): string | undefined;
export function resolvePreparedApprovalAccountId(params: {
  plannedAccountId?: string | null;
  contextAccountId?: string | null;
  fallbackAccountId?: string | null;
}): string | undefined {
  return (
    normalizeOptionalString(params.plannedAccountId) ??
    normalizeOptionalString(params.contextAccountId) ??
    normalizeOptionalString(params.fallbackAccountId)
  );
}
