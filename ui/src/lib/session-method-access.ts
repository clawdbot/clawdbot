import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import {
  resolveBaseSessionMutationRequiredScope,
  type SessionMutationOperatorScope,
} from "../../../src/shared/session-method-scopes-base.js";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { isGatewayMethodAdvertised } from "./gateway-methods.ts";

type SessionMethodOperatorScope = "operator.read" | SessionMutationOperatorScope;

export type SessionMethodAccess =
  | { allowed: true; requiredScope: SessionMethodOperatorScope }
  | {
      allowed: false;
      requiredScope: SessionMethodOperatorScope;
      reason: string;
      cause: "disconnected" | "method-unavailable" | "missing-scope";
    };

type SessionMethodAccessRequest = {
  method: string;
  params?: unknown;
  requiredScope?: SessionMethodOperatorScope;
};

function sessionMethodAccessReason(
  cause: Exclude<SessionMethodAccess, { allowed: true }>["cause"],
  requiredScope: SessionMethodOperatorScope,
): string {
  if (cause === "disconnected") {
    return t("sessionsView.actionRequiresConnection");
  }
  if (cause === "method-unavailable") {
    return t("sessionsView.actionUnavailable");
  }
  return t(
    requiredScope === "operator.admin"
      ? "sessionsView.actionRequiresAdmin"
      : requiredScope === "operator.write"
        ? "sessionsView.actionRequiresWrite"
        : "sessionsView.actionRequiresRead",
  );
}

/**
 * Resolves browser-safe shared mutation policy or a caller-supplied placement
 * scope, plus connection and advertised-method state.
 */
export function readSessionMethodAccess(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> | null | undefined,
  request: SessionMethodAccessRequest,
): SessionMethodAccess {
  const requiredScope =
    resolveBaseSessionMutationRequiredScope(request.method, request.params) ??
    request.requiredScope;
  if (!requiredScope) {
    throw new Error(`Missing required scope for session mutation method: ${request.method}`);
  }
  if (snapshot?.phase !== "connected" || !snapshot.client) {
    return {
      allowed: false,
      requiredScope,
      reason: sessionMethodAccessReason("disconnected", requiredScope),
      cause: "disconnected",
    };
  }
  if (isGatewayMethodAdvertised(snapshot, request.method) !== true) {
    return {
      allowed: false,
      requiredScope,
      reason: sessionMethodAccessReason("method-unavailable", requiredScope),
      cause: "method-unavailable",
    };
  }
  const auth = snapshot.hello?.auth;
  if (
    auth &&
    Array.isArray(auth.scopes) &&
    roleScopesAllow({
      role: auth.role,
      requestedScopes: [requiredScope],
      allowedScopes: auth.scopes,
    })
  ) {
    return { allowed: true, requiredScope };
  }
  return {
    allowed: false,
    requiredScope,
    reason: sessionMethodAccessReason("missing-scope", requiredScope),
    cause: "missing-scope",
  };
}
