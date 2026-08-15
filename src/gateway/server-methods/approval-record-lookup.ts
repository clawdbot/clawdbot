import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type {
  ExecApprovalIdLookupResult,
  ExecApprovalManager,
  ExecApprovalRecord,
} from "../exec-approval-manager.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../method-scopes.js";
import type { GatewayClient, RespondFn } from "./types.js";

const APPROVAL_NOT_FOUND_DETAILS = {
  reason: ErrorCodes.APPROVAL_NOT_FOUND,
  remediation: "Re-request the action; pending approvals are cleared after expiry or restart.",
} as const;

type PendingApprovalLookupError =
  | "missing"
  | { code: (typeof ErrorCodes)["INVALID_REQUEST"]; message: string };

export type ApprovalRecordLookupResult<TPayload> =
  | { ok: true; approvalId: string; snapshot: ExecApprovalRecord<TPayload> }
  | { ok: false; response: PendingApprovalLookupError };

function normalizeApprovalIdentity(value: string | null | undefined): string | null {
  return normalizeOptionalString(value) ?? null;
}

export function normalizeApprovalIdentities(
  values: readonly string[] | null | undefined,
): string[] {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const identity = normalizeApprovalIdentity(value);
    if (identity) {
      normalized.add(identity);
    }
  }
  return [...normalized];
}

export function isApprovalRecordVisibleToClient<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  client: GatewayClient | null;
}): boolean {
  const scopes = Array.isArray(params.client?.connect?.scopes) ? params.client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  const requestedByDeviceId = normalizeApprovalIdentity(params.record.requestedByDeviceId);
  const requestedByClientId = normalizeApprovalIdentity(params.record.requestedByClientId);
  const hasApprovalsScope = scopes.includes(APPROVALS_SCOPE);
  if (hasApprovalsScope && params.client?.internal?.approvalRuntime === true) {
    return true;
  }
  const approvalReviewerDeviceIds = normalizeApprovalIdentities(
    params.record.approvalReviewerDeviceIds,
  );
  const clientDeviceId = normalizeApprovalIdentity(params.client?.connect?.device?.id);
  if (hasApprovalsScope && clientDeviceId && approvalReviewerDeviceIds.includes(clientDeviceId)) {
    return true;
  }
  // Legacy adapters retain exact requester connection/device authority.
  if (requestedByDeviceId) {
    return requestedByDeviceId === clientDeviceId;
  }
  const requestedByConnId = normalizeApprovalIdentity(params.record.requestedByConnId);
  if (requestedByConnId) {
    return requestedByConnId === normalizeApprovalIdentity(params.client?.connId);
  }
  if (requestedByClientId || approvalReviewerDeviceIds.length > 0) {
    return false;
  }
  // Pre-binding pending approvals remain operable after upgrades and restarts.
  return true;
}

export function listVisiblePendingApprovalRequests<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  client?: GatewayClient | null;
}): Array<{ id: string; request: TPayload; createdAtMs: number; expiresAtMs: number }> {
  return params.manager
    .listPendingRecords()
    .filter((record) => isApprovalRecordVisibleToClient({ record, client: params.client ?? null }))
    .map(({ id, request, createdAtMs, expiresAtMs }) => ({
      id,
      request,
      createdAtMs,
      expiresAtMs,
    }));
}

function resolveLookupError(params: {
  resolvedId: ExecApprovalIdLookupResult;
  exposeAmbiguousPrefixError?: boolean;
}): PendingApprovalLookupError {
  if (
    params.resolvedId.kind === "none" ||
    (params.resolvedId.kind === "ambiguous" && !params.exposeAmbiguousPrefixError)
  ) {
    return "missing";
  }
  return {
    code: ErrorCodes.INVALID_REQUEST,
    message: "ambiguous approval id prefix; use the full id",
  };
}

function resolveApprovalRecordForState<TPayload>(
  params: {
    manager: ExecApprovalManager<TPayload>;
    inputId: string;
    client?: GatewayClient | null;
    exposeAmbiguousPrefixError?: boolean;
    recordFilter?: (record: ExecApprovalRecord<TPayload>) => boolean;
  },
  expectedState: "pending" | "resolved",
): ApprovalRecordLookupResult<TPayload> {
  const resolvedId = params.manager.lookupApprovalId(params.inputId, {
    includeResolved: expectedState === "resolved",
    filter: (record) =>
      isApprovalRecordVisibleToClient({ record, client: params.client ?? null }) &&
      (params.recordFilter?.(record) ?? true),
  });
  if (resolvedId.kind !== "exact" && resolvedId.kind !== "prefix") {
    return { ok: false, response: resolveLookupError({ ...params, resolvedId }) };
  }
  const snapshot = params.manager.getSnapshot(resolvedId.id);
  const isResolved = snapshot?.resolvedAtMs !== undefined;
  return !snapshot || isResolved !== (expectedState === "resolved")
    ? { ok: false, response: "missing" }
    : { ok: true, approvalId: resolvedId.id, snapshot };
}

export function resolvePendingApprovalRecord<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  inputId: string;
  client?: GatewayClient | null;
  exposeAmbiguousPrefixError?: boolean;
  recordFilter?: (record: ExecApprovalRecord<TPayload>) => boolean;
}): ApprovalRecordLookupResult<TPayload> {
  return resolveApprovalRecordForState(params, "pending");
}

export function resolveResolvedApprovalRecord<TPayload>(
  params: Parameters<typeof resolvePendingApprovalRecord<TPayload>>[0],
): ApprovalRecordLookupResult<TPayload> {
  return resolveApprovalRecordForState(params, "resolved");
}

export function respondUnknownOrExpiredApproval(respond: RespondFn): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id", {
      details: APPROVAL_NOT_FOUND_DETAILS,
    }),
  );
}

export function respondPendingApprovalLookupError(params: {
  respond: RespondFn;
  response: PendingApprovalLookupError;
}): void {
  if (params.response === "missing") {
    respondUnknownOrExpiredApproval(params.respond);
    return;
  }
  params.respond(false, undefined, errorShape(params.response.code, params.response.message));
}
