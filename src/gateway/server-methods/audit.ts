// Metadata-only operator audit queries over the canonical shared SQLite ledger.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type AuditActivityEventV1,
  type AuditEvent,
  validateAuditActivityListParams,
  validateAuditListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAuditEvents } from "../../audit/audit-event-store.js";
import type {
  AgentRunAuditEventRecord,
  AuditEventRecord,
  ToolActionAuditEventRecord,
} from "../../audit/audit-event-types.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_AUDIT_LIST_LIMIT = 100;
const MAX_AUDIT_LIST_LIMIT = 500;

function parseAuditCursor(cursor: string | undefined): number | undefined | null {
  if (cursor === undefined) {
    return undefined;
  }
  const trimmed = cursor.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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
  const { actorType, actorId, ...activity } = event;
  return { ...activity, eventType: "outbound_message", actor: { type: actorType, id: actorId } };
}

function invalidRangeOrCursor(params: { cursor?: string; after?: number; before?: number }): {
  cursor?: number;
  invalid: boolean;
} {
  const cursor = parseAuditCursor(params.cursor);
  return {
    ...(cursor !== undefined && cursor !== null ? { cursor } : {}),
    invalid:
      cursor === null ||
      (params.after !== undefined && params.before !== undefined && params.after > params.before),
  };
}

export const auditHandlers: GatewayRequestHandlers = {
  "audit.list": ({ params, respond }) => {
    if (!validateAuditListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid audit.list params: ${formatValidationErrors(validateAuditListParams.errors)}`,
        ),
      );
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
    const page = listAuditEvents({
      limit: Math.min(params.limit ?? DEFAULT_AUDIT_LIST_LIMIT, MAX_AUDIT_LIST_LIMIT),
      ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
      filters: {
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.runId ? { runId: params.runId } : {}),
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
    if (!validateAuditActivityListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid audit.activity.list params: ${formatValidationErrors(
            validateAuditActivityListParams.errors,
          )}`,
        ),
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
    const page = listAuditEvents({
      limit: Math.min(params.limit ?? DEFAULT_AUDIT_LIST_LIMIT, MAX_AUDIT_LIST_LIMIT),
      ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
      filters: {
        includeMessages: true,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.runId ? { runId: params.runId } : {}),
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
};

export const testApi = { mapAuditActivityEvent, mapLegacyAuditEvent, parseAuditCursor };
