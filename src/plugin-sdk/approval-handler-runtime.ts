/**
 * Runtime SDK subpath for approval handler adapters and approval view text helpers.
 */
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
export { resolveApprovalOverGateway } from "./approval-gateway-runtime.js";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import type {
  ExpiredApprovalView,
  ResolvedApprovalView,
} from "../infra/approval-view-model.types.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "../infra/exec-approvals.js";
import {
  buildPluginApprovalExpiredMessage,
  buildPluginApprovalResolvedMessage,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "../infra/plugin-approvals.js";
import { buildApprovalResolvedReplyPayload } from "./approval-renderers.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;

/** Builds channel-visible resolved approval text for exec and plugin approvals. */
export function buildChannelApprovalResolvedText(params: {
  request: ApprovalRequest;
  resolved: ApprovalResolved;
  view: ResolvedApprovalView;
}): string {
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
  if (params.view.approvalKind === "plugin") {
    return buildPluginApprovalExpiredMessage(params.request as PluginApprovalRequest);
  }
  return `⏱️ Exec approval expired. ID: ${params.request.id}`;
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
