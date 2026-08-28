/** Bounded execution facts for owner-controlled runtime gates and actions. */
import { createHash } from "node:crypto";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { ExecutionIdentityAdmissionToken } from "./execution-identity-admission.js";

const state = resolveGlobalSingleton<{
  sink: ((receipt: DecisionReceiptV1) => boolean) | undefined;
}>(Symbol.for("openclaw.runtimeActionDecisionSink"), () => ({ sink: undefined }));

export function configureRuntimeActionDecisionSink(
  sink: (receipt: DecisionReceiptV1) => boolean,
): () => void {
  state.sink = sink;
  return () => {
    if (state.sink === sink) {
      state.sink = undefined;
    }
  };
}

function receiptId(params: {
  contextId: string;
  owner: string;
  operation: string;
  reasonCode: string;
  discriminator?: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        params.contextId,
        params.owner,
        params.operation,
        params.reasonCode,
        params.discriminator ?? null,
      ]),
    )
    .digest("base64url")
    .slice(0, 32);
  return `runtime-action:${digest}`;
}

type RuntimeActionDecisionParams = {
  token: ExecutionIdentityAdmissionToken | undefined;
  family: "plugin" | "node" | "worker" | "native-runtime";
  operation: string;
  outcome: "allowed" | "denied" | "not-applicable" | "unknown";
  coverageState: "enforced" | "attribution-only" | "unknown" | "unsupported";
  reasonCode: string;
  owner: "plugin-hook" | "plugin-runtime" | "node-runtime" | "worker-runtime" | "acp-runtime";
  decisionBoundary: string;
  policyRefs?: string[];
  summary: string;
  missingEvidence?: string[];
  remediation: DecisionReceiptV1["remediation"];
  /** Sensitive owner/runtime identifiers may be hashed here but are never retained. */
  discriminator?: string;
  occurredAt?: number;
};

/** Queue one owner-bound fact after exact execution admission. */
export function recordRuntimeActionDecision(params: RuntimeActionDecisionParams): boolean {
  const token = params.token;
  if (!token || !state.sink) {
    return false;
  }
  const id = receiptId({
    contextId: token.contextId,
    owner: params.owner,
    operation: params.operation,
    reasonCode: params.reasonCode,
    discriminator: params.discriminator,
  });
  return state.sink({
    schemaVersion: 1,
    receiptId: id,
    contextId: token.contextId,
    executionId: token.executionId,
    runId: token.runId,
    occurredAt: params.occurredAt ?? Date.now(),
    action: {
      family: params.family,
      operation: params.operation,
      summary: params.summary,
    },
    decision: { outcome: params.outcome, reasonCode: params.reasonCode },
    enforcement: {
      coverageState: params.coverageState,
      evaluatorRef: params.owner,
      policyRefs: params.policyRefs ?? [],
      grantRefs: [],
      contextFieldsUsed: ["contextId", "executionId", "runId"],
    },
    source: {
      owner: params.owner,
      recordRef: id,
      decisionBoundary: params.decisionBoundary,
    },
    missingEvidence: params.missingEvidence ?? [],
    remediation: params.remediation,
  });
}
