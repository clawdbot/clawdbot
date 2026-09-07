import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AdmittedRunContext, PreparedAgentRunAdmission } from "./admitted-run-context.js";
import { createOperationalRunInstanceRef } from "./admitted-run-context.js";

const diagnosticFixtureContexts = new WeakSet<AdmittedRunContext>();

/** Explicit no-audit carrier for fixtures that enter below the admission owner. */
export function createTestAdmittedRunContext(runId: string): AdmittedRunContext {
  const context = Object.freeze({ operationalRunInstance: createOperationalRunInstanceRef(runId) });
  diagnosticFixtureContexts.add(context);
  return context;
}

/** Owns real admission for diagnostic fixtures, never renewing supplied or revoked authority. */
export async function withTestRunAdmission<T>(
  params: {
    admittedRunContext: AdmittedRunContext;
    runId: string;
    agentId?: string;
    config?: OpenClawConfig;
  },
  run: (context: AdmittedRunContext) => Promise<T>,
): Promise<T> {
  if (!diagnosticFixtureContexts.has(params.admittedRunContext)) {
    return await run(params.admittedRunContext);
  }
  const { prepareSystemAgentRunAdmission } = await import("./admitted-run-context.js");
  const admission = prepareSystemAgentRunAdmission(
    params.config ?? {},
    params.runId,
    params.agentId ?? "test",
    "prepared-run-fixture",
  );
  try {
    return await run(await admission.admit("embedded"));
  } finally {
    admission.close();
  }
}

/** Explicit prepared-owner seam for tests that exercise post-selection admission. */
export function createTestPreparedRunAdmission(runId: string): PreparedAgentRunAdmission {
  const admitted = createTestAdmittedRunContext(runId);
  return Object.freeze({
    operationalRunInstance: admitted.operationalRunInstance,
    admit: async () => admitted,
    assertSourceCurrent: () => {},
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

/** Exercises the real post-selection admission boundary without enabling audit collection. */
export function wrapRunWithTestPreparedAdmission<P extends { runId: string; agentId?: string }, R>(
  run: (params: P) => Promise<R>,
): (params: Omit<P, "admittedRunContext" | "preparedRunAdmission">) => Promise<R> {
  return async (params) => {
    // Fixtures reset modules before loading runners; authority must use that same
    // module instance and remain owned until the complete runner call settles.
    const { prepareSystemAgentRunAdmission } = await import("./admitted-run-context.js");
    const admission = prepareSystemAgentRunAdmission(
      {},
      params.runId,
      params.agentId ?? "test",
      "runner-fixture",
    );
    try {
      return await run({ ...params, preparedRunAdmission: admission } as unknown as P);
    } finally {
      admission.close();
    }
  };
}
