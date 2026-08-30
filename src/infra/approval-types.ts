// Approval kind is shared by exec and plugin approval routing surfaces.
import type { ExecApprovalRequest } from "./exec-approvals-core.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

export type ChannelApprovalKind = "exec" | "plugin";
export type ApprovalRequestChannelRouteClass = "bound-or-explicit" | "unbound";

/** Backward-compatible request shape accepted from Gateway events and replay. */
export type ApprovalRequestInput = ExecApprovalRequest | PluginApprovalRequest;

/** Canonical request shape used after the Gateway read boundary. */
export type ApprovalRequest =
  | (ExecApprovalRequest & { approvalKind: "exec" })
  | (PluginApprovalRequest & { approvalKind: "plugin" });

export type NormalizedApprovalRequest<TRequest extends ApprovalRequestInput> =
  TRequest extends ExecApprovalRequest
    ? TRequest & { approvalKind: "exec" }
    : TRequest extends PluginApprovalRequest
      ? TRequest & { approvalKind: "plugin" }
      : never;

function deriveApprovalRequestKind(request: { request: object }): ChannelApprovalKind {
  const isExec = "command" in request.request;
  const isPlugin = "title" in request.request && "description" in request.request;
  if (isExec === isPlugin) {
    throw new Error("approval request payload does not identify exactly one owner");
  }
  return isExec ? "exec" : "plugin";
}

function isExecApprovalRequest(request: ApprovalRequestInput): request is ExecApprovalRequest {
  return deriveApprovalRequestKind(request) === "exec";
}

function hasExecApprovalKind(
  request: ExecApprovalRequest,
): request is ExecApprovalRequest & { approvalKind: "exec" } {
  return request.approvalKind === "exec";
}

function hasPluginApprovalKind(
  request: PluginApprovalRequest,
): request is PluginApprovalRequest & { approvalKind: "plugin" } {
  return request.approvalKind === "plugin";
}

/**
 * Normalizes old wire/persisted requests at the read boundary. The payload remains
 * authoritative so untrusted descriptive metadata can never select an approval owner.
 * Return a copy so deriving metadata never changes legacy serialized input.
 */
export function normalizeApprovalRequest<TRequest extends ApprovalRequestInput>(
  request: TRequest,
): NormalizedApprovalRequest<TRequest>;
export function normalizeApprovalRequest(request: ApprovalRequestInput): ApprovalRequest {
  if (isExecApprovalRequest(request)) {
    if (hasExecApprovalKind(request)) {
      return request;
    }
    return { ...request, approvalKind: "exec" };
  }
  if (hasPluginApprovalKind(request)) {
    return request;
  }
  return { ...request, approvalKind: "plugin" };
}

/** Resolve approval ownership from the typed request payload, never from id spelling. */
export function resolveApprovalRequestKind(request: { request: object }): ChannelApprovalKind {
  return deriveApprovalRequestKind(request);
}
