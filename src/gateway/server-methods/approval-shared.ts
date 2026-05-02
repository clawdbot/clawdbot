import { hasApprovalTurnSourceRoute } from "../../infra/approval-turn-source.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type {
  ExecApprovalIdLookupResult,
  ExecApprovalManager,
  ExecApprovalRecord,
} from "../exec-approval-manager.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
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

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

export function isApprovalDecision(value: string): value is ExecApprovalDecision {
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

export function resolvePendingApprovalRecord<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  inputId: string;
  exposeAmbiguousPrefixError?: boolean;
}):
  | {
      ok: true;
      approvalId: string;
      snapshot: ExecApprovalRecord<TPayload>;
    }
  | {
      ok: false;
      response: PendingApprovalLookupError;
    } {
  const resolvedId = params.manager.lookupPendingId(params.inputId);
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
  if (!snapshot || snapshot.resolvedAtMs !== undefined) {
    return { ok: false, response: "missing" };
  }
  return { ok: true, approvalId: resolvedId.id, snapshot };
}

function resolveResolvedApprovalRecord<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  inputId: string;
  exposeAmbiguousPrefixError?: boolean;
}):
  | {
      ok: true;
      approvalId: string;
      snapshot: ExecApprovalRecord<TPayload>;
    }
  | {
      ok: false;
      response: PendingApprovalLookupError;
    } {
  const resolvedId = params.manager.lookupApprovalId(params.inputId, { includeResolved: true });
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
  if (!snapshot || snapshot.resolvedAtMs === undefined) {
    return { ok: false, response: "missing" };
  }
  return { ok: true, approvalId: resolvedId.id, snapshot };
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

export async function handleApprovalWaitDecision<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  inputId: unknown;
  respond: RespondFn;
}): Promise<void> {
  const id = normalizeOptionalString(params.inputId) ?? "";
  if (!id) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
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
  const snapshot = params.manager.getSnapshot(id);
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
  deliverRequest: () => boolean | Promise<boolean>;
  afterDecision?: (
    decision: ExecApprovalDecision | null,
    requestEvent: RequestedApprovalEvent<TPayload>,
  ) => Promise<void> | void;
  afterDecisionErrorLabel?: string;
}): Promise<void> {
  params.context.broadcast(params.requestEventName, params.requestEvent, { dropIfSlow: true });

  const hasApprovalClients = params.context.hasExecApprovalClients?.(params.clientConnId) ?? false;
  const deliveredResult = params.deliverRequest();
  const delivered = isPromiseLike(deliveredResult) ? await deliveredResult : deliveredResult;
  const hasTurnSourceRoute =
    !hasApprovalClients &&
    !delivered &&
    hasApprovalTurnSourceRoute({
      turnSourceChannel: params.record.request.turnSourceChannel,
      turnSourceAccountId: params.record.request.turnSourceAccountId,
    });

  if (!hasApprovalClients && !hasTurnSourceRoute && !delivered) {
    params.manager.expire(params.record.id, "no-approval-route");
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
        createdAtMs: params.record.createdAtMs,
        expiresAtMs: params.record.expiresAtMs,
      },
      undefined,
    );
  }

  const decision = await params.decisionPromise;
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
}

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
  const resolved = resolvePendingApprovalRecord({
    manager: params.manager,
    inputId: params.inputId,
    exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError,
  });
  if (!resolved.ok) {
    const resolvedRepeat = resolveResolvedApprovalRecord({
      manager: params.manager,
      inputId: params.inputId,
      exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError,
    });
    if (resolvedRepeat.ok) {
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
  const ok = params.manager.resolve(resolved.approvalId, params.decision, resolvedBy);
  if (!ok) {
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
  params.context.broadcast(params.resolvedEventName, resolvedEvent, { dropIfSlow: true });

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

  for (const followUp of followUps) {
    try {
      await followUp.run(resolvedEvent);
    } catch (err) {
      params.context.logGateway?.error?.(`${followUp.errorLabel}: ${String(err)}`);
    }
  }

  params.respond(true, { ok: true }, undefined);
}
