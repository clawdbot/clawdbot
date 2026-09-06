// Metadata-only operator audit queries over the canonical shared SQLite ledger.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type AuditActivityEventV1,
  type AuditEvent,
  type AuditRunInspectResult,
  validateAuditActivityListParams,
  validateAuditListParams,
  validateAuditRunInspectParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { findAuditActivityFilterConflict } from "../../../packages/gateway-protocol/src/schema/audit-activity.js";
import { parsePositiveAuditCursor } from "../../audit/audit-cursor.js";
import { listAuditEvents } from "../../audit/audit-event-store.js";
import type {
  AgentRunAuditEventRecord,
  AuditEventRecord,
  ToolActionAuditEventRecord,
} from "../../audit/audit-event-types.js";
import {
  ExecutionDecisionCursorError,
  isExecutionDecisionCursor,
  type InternalAuditRunInspectResult,
} from "../../audit/execution-decision-receipts.js";
import { inspectExecutionIdentityRun } from "../../audit/execution-identity-context.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_AUDIT_LIST_LIMIT = 100;
const MAX_AUDIT_LIST_LIMIT = 500;

function serializeAuditRunInspectResult(
  inspected: InternalAuditRunInspectResult,
): AuditRunInspectResult {
  const result: AuditRunInspectResult = {
    schemaVersion: inspected.schemaVersion,
    run: inspected.run,
    identity: inspected.identity,
    decisionDisplays: inspected.decisionDisplays,
    coverage: inspected.coverage,
  };
  if (inspected.nextDecisionCursor !== undefined) {
    result.nextDecisionCursor = inspected.nextDecisionCursor;
  }
  if (inspected.nextExecutionCursor !== undefined) {
    result.nextExecutionCursor = inspected.nextExecutionCursor;
  }
  return result;
}

function isOwnerDecisionCursor(value: string): boolean {
  return parsePositiveAuditCursor(value) === null && isExecutionDecisionCursor(value);
}

/** Preserve the shipped audit.list result shape for run/tool-only clients. */
function mapLegacyAuditEvent(
  event: AgentRunAuditEventRecord | ToolActionAuditEventRecord,
): AuditEvent {
  const { schemaVersion: _schemaVersion, actorType, actorId, ...legacyEvent } = event;
  return {
    ...legacyEvent,
    actor: { type: actorType, id: actorId },
  };
}

function mapAuditActivityEvent(event: AuditEventRecord): AuditActivityEventV1 {
  if (event.kind === "agent_run") {
    const { actorType, actorId, ...activity } = event;
    return { ...activity, eventType: "agent_run", actor: { type: actorType, id: actorId } };
  }
  if (event.kind === "tool_action") {
    const { actorType, actorId, ...activity } = event;
    return { ...activity, eventType: "tool_action", actor: { type: actorType, id: actorId } };
  }
  if (event.direction === "inbound") {
    const { actorType, actorId, ...activity } = event;
    const actor =
      actorType === "channel_sender"
        ? { type: "channel_sender" as const, id: actorId }
        : { type: "system" as const, id: actorId };
    return { ...activity, eventType: "inbound_message", actor };
  }
  if (event.action !== "message.outbound.finished") {
    throw new Error("nonterminal outbound messages are not audit activity records");
  }
  const { actorType, actorId, ...activity } = event;
  return { ...activity, eventType: "outbound_message", actor: { type: actorType, id: actorId } };
}

function invalidRangeOrCursor(params: { cursor?: string; after?: number; before?: number }): {
  cursor?: number;
  invalid: boolean;
} {
  const cursor = parsePositiveAuditCursor(params.cursor);
  return {
    ...(cursor !== undefined && cursor !== null ? { cursor } : {}),
    invalid:
      cursor === null ||
      (params.after !== undefined && params.before !== undefined && params.after > params.before),
  };
}

export const auditHandlers: GatewayRequestHandlers = {
  "audit.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateAuditListParams, "audit.list", respond)) {
      return;
    }
    const parsed = invalidRangeOrCursor(params);
    if (parsed.invalid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid audit.list range or cursor"),
      );
      return;
    }
    const agentId = normalizeOptionalString(params.agentId);
    const sessionKey = normalizeOptionalString(params.sessionKey);
    const runId = normalizeOptionalString(params.runId);
    const page = listAuditEvents({
      limit: Math.min(params.limit ?? DEFAULT_AUDIT_LIST_LIMIT, MAX_AUDIT_LIST_LIMIT),
      ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
      filters: {
        ...(agentId ? { agentId } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(runId ? { runId } : {}),
        ...(params.kind ? { kind: params.kind } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.after !== undefined ? { after: params.after } : {}),
        ...(params.before !== undefined ? { before: params.before } : {}),
      },
    });
    respond(true, {
      events: page.events.map((event) => {
        if (event.kind === "message") {
          throw new Error("legacy audit.list cannot project message records");
        }
        return mapLegacyAuditEvent(event);
      }),
      ...(page.nextCursor !== undefined ? { nextCursor: String(page.nextCursor) } : {}),
    });
  },
  "audit.activity.list": ({ params, respond }) => {
    if (
      !assertValidParams(params, validateAuditActivityListParams, "audit.activity.list", respond)
    ) {
      return;
    }
    const filterConflict = findAuditActivityFilterConflict(params);
    if (filterConflict) {
      const detail =
        filterConflict.type === "kind"
          ? `${filterConflict.field} only applies to kind ${filterConflict.supportedKinds.join(" or ")}`
          : `${filterConflict.field} cannot be combined with ${filterConflict.conflictingField}`;
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `invalid audit.activity.list filters: ${detail}`),
      );
      return;
    }
    const parsed = invalidRangeOrCursor(params);
    if (parsed.invalid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid audit.activity.list range or cursor"),
      );
      return;
    }
    const agentId = normalizeOptionalString(params.agentId);
    const sessionKey = normalizeOptionalString(params.sessionKey);
    const runId = normalizeOptionalString(params.runId);
    const page = listAuditEvents({
      limit: Math.min(params.limit ?? DEFAULT_AUDIT_LIST_LIMIT, MAX_AUDIT_LIST_LIMIT),
      ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
      filters: {
        includeMessages: true,
        ...(agentId ? { agentId } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(runId ? { runId } : {}),
        ...(params.kind ? { kind: params.kind } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.direction ? { direction: params.direction } : {}),
        ...(params.channel ? { channel: params.channel } : {}),
        ...(params.after !== undefined ? { after: params.after } : {}),
        ...(params.before !== undefined ? { before: params.before } : {}),
      },
    });
    respond(true, {
      events: page.events.map(mapAuditActivityEvent),
      ...(page.nextCursor !== undefined ? { nextCursor: String(page.nextCursor) } : {}),
    });
  },
  "audit.run.inspect": ({ params, respond }) => {
    if (!assertValidParams(params, validateAuditRunInspectParams, "audit.run.inspect", respond)) {
      return;
    }
    const decisionCursor = params.decisionCursor;
    const executionOffset =
      typeof params.runId !== "string" ||
      (params.executionCursor === decisionCursor &&
        decisionCursor !== undefined &&
        isOwnerDecisionCursor(decisionCursor))
        ? undefined
        : parsePositiveAuditCursor(params.executionCursor);
    if (
      (decisionCursor !== undefined && !isExecutionDecisionCursor(decisionCursor)) ||
      executionOffset === null
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid audit.run.inspect cursor"),
      );
      return;
    }
    try {
      respond(
        true,
        serializeAuditRunInspectResult(
          inspectExecutionIdentityRun({
            ...(typeof params.runId === "string"
              ? {
                  runId: params.runId,
                  ...(executionOffset !== undefined ? { executionOffset } : {}),
                  executionLimit: params.executionLimit ?? 50,
                }
              : { executionId: params.executionId! }),
            ...(decisionCursor !== undefined ? { decisionCursor } : {}),
            decisionLimit: params.decisionLimit ?? 50,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof ExecutionDecisionCursorError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      throw error;
    }
  },
};
