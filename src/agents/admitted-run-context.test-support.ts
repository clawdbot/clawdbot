import type { AdmittedRunContext, PreparedAgentRunAdmission } from "./admitted-run-context.js";
import { createOperationalRunInstanceRef } from "./admitted-run-context.js";

/** Explicit no-audit carrier for fixtures that enter below the admission owner. */
export function createTestAdmittedRunContext(runId: string): AdmittedRunContext {
  return Object.freeze({ operationalRunInstance: createOperationalRunInstanceRef(runId) });
}

/** Explicit prepared-owner seam for tests that exercise post-selection admission. */
export function createTestPreparedRunAdmission(runId: string): PreparedAgentRunAdmission {
  const admitted = createTestAdmittedRunContext(runId);
  return Object.freeze({
    operationalRunInstance: admitted.operationalRunInstance,
    admit: async () => admitted,
    close: () => {},
  });
}

export function withTestAdmittedRunContext<T extends { runId: string }>(
  params: T,
): T & { admittedRunContext: AdmittedRunContext } {
  return {
    ...params,
    admittedRunContext: createTestAdmittedRunContext(params.runId),
  };
}

/** Adapts a production runner only at a test boundary; production stays fail-closed. */
export function wrapRunWithTestAdmission<P extends { runId: string }, R>(
  run: (params: P) => R,
): (params: Omit<P, "admittedRunContext" | "preparedRunAdmission">) => R {
  return (params) =>
    run({
      ...params,
      admittedRunContext: createTestAdmittedRunContext(params.runId),
    } as unknown as P);
}

/** Exercises the real post-selection admission boundary without enabling audit collection. */
export function wrapRunWithTestPreparedAdmission<P extends { runId: string }, R>(
  run: (params: P) => R,
): (params: Omit<P, "admittedRunContext" | "preparedRunAdmission">) => R {
  return (params) =>
    run({
      ...params,
      preparedRunAdmission: createTestPreparedRunAdmission(params.runId),
    } as unknown as P);
}
