// Unified operator approval lookup and first-answer resolution handlers.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  isWellFormedApprovalId,
  type ApprovalDecision,
  type ApprovalResolveParams,
  type ApprovalSnapshot,
  validateApprovalGetParams,
  validateApprovalResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequestPayload,
  ExecApprovalResolved,
} from "../../infra/exec-approvals.js";
import type {
  PluginApprovalRequestPayload,
  PluginApprovalResolved,
} from "../../infra/plugin-approvals.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { normalizeControlUiBasePath } from "../control-ui-shared.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import {
  canAccessOperatorApproval,
  canResolveOperatorApproval,
  canReviewOperatorApproval,
} from "../operator-approval-authorization.js";
import {
  getOperatorApprovalDetailed,
  type OperatorApprovalRecord,
  type OperatorApprovalResolver,
} from "../operator-approval-store.js";
import { resolveApprovalRequestRecipientConnIds } from "./approval-shared.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";

type ApprovalRequest = ExecApprovalRequestPayload | PluginApprovalRequestPayload;

type ExecApprovalIosPushDelivery = {
  handleResolved?: (resolved: ExecApprovalResolved) => Promise<void>;
};

type CreateApprovalHandlersParams = {
  execApprovalManager: ExecApprovalManager;
  pluginApprovalManager: ExecApprovalManager<PluginApprovalRequestPayload>;
  forwarder?: ExecApprovalForwarder;
  iosPushDelivery?: ExecApprovalIosPushDelivery;
  databaseOptions?: OpenClawStateDatabaseOptions;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildApprovalSnapshot(
  record: OperatorApprovalRecord,
  controlUiBasePath: string,
): ApprovalSnapshot | null {
  const common = {
    id: record.id,
    status: record.status,
    presentation: record.presentation,
    urlPath: `${controlUiBasePath}/approve/${encodeURIComponent(record.id)}`,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  };
  if (record.status === "pending") {
    return common as ApprovalSnapshot;
  }
  if (record.resolvedAtMs === null || record.terminalReason === null) {
    return null;
  }
  const terminal = {
    ...common,
    resolvedAtMs: record.resolvedAtMs,
    reason: record.terminalReason,
  };
  if (record.status === "allowed") {
    if (record.decision !== "allow-once" && record.decision !== "allow-always") {
      return null;
    }
    return { ...terminal, decision: record.decision } as ApprovalSnapshot;
  }
  if (record.status === "denied") {
    return { ...terminal, decision: "deny" } as ApprovalSnapshot;
  }
  return terminal as ApprovalSnapshot;
}

function resolveApprovalResolver(client: GatewayClient | null): OperatorApprovalResolver {
  const deviceId = normalizeOptionalString(client?.connect?.device?.id);
  if (deviceId) {
    return { kind: "device", id: deviceId };
  }
  const clientId = normalizeOptionalString(client?.connect?.client?.id);
  return { kind: "runtime", id: clientId ?? null };
}

function resolveLegacyApprovalLabel(client: GatewayClient | null): string | null {
  return (
    normalizeOptionalString(client?.connect?.client?.displayName) ??
    normalizeOptionalString(client?.connect?.client?.id) ??
    null
  );
}

function respondApprovalNotFound(respond: RespondFn): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "approval not found", {
      details: { reason: ErrorCodes.APPROVAL_NOT_FOUND },
    }),
  );
}

function respondApprovalUnavailable(params: {
  context: GatewayRequestContext;
  respond: RespondFn;
  operation: "lookup" | "resolve";
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

function readExactApprovalId(params: unknown): string | null {
  if (!isRecord(params) || typeof params.id !== "string") {
    return null;
  }
  const id = params.id;
  return isWellFormedApprovalId(id) ? id : null;
}

function loadVisibleApproval(params: {
  id: string;
  client: GatewayClient | null;
  allowApprovalRuntime?: boolean;
  execApprovalManager: ExecApprovalManager;
  pluginApprovalManager: ExecApprovalManager<PluginApprovalRequestPayload>;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): OperatorApprovalRecord | null {
  // Reconciliation can settle a live waiter, so authorization must precede
  // every durable read and no unauthorized lookup may reach the bridge.
  const authorized = params.allowApprovalRuntime
    ? canResolveOperatorApproval(params.client)
    : canReviewOperatorApproval(params.client);
  if (!authorized) {
    return null;
  }
  const liveRecord =
    params.execApprovalManager.getLiveSnapshot(params.id) ??
    params.pluginApprovalManager.getLiveSnapshot(params.id);
  if (
    liveRecord &&
    !canAccessOperatorApproval({
      client: params.client,
      allowApprovalRuntime: params.allowApprovalRuntime,
      binding: {
        requestedByConnId: liveRecord.requestedByConnId,
        requestedByDeviceId: liveRecord.requestedByDeviceId,
        requestedByClientId: liveRecord.requestedByClientId,
        reviewerDeviceIds: liveRecord.approvalReviewerDeviceIds,
      },
    })
  ) {
    return null;
  }
  let lookup: ReturnType<typeof getOperatorApprovalDetailed>;
  try {
    lookup = getOperatorApprovalDetailed({
      id: params.id,
      databaseOptions: params.databaseOptions,
    });
  } catch (error) {
    const corrupt = { outcome: "corrupt", id: params.id } as const;
    params.execApprovalManager.reconcileDurableLookup(corrupt);
    params.pluginApprovalManager.reconcileDurableLookup(corrupt);
    throw error;
  }
  if (lookup.outcome === "found") {
    if (
      !canAccessOperatorApproval({
        client: params.client,
        allowApprovalRuntime: params.allowApprovalRuntime,
        binding: {
          requestedByDeviceId: lookup.record.requester.deviceId,
          requestedByClientId: lookup.record.requester.clientId,
          reviewerDeviceIds: lookup.record.reviewerDeviceIds,
        },
      })
    ) {
      return null;
    }
    const manager =
      lookup.record.kind === "exec" ? params.execApprovalManager : params.pluginApprovalManager;
    // Durable truth can advance outside this manager. Settle only an existing
    // same-kind waiter; reconcileDurableLookup never recreates executable state.
    return manager.reconcileDurableLookup(lookup);
  }
  const missing = {
    outcome: lookup.outcome === "corrupt" ? "corrupt" : "missing",
    id: params.id,
  } as const;
  params.execApprovalManager.reconcileDurableLookup(missing);
  params.pluginApprovalManager.reconcileDurableLookup(missing);
  return null;
}

function broadcastResolvedEvent(params: {
  context: GatewayRequestContext;
  eventName: "exec.approval.resolved" | "plugin.approval.resolved";
  event: ExecApprovalResolved | PluginApprovalResolved;
  liveRecord: ExecApprovalRecord<ApprovalRequest>;
}): void {
  // Legacy resolution events contain the full runtime request. Keep their existing
  // visibility filter; broad multi-surface fanout requires the sanitized PR3 event.
  const recipientConnIds = resolveApprovalRequestRecipientConnIds({
    context: params.context,
    record: {
      id: params.liveRecord.id,
      request: params.liveRecord.request,
      createdAtMs: params.liveRecord.createdAtMs,
      expiresAtMs: params.liveRecord.expiresAtMs,
      requestedByConnId: params.liveRecord.requestedByConnId,
      requestedByDeviceId: params.liveRecord.requestedByDeviceId,
      requestedByClientId: params.liveRecord.requestedByClientId,
      requestedByDeviceTokenAuth: params.liveRecord.requestedByDeviceTokenAuth,
      approvalReviewerDeviceIds: params.liveRecord.approvalReviewerDeviceIds,
    },
  });
  if (recipientConnIds) {
    params.context.broadcastToConnIds(params.eventName, params.event, recipientConnIds, {
      dropIfSlow: true,
    });
    return;
  }
  params.context.broadcast(params.eventName, params.event, { dropIfSlow: true });
}

async function publishAppliedResolution(params: {
  record: OperatorApprovalRecord;
  liveRecord: ExecApprovalRecord<ApprovalRequest>;
  context: GatewayRequestContext;
  forwarder?: ExecApprovalForwarder;
  iosPushDelivery?: ExecApprovalIosPushDelivery;
}): Promise<void> {
  const decision = params.record.decision ?? "deny";
  const resolvedBy = params.liveRecord.resolvedBy ?? null;
  const ts = params.record.resolvedAtMs ?? Date.now();
  if (params.record.kind === "exec") {
    const event: ExecApprovalResolved = {
      id: params.record.id,
      decision,
      resolvedBy,
      ts,
      request: params.liveRecord.request as ExecApprovalRequestPayload,
    };
    broadcastResolvedEvent({
      context: params.context,
      eventName: "exec.approval.resolved",
      event,
      liveRecord: params.liveRecord,
    });
    const followUps = [
      params.forwarder ? () => params.forwarder!.handleResolved(event) : null,
      params.iosPushDelivery?.handleResolved
        ? () => params.iosPushDelivery!.handleResolved!(event)
        : null,
    ].filter((entry): entry is () => Promise<void> => Boolean(entry));
    for (const followUp of followUps) {
      try {
        await followUp();
      } catch (error) {
        params.context.logGateway?.error?.(
          `exec approvals: unified resolve follow-up failed: ${String(error)}`,
        );
      }
    }
    return;
  }

  const event: PluginApprovalResolved = {
    id: params.record.id,
    decision,
    resolvedBy,
    ts,
    request: params.liveRecord.request as PluginApprovalRequestPayload,
  };
  broadcastResolvedEvent({
    context: params.context,
    eventName: "plugin.approval.resolved",
    event,
    liveRecord: params.liveRecord,
  });
  try {
    await params.forwarder?.handlePluginApprovalResolved?.(event);
  } catch (error) {
    params.context.logGateway?.error?.(
      `plugin approvals: unified resolve follow-up failed: ${String(error)}`,
    );
  }
}

type ApplyApprovalDecisionResult<TPayload> =
  | {
      ok: true;
      applied: boolean;
      record: OperatorApprovalRecord;
      liveRecord?: ExecApprovalRecord<TPayload>;
    }
  | { ok: false };

function resolveLiveRecord<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  id: string;
  liveRecord?: ExecApprovalRecord<TPayload>;
}): ExecApprovalRecord<TPayload> | undefined {
  return params.liveRecord ?? params.manager.getLiveSnapshot(params.id) ?? undefined;
}

function applyForcedDeny<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  id: string;
  resolver: OperatorApprovalResolver;
  localResolvedBy: string | null;
}): ApplyApprovalDecisionResult<TPayload> {
  const result = params.manager.forceDenyDetailed(
    params.id,
    "malformed-verdict",
    params.resolver,
    "denied",
    undefined,
    false,
    params.localResolvedBy,
  );
  switch (result.outcome) {
    case "denied":
      return {
        ok: true,
        applied: true,
        record: result.record,
        liveRecord: resolveLiveRecord({
          manager: params.manager,
          id: params.id,
          liveRecord: result.liveRecord,
        }),
      };
    case "expired":
    case "already-terminal":
    case "not-due":
      return {
        ok: true,
        applied: false,
        record: result.record,
        liveRecord: result.liveRecord,
      };
    case "not-found":
    case "corrupt":
      return { ok: false };
  }
  return result satisfies never;
}

function applyApprovalDecision<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  id: string;
  decision: ApprovalDecision | null;
  forceMalformedDeny: boolean;
  resolver: OperatorApprovalResolver;
  localResolvedBy: string | null;
}): ApplyApprovalDecisionResult<TPayload> {
  if (params.forceMalformedDeny) {
    return applyForcedDeny(params);
  }

  const result = params.manager.resolveDetailed(
    params.id,
    params.decision as ExecApprovalDecision,
    params.resolver,
    params.localResolvedBy,
  );
  switch (result.outcome) {
    case "resolved":
      return {
        ok: true,
        applied: true,
        record: result.record,
        liveRecord: resolveLiveRecord({
          manager: params.manager,
          id: params.id,
          liveRecord: result.liveRecord,
        }),
      };
    case "expired":
    case "already-resolved":
      return {
        ok: true,
        applied: false,
        record: result.record,
        liveRecord: result.liveRecord,
      };
    case "decision-not-allowed":
      return applyForcedDeny(params);
    case "not-found":
    case "corrupt":
      return { ok: false };
  }
  return result satisfies never;
}

/** Creates kind-agnostic approval lookup and resolution handlers. */
export function createApprovalHandlers(
  params: CreateApprovalHandlersParams,
): GatewayRequestHandlers {
  return {
    "approval.get": ({ params: rawParams, respond, client, context }) => {
      if (!validateApprovalGetParams(rawParams)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid approval.get params"),
        );
        return;
      }
      const id = readExactApprovalId(rawParams);
      let record: OperatorApprovalRecord | null;
      try {
        record = id
          ? loadVisibleApproval({
              id,
              client,
              execApprovalManager: params.execApprovalManager,
              pluginApprovalManager: params.pluginApprovalManager,
              databaseOptions: params.databaseOptions,
            })
          : null;
      } catch (error) {
        respondApprovalUnavailable({ context, respond, operation: "lookup", error });
        return;
      }
      const controlUiBasePath = normalizeControlUiBasePath(
        context.getRuntimeConfig()?.gateway?.controlUi?.basePath,
      );
      const approval = record ? buildApprovalSnapshot(record, controlUiBasePath) : null;
      if (!approval) {
        respondApprovalNotFound(respond);
        return;
      }
      respond(true, { approval }, undefined);
    },

    "approval.resolve": async ({ params: rawParams, respond, client, context }) => {
      const id = readExactApprovalId(rawParams);
      let record: OperatorApprovalRecord | null;
      try {
        record = id
          ? loadVisibleApproval({
              id,
              client,
              allowApprovalRuntime: true,
              execApprovalManager: params.execApprovalManager,
              pluginApprovalManager: params.pluginApprovalManager,
              databaseOptions: params.databaseOptions,
            })
          : null;
      } catch (error) {
        respondApprovalUnavailable({ context, respond, operation: "lookup", error });
        return;
      }
      if (!id || !record) {
        respondApprovalNotFound(respond);
        return;
      }
      if (record.status !== "pending") {
        // Durable terminal state outlives the process-local waiter. Every later
        // surface receives the same winner without re-opening execution rights.
        const controlUiBasePath = normalizeControlUiBasePath(
          context.getRuntimeConfig()?.gateway?.controlUi?.basePath,
        );
        const approval = buildApprovalSnapshot(record, controlUiBasePath);
        if (!approval || approval.status === "pending") {
          respondApprovalNotFound(respond);
          return;
        }
        respond(true, { applied: false, approval }, undefined);
        return;
      }
      const resolver = resolveApprovalResolver(client);
      const localResolvedBy = resolveLegacyApprovalLabel(client);
      const validParams = validateApprovalResolveParams(rawParams);
      const resolveParams = validParams ? (rawParams as ApprovalResolveParams) : null;
      const requestedDecision = resolveParams?.decision ?? null;
      const decisionAllowed =
        requestedDecision === "deny" ||
        (requestedDecision !== null &&
          record.presentation.allowedDecisions.includes(requestedDecision));
      const kindMatches = resolveParams?.kind === record.presentation.kind;
      // Ambiguous verdicts consume the first-answer slot as a denial. Leaving
      // the approval retryable would let a later surface release authority.
      const forceMalformedDeny = !validParams || !kindMatches || !decisionAllowed;
      let resolution:
        | ApplyApprovalDecisionResult<ExecApprovalRequestPayload>
        | ApplyApprovalDecisionResult<PluginApprovalRequestPayload>;
      try {
        resolution =
          record.kind === "exec"
            ? applyApprovalDecision({
                manager: params.execApprovalManager,
                id: record.id,
                decision: requestedDecision,
                forceMalformedDeny,
                resolver,
                localResolvedBy,
              })
            : applyApprovalDecision({
                manager: params.pluginApprovalManager,
                id: record.id,
                decision: requestedDecision,
                forceMalformedDeny,
                resolver,
                localResolvedBy,
              });
      } catch (error) {
        respondApprovalUnavailable({ context, respond, operation: "resolve", error });
        return;
      }
      if (!resolution.ok) {
        respondApprovalNotFound(respond);
        return;
      }
      const terminalRecord = resolution.record;
      if (terminalRecord.status === "pending") {
        respondApprovalNotFound(respond);
        return;
      }
      const controlUiBasePath = normalizeControlUiBasePath(
        context.getRuntimeConfig()?.gateway?.controlUi?.basePath,
      );
      const approval = buildApprovalSnapshot(terminalRecord, controlUiBasePath);
      if (!approval) {
        respondApprovalNotFound(respond);
        return;
      }
      if (resolution.applied && resolution.liveRecord) {
        await publishAppliedResolution({
          record: terminalRecord,
          liveRecord: resolution.liveRecord,
          context,
          forwarder: params.forwarder,
          iosPushDelivery: params.iosPushDelivery,
        });
      }
      respond(true, { applied: resolution.applied, approval }, undefined);
    },
  };
}
