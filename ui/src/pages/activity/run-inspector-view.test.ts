/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import type { RunInspectorState } from "./run-inspector-model.ts";
import { renderRunInspector } from "./run-inspector-view.ts";

const hmacRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;

function presentResult(): AuditRunInspectResult {
  return {
    schemaVersion: 1,
    run: { runId: "run-1", executionId: "execution-1", status: "known" },
    identity: {
      state: "present",
      context: {
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
        runtimeInstance: { runtimeRef: hmacRef, kind: "embedded", state: "unsupported" },
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
        lineage: { parentRunId: "parent-run", depth: 1 },
        coverageState: "unattributed",
        missingEvidence: ["invoker.principal"],
      },
    },
    decisions: [
      {
        schemaVersion: 1,
        receiptId: "receipt-1",
        contextId: "context-1",
        executionId: "execution-1",
        runId: "run-1",
        occurredAt: 1,
        action: {
          family: "run",
          operation: "admission",
          summary: "Run admission was recorded without identity-aware evaluation.",
        },
        decision: { outcome: "not-applicable", reasonCode: "identity_not_evaluated" },
        enforcement: {
          coverageState: "unattributed",
          policyRefs: [],
          grantRefs: [],
          contextFieldsUsed: [],
        },
        source: {
          owner: "agent-command",
          recordRef: "context-1",
          decisionBoundary: "agent-command.run-admission",
        },
        missingEvidence: ["invoker.principal"],
        remediation: [
          { code: "no_identity_enforcement_claimed", text: "Do not treat this as authorization." },
        ],
      },
    ],
    coverage: { state: "unattributed", missingEvidence: ["invoker.principal"] },
    nextDecisionCursor: "1",
  };
}

function unavailableResult(
  state: "unknown" | "unsupported",
  reasonCode: string,
  remediation: Array<{ code: string; text: string }> = [],
): AuditRunInspectResult {
  return {
    schemaVersion: 1,
    run: { runId: "run-1", status: state === "unknown" ? "unknown" : "known" },
    identity: {
      state,
      reasonCode,
      missingEvidence: ["identity.context"],
      remediation,
    },
    decisions: [],
    coverage: { state, missingEvidence: ["identity.context"] },
  };
}

function renderState(state: RunInspectorState) {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderRunInspector({ basePath: "/operator", state, onRetry: vi.fn() }), container);
  return container;
}

describe("renderRunInspector", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders every identity dimension with explicit text states and safe refs", () => {
    const container = renderState({ status: "ready", runId: "run-1", result: presentResult() });

    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
      "Inspection coverage: Unattributed",
    );
    const text = container.textContent ?? "";
    for (const label of [
      "Trust domain",
      "Ingress",
      "Invoker",
      "Represented subject",
      "Sponsor",
      "Agent principal",
      "Agent definition",
      "Runtime instance",
      "Applicable grant 1",
      "Assurance evidence 1",
      "Lineage",
    ]) {
      expect(text).toContain(label);
    }
    for (const state of ["Present", "Absent", "Unknown", "Unsupported"]) {
      expect(text).toContain(state);
      expect(container.querySelector(`[aria-label="Evidence state: ${state}"]`)).not.toBeNull();
    }
    expect(text).toContain(hmacRef);
    expect(text).not.toContain("receipt-1");
    expect(text).not.toContain("context-1");
    expect(text).not.toContain("execution-1");
    expect(text).toContain("Additional decision receipts are available");
    expect(text).toContain("Best-effort audit warning");
    expect(text).not.toContain("raw-sender-id-42");
    expect(
      container.querySelector<HTMLAnchorElement>('a[href*="view=run"]')?.getAttribute("href"),
    ).toBe("/operator/activity?view=run&run=parent-run");
  });

  it.each([
    [{ status: "empty" } satisfies RunInspectorState, "No run selected"],
    [
      { status: "loading", runId: "run-1", waitingForGateway: false } satisfies RunInspectorState,
      "Loading run inspection",
    ],
    [
      { status: "loading", runId: "run-1", waitingForGateway: true } satisfies RunInspectorState,
      "Waiting for the Gateway",
    ],
    [
      { status: "disconnected", runId: "run-1" } satisfies RunInspectorState,
      "Gateway disconnected",
    ],
    [
      { status: "unauthorized", runId: "run-1" } satisfies RunInspectorState,
      "Operator read access required",
    ],
    [
      { status: "unsupported", runId: "run-1" } satisfies RunInspectorState,
      "Run inspection unsupported",
    ],
    [{ status: "error", runId: "run-1" } satisfies RunInspectorState, "Run inspection failed"],
  ])("renders the explicit panel state", (state, expected) => {
    expect(renderState(state).textContent).toContain(expected);
  });

  it.each([
    [unavailableResult("unknown", "run_not_found"), "Run not found"],
    [
      unavailableResult("unsupported", "identity_context_unavailable", [
        { code: "run_again_after_expiry", text: "Run it again." },
      ]),
      "Identity evidence expired",
    ],
    [unavailableResult("unknown", "identity_context_corrupt"), "Identity evidence is corrupt"],
    [
      unavailableResult("unsupported", "identity_context_unavailable"),
      "Identity evidence unsupported",
    ],
  ])("renders the Gateway's typed diagnostic state", (result, expected) => {
    expect(renderState({ status: "ready", runId: "run-1", result }).textContent).toContain(
      expected,
    );
  });
});
