import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { validateAuditRunInspectParams, validateExecutionIdentityContextV1 } from "../index.js";
import {
  AuditRunInspectParamsSchema,
  AuditRunInspectResultSchema,
  DecisionReceiptDisplayV1Schema,
  DecisionReceiptV1Schema,
  type ExecutionIdentityContextV1,
} from "./audit-run.js";

const hmacRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;

function context(): ExecutionIdentityContextV1 {
  return {
    schemaVersion: 1,
    contextId: "context-1",
    executionId: "execution-1",
    runId: "run-1",
    createdAt: 1,
    trustDomain: { kind: "gateway-cell", domainRef: hmacRef, state: "present" },
    invoker: { state: "absent" },
    ingress: {
      kind: "local-cli",
      boundary: "agent-command.local",
      state: "present",
    },
    agentPrincipal: { kind: "agent", domainRef: hmacRef, principalRef: "main" },
    agentDefinition: { definitionRef: "main", state: "present" },
    runtimeInstance: { runtimeRef: hmacRef, kind: "embedded", state: "present" },
    applicableGrants: [],
    assurance: [{ kind: "runtime-binding", evidenceRef: hmacRef, strength: "boundary-verified" }],
    coverageState: "unattributed",
    missingEvidence: ["invoker.principal"],
  };
}

describe("audit run inspection protocol", () => {
  it("accepts the bounded V1 context and truthful admission receipt", () => {
    const identity = context();
    expect(validateExecutionIdentityContextV1(identity)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(identity), "utf8")).toBeLessThan(16 * 1024);

    const validateReceipt = Compile(DecisionReceiptV1Schema);
    expect(
      validateReceipt.Check({
        schemaVersion: 1,
        receiptId: "receipt-1",
        contextId: identity.contextId,
        executionId: identity.executionId,
        runId: identity.runId,
        occurredAt: identity.createdAt,
        action: { family: "run", operation: "admission" },
        decision: {
          outcome: "not-applicable",
          reasonCode: "run_admission_identity_not_evaluated",
        },
        enforcement: {
          coverageState: "unattributed",
          policyRefs: [],
          grantRefs: [],
          contextFieldsUsed: [],
        },
        source: {
          owner: "agent-command",
          recordRef: identity.contextId,
          decisionBoundary: "agent-command.run-admission",
        },
        missingEvidence: ["invoker.principal"],
        remediation: [{ code: "none", text: "No enforcement is claimed." }],
      }),
    ).toBe(true);
  });

  it("closes request objects and enforces exact-run query bounds", () => {
    expect(validateAuditRunInspectParams({ runId: "run-1", decisionLimit: 100 })).toBe(true);
    expect(validateAuditRunInspectParams({ executionId: "execution-1" })).toBe(true);
    expect(validateAuditRunInspectParams({ runId: "run-1", executionLimit: 50 })).toBe(true);
    expect(validateAuditRunInspectParams({ runId: "run-1", executionLimit: 51 })).toBe(false);
    expect(validateAuditRunInspectParams({})).toBe(false);
    expect(validateAuditRunInspectParams({ runId: "run-1", executionId: "execution-1" })).toBe(
      false,
    );
    expect(validateAuditRunInspectParams({ executionId: "execution-1", executionLimit: 2 })).toBe(
      false,
    );
    expect(validateAuditRunInspectParams({ runId: "", decisionLimit: 50 })).toBe(false);
    expect(validateAuditRunInspectParams({ runId: "run-1", decisionLimit: 101 })).toBe(false);
    expect(validateAuditRunInspectParams({ runId: "run-1", extra: true })).toBe(false);
  });

  it("accepts only the bounded safe decision display contract", () => {
    const validate = Compile(DecisionReceiptDisplayV1Schema);
    const display = {
      schemaVersion: 1,
      selectorId: "decision-fact:1",
      occurredAt: 1,
      action: { family: "decision", operation: "record" },
      decision: { outcome: "unknown", reasonCode: "decision_fact_display_unverified" },
      enforcement: {
        coverageState: "unknown",
        policyCount: 1,
        grantCount: 0,
        contextFieldsUsed: [],
      },
      provenance: { state: "unverified" },
      missingEvidence: ["decision.display_provenance"],
      remediation: [],
    };
    expect(validate.Check(display)).toBe(true);
    expect(validate.Check({ ...display, selectorId: undefined, receiptId: "hostile" })).toBe(false);
    expect(validate.Check({ ...display, source: { owner: "operator_approvals" } })).toBe(false);
    expect(
      validate.Check({
        ...display,
        provenance: { state: "verified", producer: "receipt-owner" },
      }),
    ).toBe(false);
  });

  it("exports selector and discovery-pagination invariants for generated clients", () => {
    const validate = Compile(AuditRunInspectParamsSchema);

    expect(validate.Check({ runId: "run-1", executionCursor: "cursor-1" })).toBe(true);
    expect(validate.Check({ executionId: "execution-1", decisionLimit: 100 })).toBe(true);
    expect(validate.Check({})).toBe(false);
    expect(validate.Check({ runId: "run-1", executionId: "execution-1" })).toBe(false);
    expect(validate.Check({ executionId: "execution-1", executionCursor: "cursor-1" })).toBe(false);
    expect(validate.Check({ executionId: "execution-1", executionLimit: 2 })).toBe(false);
  });

  it("accepts bounded ambiguous run discovery without selecting an execution", () => {
    const validate = Compile(AuditRunInspectResultSchema);
    expect(
      validate.Check({
        schemaVersion: 1,
        run: { runId: "run-1", status: "known" },
        identity: {
          state: "ambiguous",
          reasonCode: "execution_selection_required",
          candidates: [
            { executionId: "execution-1", contextId: "context-1", createdAt: 1 },
            { executionId: "execution-2", contextId: "context-2", createdAt: 2 },
          ],
          missingEvidence: ["execution.selection"],
          remediation: [{ code: "select_execution_id", text: "Select one exact execution." }],
        },
        decisionDisplays: [],
        coverage: { state: "unknown", missingEvidence: ["execution.selection"] },
      }),
    ).toBe(true);
  });

  it("exports a required safe-only decision presentation", () => {
    const validate = Compile(AuditRunInspectResultSchema);
    const result = {
      schemaVersion: 1,
      run: { runId: "run-1", status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_not_found",
        missingEvidence: ["run.record"],
        remediation: [],
      },
      decisionDisplays: [],
      coverage: { state: "unknown", missingEvidence: ["run.record"] },
    };

    expect(validate.Check(result)).toBe(true);
    expect(validate.Check({ ...result, decisionDisplays: undefined })).toBe(false);
    expect(validate.Check({ ...result, decisions: [] })).toBe(false);
  });

  it("rejects malformed, oversized, and open-ended context payloads", () => {
    expect(validateExecutionIdentityContextV1({ ...context(), extra: true })).toBe(false);
    expect(
      validateExecutionIdentityContextV1({
        ...context(),
        missingEvidence: Array.from({ length: 17 }, (_, index) => `missing-${index}`),
      }),
    ).toBe(false);
    expect(
      validateExecutionIdentityContextV1({
        ...context(),
        runtimeInstance: { ...context().runtimeInstance, kind: "mystery" },
      }),
    ).toBe(false);
  });

  it.each(["unknown", "unsupported"] as const)(
    "accepts a typed %s diagnostic without inventing identity",
    (state) => {
      const validate = Compile(AuditRunInspectResultSchema);
      expect(
        validate.Check({
          schemaVersion: 1,
          run: { runId: "run-1", status: state === "unknown" ? "unknown" : "known" },
          identity: {
            state,
            reasonCode: `${state}_identity`,
            missingEvidence: ["identity.context"],
            remediation: [{ code: "retry", text: "Retry after checking the run id." }],
          },
          decisionDisplays: [],
          coverage: { state, missingEvidence: ["identity.context"] },
        }),
      ).toBe(true);
    },
  );
});
