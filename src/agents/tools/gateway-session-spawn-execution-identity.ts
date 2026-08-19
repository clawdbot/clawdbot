import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";

const parentExecutionIdentityToken = new AsyncLocalStorage<ExecutionIdentityAdmissionToken>();

/** Scope exact parent evidence to the same local Gateway call as spawn authority. */
export function runWithGatewaySessionSpawnParentExecutionIdentity<T>(
  token: ExecutionIdentityAdmissionToken | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return token ? parentExecutionIdentityToken.run(token, run) : run();
}

export function getGatewaySessionSpawnParentExecutionIdentityToken():
  | ExecutionIdentityAdmissionToken
  | undefined {
  return parentExecutionIdentityToken.getStore();
}
