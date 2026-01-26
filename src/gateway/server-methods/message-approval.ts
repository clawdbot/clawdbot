import type { MessageApprovalForwarder } from "../../infra/message-approval-forwarder.js";
import type {
  MessageApprovalDecision,
  MessageApprovalManager,
} from "../message-approval-manager.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateMessageApprovalRequestParams,
  validateMessageApprovalResolveParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export function createMessageApprovalHandlers(
  manager: MessageApprovalManager,
  opts?: { forwarder?: MessageApprovalForwarder },
): GatewayRequestHandlers {
  return {
    "message.approval.request": async ({ params, respond, context }) => {
      if (!validateMessageApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid message.approval.request params: ${formatValidationErrors(
              validateMessageApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as {
        id?: string;
        action: string;
        channel: string;
        to: string;
        message?: string | null;
        mediaUrl?: string | null;
        agentId?: string | null;
        sessionKey?: string | null;
        timeoutMs?: number;
      };
      const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 120_000;
      const explicitId = typeof p.id === "string" && p.id.trim().length > 0 ? p.id.trim() : null;
      if (explicitId && manager.getSnapshot(explicitId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval id already pending"),
        );
        return;
      }
      const request = {
        action: p.action,
        channel: p.channel,
        to: p.to,
        message: p.message ?? null,
        mediaUrl: p.mediaUrl ?? null,
        agentId: p.agentId ?? null,
        sessionKey: p.sessionKey ?? null,
      };
      const record = manager.create(request, timeoutMs, explicitId);
      const decisionPromise = manager.waitForDecision(record, timeoutMs);
      context.broadcast(
        "message.approval.requested",
        {
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        { dropIfSlow: true },
      );
      void opts?.forwarder
        ?.handleRequested({
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        })
        .catch((err) => {
          context.logGateway?.error?.(`message approvals: forward request failed: ${String(err)}`);
        });
      const decision = await decisionPromise;
      respond(
        true,
        {
          id: record.id,
          decision,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        undefined,
      );
    },
    "message.approval.resolve": async ({ params, respond, client, context }) => {
      if (!validateMessageApprovalResolveParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid message.approval.resolve params: ${formatValidationErrors(
              validateMessageApprovalResolveParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string; decision: string };
      const decision = p.decision as MessageApprovalDecision;
      if (decision !== "allow" && decision !== "deny") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
        return;
      }
      const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id;
      const ok = manager.resolve(p.id, decision, resolvedBy ?? null);
      if (!ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown approval id"));
        return;
      }
      context.broadcast(
        "message.approval.resolved",
        { id: p.id, decision, resolvedBy, ts: Date.now() },
        { dropIfSlow: true },
      );
      void opts?.forwarder
        ?.handleResolved({ id: p.id, decision, resolvedBy, ts: Date.now() })
        .catch((err) => {
          context.logGateway?.error?.(`message approvals: forward resolve failed: ${String(err)}`);
        });
      respond(true, { ok: true }, undefined);
    },
  };
}
