import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";

export type ChannelAdmissionDecisionReceiptInput = {
  contextId: string;
  executionId: string;
  runId: string;
  occurredAt: number;
  coverageState: "enforced" | "attribution-only" | "unknown" | "unsupported";
  identifierAuthentication: "affected" | "evaluated" | "not-evaluated" | "unknown";
};

/** Project one owner-native channel decision into the shared receipt contract. */
export function createChannelAdmissionDecisionReceipt(
  params: ChannelAdmissionDecisionReceiptInput,
): DecisionReceiptV1 {
  const missingEvidence =
    params.coverageState === "unknown"
      ? ["channel.admission_evidence"]
      : params.coverageState === "unsupported"
        ? ["channel.adapter_identity"]
        : params.coverageState === "attribution-only"
          ? ["decision.participant_effect"]
          : [];
  const identifierPolicyEvaluated =
    params.identifierAuthentication === "affected" ||
    params.identifierAuthentication === "evaluated";
  return {
    schemaVersion: 1,
    receiptId: `${params.contextId}:channel-admission`,
    contextId: params.contextId,
    executionId: params.executionId,
    runId: params.runId,
    occurredAt: params.occurredAt,
    action: {
      family: "channel",
      operation: "admission",
      summary: "Channel ingress admitted this agent execution.",
    },
    decision: {
      outcome:
        params.coverageState === "unknown" || params.coverageState === "unsupported"
          ? "unknown"
          : "allowed",
      reasonCode:
        params.identifierAuthentication === "affected"
          ? "channel_ingress_identifier_authentication_applied"
          : params.coverageState === "enforced"
            ? "channel_ingress_participant_enforced"
            : params.coverageState === "attribution-only"
              ? "channel_ingress_attribution_only"
              : params.coverageState === "unsupported"
                ? "channel_ingress_identity_unsupported"
                : "channel_ingress_identity_unknown",
    },
    enforcement: {
      coverageState: params.coverageState,
      evaluatorRef: "channel-ingress",
      policyRefs: identifierPolicyEvaluated ? ["channel.identifier-authentication"] : [],
      grantRefs: [],
      contextFieldsUsed: [
        ...(params.coverageState === "enforced" ? ["invoker.principal"] : []),
        ...(params.identifierAuthentication === "affected"
          ? ["channel.identifier-authentication"]
          : []),
      ],
    },
    source: {
      owner: "channel-ingress",
      recordRef: `${params.contextId}:channel-admission`,
      decisionBoundary: "channel-ingress.run-admission",
    },
    missingEvidence,
    remediation:
      params.coverageState === "enforced"
        ? []
        : [
            {
              code: "treat_as_diagnostic_provenance",
              text: "Treat this receipt as diagnostic provenance, not authorization.",
            },
          ],
  };
}
