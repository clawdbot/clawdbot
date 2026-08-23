import type {
  AuditRunInspectResult,
  DecisionReceiptDisplayV1,
} from "../../../packages/gateway-protocol/src/schema/audit-run.js";

const hmacRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;

export function presentResult(
  runId: string,
  executionId = "execution-safe-ref",
): AuditRunInspectResult {
  return {
    schemaVersion: 1,
    run: { runId, executionId, status: "known" },
    identity: {
      state: "present",
      context: {
        schemaVersion: 1,
        contextId: "context-safe-ref",
        executionId,
        runId,
        createdAt: 1_786_000_000_000,
        trustDomain: { kind: "gateway-cell", domainRef: hmacRef, state: "present" },
        invoker: { state: "absent" },
        ingress: {
          kind: "gateway-client",
          boundary: "agent-command.gateway",
          sourceRef: hmacRef,
          state: "present",
        },
        agentPrincipal: {
          kind: "agent",
          domainRef: hmacRef,
          principalRef: "main",
          displayLabel: "Primary agent",
        },
        agentDefinition: { definitionRef: "main", state: "unknown" },
        runtimeInstance: { runtimeRef: hmacRef, kind: "gateway", state: "unsupported" },
        representedSubject: {
          principal: { kind: "person", domainRef: hmacRef, principalRef: hmacRef },
          state: "unknown",
        },
        sponsor: {
          principal: { kind: "service", domainRef: hmacRef, principalRef: hmacRef },
          state: "unsupported",
        },
        applicableGrants: [{ grantRef: hmacRef, state: "absent" }],
        assurance: [
          { kind: "runtime-binding", evidenceRef: hmacRef, strength: "boundary-verified" },
        ],
        lineage: { parentRunId: "parent-safe-ref", depth: 1 },
        coverageState: "unattributed",
        missingEvidence: ["invoker.principal"],
      },
    },
    decisionDisplays: [
      {
        schemaVersion: 1,
        selectorId: "receipt-safe-ref",
        occurredAt: 1_786_000_000_000,
        action: {
          family: "run",
          operation: "admission",
          summary: "Run admission was recorded without identity-aware evaluation.",
        },
        decision: {
          outcome: "not-applicable",
          reasonCode: "run_admission_identity_not_evaluated",
        },
        enforcement: {
          coverageState: "unattributed",
          policyCount: 0,
          grantCount: 0,
          contextFieldsUsed: [],
        },
        provenance: { state: "verified", producer: "run-admission" },
        missingEvidence: ["invoker.principal"],
        remediation: [
          {
            code: "no_identity_enforcement_claimed",
            text: "Treat this receipt as attribution only; it does not prove authorization.",
          },
        ],
      },
    ],
    coverage: { state: "unattributed", missingEvidence: ["invoker.principal"] },
    nextDecisionCursor: "1",
  };
}

export function decisionDisplay(params: {
  id: string;
  summary: string;
  outcome: DecisionReceiptDisplayV1["decision"]["outcome"];
  reasonCode: string;
  coverageState: DecisionReceiptDisplayV1["enforcement"]["coverageState"];
  remediation: string;
  producer?: "operator-approval" | "message-delivery";
  family?: string;
  operation?: string;
}): DecisionReceiptDisplayV1 {
  return {
    schemaVersion: 1,
    selectorId: params.id,
    occurredAt: 1_786_000_000_000,
    action: {
      family: params.family ?? "exec",
      operation: params.operation ?? "approval",
      summary: params.summary,
    },
    decision: { outcome: params.outcome, reasonCode: params.reasonCode },
    enforcement: {
      coverageState: params.coverageState,
      policyCount: 1,
      grantCount: 1,
      contextFieldsUsed: ["contextId", "executionId", "runId"],
    },
    provenance: { state: "verified", producer: params.producer ?? "operator-approval" },
    missingEvidence: params.coverageState === "enforced" ? [] : ["decision.execution_link"],
    remediation: [{ code: "safe_next_step", text: params.remediation }],
  };
}

export function receiptPage(
  decisionDisplays: DecisionReceiptDisplayV1[],
  nextDecisionCursor?: string,
): AuditRunInspectResult {
  const result = presentResult("receipt-matrix");
  const { nextDecisionCursor: _nextDecisionCursor, ...base } = result;
  return {
    ...base,
    decisionDisplays,
    coverage: { state: "unknown", missingEvidence: ["decision.execution_link"] },
    ...(nextDecisionCursor ? { nextDecisionCursor } : {}),
  };
}
