import {
  validateSessionsDispatchParams,
  validateSessionsMoveParams,
} from "../../packages/gateway-protocol/src/session-placement-validators.js";
import {
  resolveBaseSessionMutationRequiredScope,
  type SessionMutationOperatorScope,
} from "./session-method-scopes-base.js";

/** Returns the exact Gateway/CLI scope for params-aware session mutations. */
export function resolveDynamicSessionMutationRequiredScope(
  method: string,
  params?: unknown,
): SessionMutationOperatorScope | undefined {
  if (method === "sessions.dispatch") {
    if (!validateSessionsDispatchParams(params)) {
      return "operator.write";
    }
    return params.profileId === undefined ? "operator.write" : "operator.admin";
  }
  if (method === "sessions.move") {
    return validateSessionsMoveParams(params) && params.target.kind === "profile"
      ? "operator.admin"
      : "operator.write";
  }
  return resolveBaseSessionMutationRequiredScope(method, params);
}
