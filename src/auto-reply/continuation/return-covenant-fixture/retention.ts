import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { retainedReturnCovenantResources } from "./case-lifecycle.js";
import {
  returnCovenantExecutionKey,
  type ReturnCovenantFixtureContext,
  type ReturnCovenantRunCleanupReceipt,
} from "./case-state.js";
import type { ReturnCovenantGatewayBinding } from "./gateway-generation.js";
import {
  ReturnCovenantProtocolError,
  type ReturnCovenantForm,
  type ReturnCovenantPlan,
} from "./protocol.js";
import type { CompletedReturnCovenantCase } from "./run-snapshot.js";

export const RETURN_COVENANT_RETENTION_PATH = "/v1/return-covenant/resource-inspection";
const RETURN_COVENANT_RETENTION_RESPONSE_SCHEMA =
  "openclaw.k6.return-covenant-retention-response.v1";
const SHA256 = /^[0-9a-f]{64}$/u;
const retentionResources = [
  { category: "delegates", method: "continuation.delegates.list" },
  { category: "queueItems", method: "continuation.queue.list" },
  { category: "temporarySessions", method: "sessions.list" },
] as const;

type ReturnCovenantRetentionCaseForm = {
  caseId: string;
  form: ReturnCovenantForm;
  caseHandle: string;
};

type ReturnCovenantRetentionCleanupBinding = Pick<
  ReturnCovenantRunCleanupReceipt,
  "driverAttestationSha256" | "observationSetSha256" | "phaseChainSha256" | "receiptId"
>;

export function buildReturnCovenantRetentionRequest(params: {
  caseForms: ReturnCovenantRetentionCaseForm[];
  cleanupRun: ReturnCovenantRetentionCleanupBinding;
  plan: ReturnCovenantPlan;
  requestNonce: string;
}) {
  return {
    schema: "openclaw.k6.return-covenant-retention-request.v1",
    rowId: params.plan.rowId,
    runId: params.plan.runId,
    candidateSha: params.plan.target.candidateSha,
    productTreeSha: params.plan.target.productTreeSha,
    runtimeBuildSha: params.plan.target.runtimeBuildSha,
    docsHarnessSha: params.plan.target.docsHarnessSha,
    runtimeConfigSha256: params.plan.target.runtimeConfigSha256,
    runtimeArtifactManifestSha256: params.plan.target.runtimeArtifactManifestSha256,
    driverAttestationSha256: params.cleanupRun.driverAttestationSha256,
    observationSetSha256: params.cleanupRun.observationSetSha256,
    phaseChainSha256: params.cleanupRun.phaseChainSha256,
    cleanupRunReceiptId: params.cleanupRun.receiptId,
    requestNonce: params.requestNonce,
    caseForms: params.caseForms,
    resources: retentionResources.map((resource) => ({ ...resource, limit: 101 })),
  };
}

function validateRetentionRequest(params: {
  caseForms: ReturnCovenantRetentionCaseForm[];
  cleanupRun: ReturnCovenantRetentionCleanupBinding;
  plan: ReturnCovenantPlan;
  requestValue: unknown;
}) {
  if (
    !isRecord(params.requestValue) ||
    typeof params.requestValue.requestNonce !== "string" ||
    !SHA256.test(params.requestValue.requestNonce)
  ) {
    throw new ReturnCovenantProtocolError(
      "invalid-retention-request",
      "return-covenant resource inspection request is invalid",
    );
  }
  const expected = buildReturnCovenantRetentionRequest({
    caseForms: params.caseForms,
    cleanupRun: params.cleanupRun,
    plan: params.plan,
    requestNonce: params.requestValue.requestNonce,
  });
  if (stableStringify(params.requestValue) !== stableStringify(expected)) {
    throw new ReturnCovenantProtocolError(
      "evidence-mismatch",
      "return-covenant resource inspection identity mismatch",
      409,
    );
  }
  return expected;
}

export class ReturnCovenantRetentionInspector {
  #consumed = false;

  async inspect(params: {
    activeCaseCount: number;
    cleanupRun: ReturnCovenantRunCleanupReceipt | undefined;
    completed: ReadonlyMap<string, CompletedReturnCovenantCase>;
    context: ReturnCovenantFixtureContext;
    gateway: ReturnCovenantGatewayBinding;
    requestValue: unknown;
  }): Promise<Record<string, unknown>> {
    if (
      !params.cleanupRun ||
      params.activeCaseCount !== 0 ||
      params.completed.size !== params.context.plan.cases.length * 2
    ) {
      throw new ReturnCovenantProtocolError(
        "incomplete-cleanup",
        "return-covenant resource inspection requires completed run cleanup",
        409,
      );
    }
    if (this.#consumed) {
      throw new ReturnCovenantProtocolError(
        "phase-replay",
        "return-covenant resource inspection was already consumed",
        409,
      );
    }
    const caseForms = params.context.plan.cases.flatMap((casePlan) =>
      casePlan.forms.map((form) => {
        const completed = params.completed.get(returnCovenantExecutionKey(casePlan.id, form));
        if (!completed) {
          throw new Error(`return-covenant completed case is missing: ${casePlan.id}/${form}`);
        }
        return { caseId: casePlan.id, form, caseHandle: completed.caseHandle };
      }),
    );
    const request = validateRetentionRequest({
      caseForms,
      cleanupRun: params.cleanupRun,
      plan: params.context.plan,
      requestValue: params.requestValue,
    });
    this.#consumed = true;
    const retained = await retainedReturnCovenantResources({ context: params.context });
    if (Object.values(retained).some((count) => count !== 0)) {
      throw new ReturnCovenantProtocolError(
        "incomplete-cleanup",
        "return-covenant resource inspection found retained state",
        409,
      );
    }
    return {
      schema: RETURN_COVENANT_RETENTION_RESPONSE_SCHEMA,
      rowId: params.context.plan.rowId,
      runId: params.context.plan.runId,
      candidateSha: params.context.plan.target.candidateSha,
      productTreeSha: params.context.plan.target.productTreeSha,
      runtimeBuildSha: params.context.plan.target.runtimeBuildSha,
      runtimeConfigSha256: params.context.plan.target.runtimeConfigSha256,
      runtimeArtifactManifestSha256: params.context.plan.target.runtimeArtifactManifestSha256,
      requestNonce: request.requestNonce,
      observedAt: new Date(params.context.clock.wallNow()).toISOString(),
      gateway: {
        endpoint: params.gateway.endpoint,
        namespacePid: params.gateway.pid,
        namespaceStartFingerprint: params.gateway.startFingerprint,
      },
      resources: Object.fromEntries(
        retentionResources.map(({ category, method }) => [
          category,
          { method, complete: true, total: 0, nextCursor: null, items: [] },
        ]),
      ),
    };
  }
}
