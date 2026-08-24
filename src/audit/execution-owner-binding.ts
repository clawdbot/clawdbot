import type {
  AdmittedRunContext,
  PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { parseExecutionIdentityAdmissionToken } from "./execution-identity-admission.js";

export type ExecutionOwnerBindingResult =
  | "disabled"
  | "bound"
  | "already-bound"
  | "mismatch"
  | "missing";

export function isRetainedExecutionOwnerBinding(
  result: ExecutionOwnerBindingResult | undefined,
): result is "bound" | "already-bound" {
  return result === "bound" || result === "already-bound";
}

type ExecutionOwnerBinding = Readonly<{
  contextId: string;
  executionId: string;
}>;

/** Extracts only an admitted exact identity; operational run correlation cannot bind owner rows. */
export function executionOwnerBindingFromAdmission(
  admitted: AdmittedRunContext,
): ExecutionOwnerBinding | undefined {
  if (!admitted.executionIdentityToken) {
    return undefined;
  }
  const token = parseExecutionIdentityAdmissionToken(admitted.executionIdentityToken);
  if (token.runId !== admitted.operationalRunInstance.runId) {
    throw new Error("owner execution binding disagrees with the admitted run");
  }
  return { contextId: token.contextId, executionId: token.executionId };
}

export function classifyExecutionOwnerBinding(
  current: { contextId: string | null; executionId: string | null },
  binding: ExecutionOwnerBinding,
): Exclude<ExecutionOwnerBindingResult, "disabled" | "bound" | "missing"> | "unbound" {
  if (current.contextId === null && current.executionId === null) {
    return "unbound";
  }
  return current.contextId === binding.contextId && current.executionId === binding.executionId
    ? "already-bound"
    : "mismatch";
}

/** Adds one exact owner write after admission resolves, never inside the admission callback. */
export function withPostAdmissionExecutionOwnerBinding(
  prepared: PreparedAgentRunAdmission,
  bind: (context: AdmittedRunContext) => void,
): PreparedAgentRunAdmission {
  let bound = false;
  return Object.freeze({
    operationalRunInstance: prepared.operationalRunInstance,
    admit: async (runtimeKind, runtimeInstanceId) => {
      const admitted = await prepared.admit(runtimeKind, runtimeInstanceId);
      if (!bound) {
        bound = true;
        bind(admitted);
      }
      return admitted;
    },
    close: prepared.close,
  });
}

/** Requires both exact admission and actual execution start, in either runtime order. */
export function createExecutionStartedOwnerBinding(bind: (context: AdmittedRunContext) => void): {
  onPostAdmission: (context: AdmittedRunContext) => void;
  onExecutionStarted: () => void;
} {
  let admitted: AdmittedRunContext | undefined;
  let executionStarted = false;
  let bound = false;
  const bindIfReady = () => {
    if (bound || !admitted || !executionStarted) {
      return;
    }
    bound = true;
    bind(admitted);
  };
  return {
    onPostAdmission: (context) => {
      admitted = context;
      bindIfReady();
    },
    onExecutionStarted: () => {
      executionStarted = true;
      bindIfReady();
    },
  };
}
