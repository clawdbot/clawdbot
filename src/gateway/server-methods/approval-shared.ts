// Approval shared helpers normalize pending exec/plugin approval lookups,
// decision payloads, turn-source routing, and gateway error responses.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ValidationError } from "../../../packages/gateway-protocol/src/index.js";
import { hasApprovalTurnSourceRoute } from "../../infra/approval-turn-source.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type {
  ExecApprovalIdLookupResult,
  ExecApprovalManager,
  ExecApprovalRecord,
} from "../exec-approval-manager.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../method-scopes.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const APPROVAL_NOT_FOUND_DETAILS = {
  reason: ErrorCodes.APPROVAL_NOT_FOUND,
  remediation: "Re-request the action; pending approvals are cleared after expiry or restart.",
} as const;

const APPROVAL_ALREADY_RESOLVED_DETAILS = {
  reason: "APPROVAL_ALREADY_RESOLVED",
} as const;

function resolveRecordedApprovalDecision<TPayload>(
  record: ExecApprovalRecord<TPayload>,
): ExecApprovalDecision | undefined {
  return record.decision ?? record.consumedDecision;
}

type PendingApprovalLookupError =
  | "missing"
  | {
      code: (typeof ErrorCodes)["INVALID_REQUEST"];
      message: string;
    };

type ApprovalTurnSourceFields = {
  turnSourceChannel?: string | null;
  turnSourceAccountId?: string | null;
};

type RequestedApprovalEvent<TPayload extends ApprovalTurnSourceFields> = {
  id: string;
  request: TPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

type PendingApprovalListEntry<TPayload> = {
  id: string;
  request: TPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

type ApprovalRequestDeliveryRoute = "approval-client" | "forwarder" | "turn-source" | "none";

type ApprovalResolveParams = {
  id: string;
  decision: string;
};

type ApprovalResolveParamsValidator<TParams extends ApprovalResolveParams> = ((
  params: unknown,
) => params is TParams) & {
  errors?: ValidationError[] | null;
};

type ApprovalRecordLookupResult<TPayload> =
  | {
      ok: true;
      approvalId: string;
      snapshot: ExecApprovalRecord<TPayload>;
    }
  | {
      ok: false;
      response: PendingApprovalLookupError;
    };

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function isApprovalDecision(value: string): value is ExecApprovalDecision {
  return value === "allow-once" || value === "allow-always" || value === "deny";
}

function respondUnknownOrExpiredApproval(respond: RespondFn): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id", {
      details: APPROVAL_NOT_FOUND_DETAILS,
    }),
  );
}

function resolvePendingApprovalLookupError(params: {
  resolvedId: ExecApprovalIdLookupResult;
  exposeAmbiguousPrefixError?: boolean;
}): PendingApprovalLookupError {
  if (params.resolvedId.kind === "none") {
    return "missing";
  }
  if (params.resolvedId.kind === "ambiguous" && !params.exposeAmbiguousPrefixError) {
    return "missing";
  }
  return {
    code: ErrorCodes.INVALID_REQUEST,
    message: "ambiguous approval id prefix; use the full id",
  };
}

function normalizeApprovalIdentity(value: string | null | undefined): string | null {
  return normalizeOptionalString(value) ?? null;
}

function normalizeApprovalIdentities(values: readonly string[] | null | undefined): string[] {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const identity = normalizeApprovalIdentity(value);
    if (identity) {
      normalized.add(identity);
    }
  }
  return [...normalized];
}

/** Checks whether a client can observe or resolve an approval record. */
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

  // Shipped legacy adapters retain exact requester connection/device authority.
  // Unified durable methods apply their separate record authorization after lookup.
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

  // Unbound approvals predate requester metadata and remain visible so pending
  // work can still be resolved after upgrades or gateway restarts.
  return true;
}

/** Returns only pending approval requests the connected client is allowed to see. */
export function listVisiblePendingApprovalRequests<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  client?: GatewayClient | null;
}): PendingApprovalListEntry<TPayload>[] {
  return params.manager
    .listPendingRecords()
    .filter((record) =>
      isApprovalRecordVisibleToClient({
        record,
        client: params.client ?? null,
      }),
    )
    .map((record) => ({
      id: record.id,
      request: record.request,
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
    }));
}

/** Binds the current gateway client identity onto a newly-created approval record. */
export function bindApprovalRequesterMetadata<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  client?: GatewayClient | null;
}): void {
  params.record.requestedByConnId = params.client?.connId ?? null;
  params.record.requestedByDeviceId = params.client?.connect?.device?.id ?? null;
  params.record.requestedByClientId = params.client?.connect?.client?.id ?? null;
  params.record.requestedByDeviceTokenAuth = params.client?.isDeviceTokenAuth === true;
}

export function bindApprovalReviewerDeviceIds<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  deviceIds?: readonly string[] | null;
}): void {
  const deviceIds = normalizeApprovalIdentities(params.deviceIds);
  if (deviceIds.length > 0) {
    params.record.approvalReviewerDeviceIds = deviceIds;
  }
}

function respondApprovalStorageUnavailable(params: {
  context: GatewayRequestContext;
  respond: RespondFn;
  operation: "request" | "resolve";
  error: unknown;
}): void {
  params.context.logGateway?.error?.(
    `approval ${params.operation} storage failure: ${String(params.error)}`,
  );
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, `approval ${params.operation} unavailable`),
  );
}

/** Registers an approval record and converts manager registration errors to gateway errors. */
export function registerPendingApprovalRecord<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  record: ExecApprovalRecord<TPayload>;
  timeoutMs: number;
  respond: RespondFn;
  context: GatewayRequestContext;
}): Promise<ExecApprovalDecision | null> | undefined {
  try {
    return params.manager.register(params.record, params.timeoutMs);
  } catch (err) {
    respondApprovalStorageUnavailable({ ...params, operation: "request", error: err });
    return undefined;
  }
}

/** Builds the gateway event payload broadcast when an approval starts waiting. */
export function buildRequestedApprovalEvent<TPayload extends ApprovalTurnSourceFields>(
  record: ExecApprovalRecord<TPayload>,
): RequestedApprovalEvent<TPayload> {
  return {
    id: record.id,
    request: record.request,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  };
}

/** Validates approval resolve params and narrows the decision to the supported enum. */
export function resolveApprovalDecisionParams<TParams extends ApprovalResolveParams>(params: {
  rawParams: unknown;
  validate: ApprovalResolveParamsValidator<TParams>;
  methodName: string;
  respond: RespondFn;
}): { inputId: string; decision: ExecApprovalDecision } | null {
  const rawParams = params.rawParams;
  if (!params.validate(rawParams)) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid ${params.methodName} params: ${formatValidationErrors(params.validate.errors)}`,
      ),
    );
    return null;
  }
  if (!isApprovalDecision(rawParams.decision)) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
    return null;
  }
  return {
    inputId: rawParams.id,
    decision: rawParams.decision,
  };
}

/** Resolves the approval clients that should receive request or resolution events. */
export function resolveApprovalRequestRecipientConnIds<TPayload>(params: {
  context: GatewayRequestContext;
  record: ExecApprovalRecord<TPayload>;
  excludeConnId?: string;
}): ReadonlySet<string> | null {
  return (
    params.context.getApprovalClientConnIds?.({
      excludeConnId: params.excludeConnId,
      record: params.record,
      filter: (client) =>
        isApprovalRecordVisibleToClient({
          record: params.record,
          client,
        }),
    }) ?? null
  );
}

/** Finds a pending approval by full id or prefix after applying client visibility rules. */
export function resolvePendingApprovalRecord<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  inputId: string;
  client?: GatewayClient | null;
  exposeAmbiguousPrefixError?: boolean;
}): ApprovalRecordLookupResult<TPayload> {
  return resolveApprovalRecordForState(params, "pending");
}

function resolveResolvedApprovalRecord<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  inputId: string;
  client?: GatewayClient | null;
  exposeAmbiguousPrefixError?: boolean;
}): ApprovalRecordLookupResult<TPayload> {
  return resolveApprovalRecordForState(params, "resolved");
}

function resolveApprovalRecordForState<TPayload>(
  params: {
    manager: ExecApprovalManager<TPayload>;
    inputId: string;
    client?: GatewayClient | null;
    exposeAmbiguousPrefixError?: boolean;
  },
  expectedState: "pending" | "resolved",
): ApprovalRecordLookupResult<TPayload> {
  const resolvedId = params.manager.lookupApprovalId(params.inputId, {
    includeResolved: expectedState === "resolved",
    filter: (record) =>
      isApprovalRecordVisibleToClient({
        record,
        client: params.client ?? null,
      }),
  });
  if (resolvedId.kind !== "exact" && resolvedId.kind !== "prefix") {
    return {
      ok: false,
      response: resolvePendingApprovalLookupError({
        resolvedId,
        exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError,
      }),
    };
  }
  const snapshot = params.manager.getSnapshot(resolvedId.id);
  const isResolved = snapshot?.resolvedAtMs !== undefined;
  if (!snapshot || isResolved !== (expectedState === "resolved")) {
    return { ok: false, response: "missing" };
  }
  return { ok: true, approvalId: resolvedId.id, snapshot };
}

/** Sends the public lookup failure shape for missing, expired, or ambiguous approvals. */
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

/** Waits for an already-registered approval decision visible to the caller. */
export async function handleApprovalWaitDecision<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  inputId: unknown;
  client?: GatewayClient | null;
  respond: RespondFn;
}): Promise<void> {
  const id = normalizeOptionalString(params.inputId) ?? "";
  if (!id) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
    return;
  }
  const snapshot = params.manager.getSnapshot(id);
  if (
    !snapshot ||
    !isApprovalRecordVisibleToClient({
      record: snapshot,
      client: params.client ?? null,
    })
  ) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"),
    );
    return;
  }
  const decisionPromise = params.manager.awaitDecision(id);
  if (!decisionPromise) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"),
    );
    return;
  }
  const decision = await decisionPromise;
  params.respond(
    true,
    {
      id,
      decision,
      createdAtMs: snapshot?.createdAtMs,
      expiresAtMs: snapshot?.expiresAtMs,
    },
    undefined,
  );
}

/** Broadcasts or routes a pending approval request, then responds after acceptance/decision. */
export async function handlePendingApprovalRequest<
  TPayload extends ApprovalTurnSourceFields,
>(params: {
  manager: ExecApprovalManager<TPayload>;
  record: ExecApprovalRecord<TPayload>;
  decisionPromise: Promise<ExecApprovalDecision | null>;
  respond: RespondFn;
  context: GatewayRequestContext;
  clientConnId?: string;
  requestEventName: string;
  requestEvent: RequestedApprovalEvent<TPayload>;
  twoPhase: boolean;
  approvalKind?: "exec" | "plugin";
  deliverRequest: () => boolean | Promise<boolean>;
  afterDecision?: (
    decision: ExecApprovalDecision | null,
    requestEvent: RequestedApprovalEvent<TPayload>,
  ) => Promise<void> | void;
  afterDecisionErrorLabel?: string;
  keepPendingWithoutRoute?: boolean;
  requireDeliveryRoute?: boolean;
  suppressDelivery?: boolean;
}): Promise<void> {
  // Delivery may outlive the normal resolved-record grace. Keep the executable
  // binding until the requester response and post-decision handoff finish.
  const releaseHandoff = params.manager.retainForHandoff(params.record.id);
  try {
    const suppressDelivery = params.suppressDelivery === true;
    const approvalClientConnIds = suppressDelivery
      ? null
      : resolveApprovalRequestRecipientConnIds({
          context: params.context,
          record: params.record,
          excludeConnId: params.clientConnId,
        });
    if (!suppressDelivery) {
      if (approvalClientConnIds) {
        params.context.broadcastToConnIds(
          params.requestEventName,
          params.requestEvent,
          approvalClientConnIds,
          {
            dropIfSlow: true,
          },
        );
      } else {
        params.context.broadcast(params.requestEventName, params.requestEvent, {
          dropIfSlow: true,
        });
      }
    }

    const hasApprovalClients = suppressDelivery
      ? false
      : approvalClientConnIds !== null
        ? approvalClientConnIds.size > 0
        : (params.context.hasExecApprovalClients?.(params.clientConnId) ?? false);
    const deliveredResult = suppressDelivery ? false : params.deliverRequest();
    const delivered = isPromiseLike(deliveredResult) ? await deliveredResult : deliveredResult;
    // A turn-source route can approve without an active approval client, so keep
    // the record alive when the originating channel/account can still receive it.
    const hasTurnSourceRoute =
      !hasApprovalClients &&
      !delivered &&
      hasApprovalTurnSourceRoute({
        turnSourceChannel: params.record.request.turnSourceChannel,
        turnSourceAccountId: params.record.request.turnSourceAccountId,
        approvalKind: params.approvalKind ?? "exec",
      });
    const deliveryRoute: ApprovalRequestDeliveryRoute = delivered
      ? "forwarder"
      : hasApprovalClients
        ? "approval-client"
        : hasTurnSourceRoute
          ? "turn-source"
          : "none";

    const respondWithDecision = async (decision: ExecApprovalDecision | null): Promise<void> => {
      if (params.afterDecision) {
        try {
          await params.afterDecision(decision, params.requestEvent);
        } catch (err) {
          params.context.logGateway?.error?.(
            `${params.afterDecisionErrorLabel ?? "approval follow-up failed"}: ${String(err)}`,
          );
        }
      }
      params.respond(
        true,
        {
          id: params.record.id,
          decision,
          createdAtMs: params.record.createdAtMs,
          expiresAtMs: params.record.expiresAtMs,
        },
        undefined,
      );
    };

    if (
      params.requireDeliveryRoute !== false &&
      !params.keepPendingWithoutRoute &&
      !hasApprovalClients &&
      !hasTurnSourceRoute &&
      !delivered
    ) {
      let noRouteWon: boolean;
      try {
        noRouteWon = params.manager.expire(params.record.id, "no-approval-route");
      } catch (err) {
        respondApprovalStorageUnavailable({ ...params, operation: "request", error: err });
        return;
      }
      if (!noRouteWon) {
        // Delivery can yield while another surface resolves the same approval.
        // Preserve that first answer instead of reporting a synthetic no-route timeout.
        await respondWithDecision(await params.decisionPromise);
        return;
      }
      params.respond(
        true,
        {
          id: params.record.id,
          decision: null,
          createdAtMs: params.record.createdAtMs,
          expiresAtMs: params.record.expiresAtMs,
        },
        undefined,
      );
      return;
    }

    if (params.twoPhase) {
      params.respond(
        true,
        {
          status: "accepted",
          id: params.record.id,
          // Agent-side timeouts use this to distinguish delivered prompts from
          // requests kept pending only because manual /approve routing may work.
          deliveryRoute,
          createdAtMs: params.record.createdAtMs,
          expiresAtMs: params.record.expiresAtMs,
        },
        undefined,
      );
    }

    await respondWithDecision(await params.decisionPromise);
  } finally {
    releaseHandoff?.();
  }
}

/** Resolves a pending approval and broadcasts the final decision exactly once. */
export async function handleApprovalResolve<TPayload, TResolvedEvent extends object>(params: {
  manager: ExecApprovalManager<TPayload>;
  inputId: string;
  decision: ExecApprovalDecision;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  exposeAmbiguousPrefixError?: boolean;
  validateDecision?: (snapshot: ExecApprovalRecord<TPayload>) =>
    | {
        message: string;
        details?: Record<string, unknown>;
      }
    | null
    | undefined;
  resolveRecord?: (params: {
    approvalId: string;
    decision: ExecApprovalDecision;
    resolvedBy: string | null;
    snapshot: ExecApprovalRecord<TPayload>;
  }) => boolean;
  resolvedEventName: string;
  buildResolvedEvent: (params: {
    approvalId: string;
    decision: ExecApprovalDecision;
    resolvedBy: string | null;
    snapshot: ExecApprovalRecord<TPayload>;
    nowMs: number;
  }) => TResolvedEvent;
  forwardResolved?: (event: TResolvedEvent) => Promise<void> | void;
  forwardResolvedErrorLabel?: string;
  extraResolvedHandlers?: Array<{
    run: (event: TResolvedEvent) => Promise<void> | void;
    errorLabel: string;
  }>;
}): Promise<void> {
  let resolved: ApprovalRecordLookupResult<TPayload>;
  try {
    resolved = resolvePendingApprovalRecord({
      manager: params.manager,
      inputId: params.inputId,
      client: params.client,
      exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError,
    });
  } catch (err) {
    respondApprovalStorageUnavailable({ ...params, operation: "resolve", error: err });
    return;
  }
  if (!resolved.ok) {
    let resolvedRepeat: ApprovalRecordLookupResult<TPayload>;
    try {
      resolvedRepeat = resolveResolvedApprovalRecord({
        manager: params.manager,
        inputId: params.inputId,
        client: params.client,
        exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError,
      });
    } catch (err) {
      respondApprovalStorageUnavailable({ ...params, operation: "resolve", error: err });
      return;
    }
    if (resolvedRepeat.ok) {
      // Treat repeated identical resolves as successful retries; a conflicting
      // retry is rejected so stale operators cannot overwrite the first choice.
      if (resolveRecordedApprovalDecision(resolvedRepeat.snapshot) === params.decision) {
        params.respond(true, { ok: true }, undefined);
        return;
      }
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "approval already resolved", {
          details: APPROVAL_ALREADY_RESOLVED_DETAILS,
        }),
      );
      return;
    }
    respondPendingApprovalLookupError({ respond: params.respond, response: resolved.response });
    return;
  }

  const validationError = params.validateDecision?.(resolved.snapshot);
  if (validationError) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        validationError.message,
        validationError.details ? { details: validationError.details } : undefined,
      ),
    );
    return;
  }

  const resolvedBy =
    params.client?.connect?.client?.displayName ?? params.client?.connect?.client?.id ?? null;
  let ok: boolean;
  try {
    ok = params.resolveRecord
      ? params.resolveRecord({
          approvalId: resolved.approvalId,
          decision: params.decision,
          resolvedBy,
          snapshot: resolved.snapshot,
        })
      : params.manager.resolve(resolved.approvalId, params.decision, resolvedBy);
  } catch (err) {
    respondApprovalStorageUnavailable({ ...params, operation: "resolve", error: err });
    return;
  }
  if (!ok) {
    // A concurrent surface can win between the pending lookup and this
    // resolve; report the recorded conflict, not a missing approval.
    const raced = params.manager.getSnapshot(resolved.approvalId);
    if (raced && raced.resolvedAtMs !== undefined) {
      if (resolveRecordedApprovalDecision(raced) === params.decision) {
        params.respond(true, { ok: true }, undefined);
        return;
      }
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "approval already resolved", {
          details: APPROVAL_ALREADY_RESOLVED_DETAILS,
        }),
      );
      return;
    }
    respondUnknownOrExpiredApproval(params.respond);
    return;
  }

  const resolvedEvent = params.buildResolvedEvent({
    approvalId: resolved.approvalId,
    decision: params.decision,
    resolvedBy,
    snapshot: resolved.snapshot,
    nowMs: Date.now(),
  });
  const resolvedEventConnIds = resolveApprovalRequestRecipientConnIds({
    context: params.context,
    record: resolved.snapshot,
  });
  if (resolvedEventConnIds) {
    params.context.broadcastToConnIds(
      params.resolvedEventName,
      resolvedEvent,
      resolvedEventConnIds,
      {
        dropIfSlow: true,
      },
    );
  } else {
    params.context.broadcast(params.resolvedEventName, resolvedEvent, { dropIfSlow: true });
  }

  const followUps = [
    params.forwardResolved
      ? {
          run: params.forwardResolved,
          errorLabel: params.forwardResolvedErrorLabel ?? "approval resolve follow-up failed",
        }
      : null,
    ...(params.extraResolvedHandlers ?? []),
  ].filter(
    (
      entry,
    ): entry is { run: (event: TResolvedEvent) => Promise<void> | void; errorLabel: string } =>
      Boolean(entry),
  );

  // Resolution has already been recorded and broadcast; follow-up hooks are
  // best-effort so a plugin/channel forwarding failure cannot reopen it.
  for (const followUp of followUps) {
    try {
      await followUp.run(resolvedEvent);
    } catch (err) {
      params.context.logGateway?.error?.(`${followUp.errorLabel}: ${String(err)}`);
    }
  }

  params.respond(true, { ok: true }, undefined);
}
