/** Exact-execution facts for message-action boundaries without a durable owner record. */
import { createHash } from "node:crypto";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { ExecutionIdentityAdmissionToken } from "./execution-identity-admission.js";

const state = resolveGlobalSingleton(Symbol.for("openclaw.messageActionDecisionSink"), () => ({
  sink: undefined as ((receipt: DecisionReceiptV1) => boolean) | undefined,
}));

export function configureMessageActionDecisionSink(
  sink: (receipt: DecisionReceiptV1) => boolean,
): () => void {
  state.sink = sink;
  return () => {
    if (state.sink === sink) {
      state.sink = undefined;
    }
  };
}

function decisionId(params: {
  contextId: string;
  actionId: string;
  reasonCode: string;
  receiptDiscriminator?: string;
}): string {
  const identity = [params.contextId, params.actionId, params.reasonCode];
  if (params.receiptDiscriminator) {
    identity.push(params.receiptDiscriminator);
  }
  const digest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("base64url")
    .slice(0, 32);
  return `message-action:${digest}`;
}

/** Queue one unowned action or policy fact after the exact admission tuple. */
export function recordMessageActionDecision(params: {
  token: ExecutionIdentityAdmissionToken | undefined;
  actionId: string;
  action: string;
  channel?: string;
  outcome: "allowed" | "denied" | "not-applicable" | "unknown";
  reasonCode: string;
  coverageState: "enforced" | "attribution-only" | "unknown";
  policyRefs?: string[];
  summary: string;
  remediation: DecisionReceiptV1["remediation"];
  /** Internal deterministic occurrence identity; hashed into the receipt id and never retained. */
  receiptDiscriminator?: string;
  occurredAt?: number;
}): boolean {
  const token = params.token;
  if (!token || !state.sink) {
    return false;
  }
  const resourceRef = params.channel ? `channel:${params.channel}` : undefined;
  const receiptId = decisionId({
    contextId: token.contextId,
    actionId: params.actionId,
    reasonCode: params.reasonCode,
    receiptDiscriminator: params.receiptDiscriminator,
  });
  return state.sink({
    schemaVersion: 1,
    receiptId,
    contextId: token.contextId,
    executionId: token.executionId,
    runId: token.runId,
    ...(params.actionId.length <= 256 ? { actionId: params.actionId } : {}),
    occurredAt: params.occurredAt ?? Date.now(),
    action: {
      family: "message",
      operation: params.action,
      ...(resourceRef && resourceRef.length <= 256 ? { resourceRef } : {}),
      summary: params.summary,
    },
    decision: { outcome: params.outcome, reasonCode: params.reasonCode },
    enforcement: {
      coverageState: params.coverageState,
      evaluatorRef: "message-action",
      policyRefs: params.policyRefs ?? [],
      grantRefs: [],
      contextFieldsUsed: ["contextId", "executionId", "runId"],
    },
    source: {
      owner: "message-action",
      recordRef: receiptId,
      decisionBoundary: "message-tool.action",
    },
    missingEvidence: [],
    remediation: params.remediation,
  });
}
