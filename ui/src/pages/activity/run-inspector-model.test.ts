import { describe, expect, it } from "vitest";
// @vitest-environment node
import {
  classifyRunInspection,
  mergeDecisionPage,
  type RunInspectorResult,
} from "./run-inspector-model.ts";

function unavailable(
  state: "unknown" | "unsupported" | "ambiguous",
  reasonCode: string,
  remediation: Array<{ code: string; text: string }> = [],
): RunInspectorResult {
  return {
    schemaVersion: 1,
    run: { runId: "run-1", status: state === "unknown" ? "unknown" : "known" },
    identity:
      state === "ambiguous"
        ? {
            state,
            reasonCode,
            candidates: [],
            missingEvidence: ["execution.selection"],
            remediation,
          }
        : {
            state,
            reasonCode,
            missingEvidence: ["identity.context"],
            remediation,
          },
    decisionDisplays: [],
    coverage: { state: state === "ambiguous" ? "unknown" : state, missingEvidence: [] },
  };
}

describe("classifyRunInspection", () => {
  it.each([
    [unavailable("unknown", "run_not_found"), "not-found"],
    [unavailable("unknown", "identity_context_corrupt"), "corrupt"],
    [
      unavailable("unsupported", "identity_context_unavailable", [
        { code: "run_again_after_expiry", text: "Run again." },
      ]),
      "expired",
    ],
    [unavailable("unsupported", "identity_context_unavailable"), "unsupported"],
    [unavailable("unknown", "run_evidence_unreadable"), "unknown"],
    [unavailable("ambiguous", "execution_selection_required"), "ambiguous"],
  ] as const)("classifies the authoritative diagnostic result as %s", (result, expected) => {
    expect(classifyRunInspection(result)).toBe(expected);
  });
});

describe("receipt paging model", () => {
  const present = {
    schemaVersion: 1,
    run: {
      runId: "run-1",
      executionId: "execution-1",
      status: "known" as const,
    },
    identity: {
      state: "present" as const,
      context: {
        schemaVersion: 1,
        contextId: "context-1",
        executionId: "execution-1",
        runId: "run-1",
        createdAt: 1,
        trustDomain: {
          kind: "gateway-cell" as const,
          domainRef: "domain",
          state: "present" as const,
        },
        invoker: { state: "absent" as const },
        ingress: {
          kind: "gateway-client" as const,
          boundary: "agent-command.gateway",
          state: "present" as const,
        },
        agentPrincipal: {
          kind: "agent" as const,
          domainRef: "domain",
          principalRef: "main",
        },
        agentDefinition: { definitionRef: "main", state: "unknown" as const },
        runtimeInstance: {
          runtimeRef: "gateway",
          kind: "gateway" as const,
          state: "present" as const,
        },
        applicableGrants: [],
        assurance: [],
        coverageState: "attribution-only" as const,
        missingEvidence: [],
      },
    },
    decisionDisplays: [],
    coverage: { state: "attribution-only" as const, missingEvidence: [] },
  } satisfies RunInspectorResult;

  it("merges only a page for the exact inspected execution and context", () => {
    const page = { ...present, nextDecisionCursor: "g:10:2" };
    expect(mergeDecisionPage(present, page)?.nextDecisionCursor).toBe("g:10:2");
    expect(
      mergeDecisionPage(present, {
        ...page,
        run: { ...page.run, executionId: "execution-2" },
      }),
    ).toBeNull();
  });
});
