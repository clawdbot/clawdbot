import type { ExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";

const parentExecutionIdentities = new WeakMap<object, ExecutionIdentityAdmissionToken>();

/** Carry exact parent provenance without adding it to public spawn context types. */
export function withParentExecutionIdentity<T extends object>(
  context: T,
  token: ExecutionIdentityAdmissionToken | undefined,
): T {
  if (!token) {
    return context;
  }
  const carried = { ...context };
  parentExecutionIdentities.set(carried, token);
  return carried;
}

export function readParentExecutionIdentity(
  context: object,
): ExecutionIdentityAdmissionToken | undefined {
  return parentExecutionIdentities.get(context);
}
