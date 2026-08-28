/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import type { RunInspectorResult, RunInspectorState } from "./run-inspector-model.ts";
import { renderRunInspector } from "./run-inspector-view.ts";

const hmacRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;

function presentResult(): RunInspectorResult {
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
    decisionDisplays: [
      {
        schemaVersion: 1,
        selectorId: "receipt-1",
        occurredAt: 1,
        action: {
          family: "run",
          operation: "admission",
          summary: "Run admission was recorded without identity-aware evaluation.",
        },
        decision: { outcome: "not-applicable", reasonCode: "identity_not_evaluated" },
        enforcement: {
          coverageState: "unattributed",
          policyCount: 0,
          grantCount: 0,
          contextFieldsUsed: [],
        },
        provenance: { state: "verified", producer: "run-admission" },
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
): RunInspectorResult {
  return {
    schemaVersion: 1,
    run: { runId: "run-1", status: state === "unknown" ? "unknown" : "known" },
    identity: {
      state,
      reasonCode,
      missingEvidence: ["identity.context"],
      remediation,
    },
    decisionDisplays: [],
    coverage: { state, missingEvidence: ["identity.context"] },
  };
}

type ViewTestState =
  | Exclude<RunInspectorState, { status: "ready" }>
  | (Omit<Extract<RunInspectorState, { status: "ready" }>, "receiptPageCursors"> & {
      receiptPageCursors?: ReadonlyMap<string, string | undefined>;
    });

function renderState(state: ViewTestState, onLoadMoreExecutions = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  const normalizedState: RunInspectorState =
    state.status === "ready"
      ? {
          ...state,
          receiptPageCursors:
            state.receiptPageCursors ??
            new Map(
              state.result.decisionDisplays.map((receipt) => [receipt.selectorId, undefined]),
            ),
        }
      : state;
  render(
    renderRunInspector({
      basePath: "/operator",
      state: normalizedState,
      selector: { kind: "run", id: "run-1" },
      selectorId: null,
      onLoadMoreDecisions: vi.fn(),
      onLoadMoreExecutions,
      onRestart: vi.fn(),
      onRetry: vi.fn(),
    }),
    container,
  );
  return container;
}

describe("renderRunInspector", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders every identity dimension with explicit text states and safe refs", () => {
    const container = renderState({ status: "ready", result: presentResult() });

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
    expect(text).toContain("Not applicable");
    expect(text).toContain("Unattributed");
    expect(text).toContain("identity_not_evaluated");
    expect(text).toContain("Verified producer");
    expect(text).toContain("run-admission");
    expect(text).toContain("Do not treat this as authorization.");
    expect(text).toContain("Best-effort audit warning");
    expect(text).not.toContain("raw-sender-id-42");
    expect(
      container.querySelector<HTMLAnchorElement>('a[href*="view=run"]')?.getAttribute("href"),
    ).toBe("/operator/activity?view=run&run=parent-run");
  });

  it.each([
    [{ status: "empty" } satisfies RunInspectorState, "No run selected"],
    [
      { status: "loading", waitingForGateway: false } satisfies RunInspectorState,
      "Loading run inspection",
    ],
    [
      { status: "loading", waitingForGateway: true } satisfies RunInspectorState,
      "Waiting for the Gateway",
    ],
    [{ status: "disconnected" } satisfies RunInspectorState, "Gateway disconnected"],
    [{ status: "unauthorized" } satisfies RunInspectorState, "Operator read access required"],
    [{ status: "unsupported" } satisfies RunInspectorState, "Run inspection unsupported"],
    [{ status: "error", recovery: "retry" } satisfies RunInspectorState, "Run inspection failed"],
  ])("renders the explicit panel state", (state, expected) => {
    expect(renderState(state).textContent).toContain(expected);
  });

  it("renders the localized restart control with its accessible name", () => {
    expect(t("activity.runInspector.restart")).toBe("Restart inspection");

    const button = renderState({ status: "error", recovery: "restart" }).querySelector("button");
    expect(button?.textContent?.trim()).toBe("Restart inspection");
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
    expect(renderState({ status: "ready", result }).textContent).toContain(expected);
  });

  it("links an ambiguous run candidate to exact execution inspection", () => {
    const result: RunInspectorResult = {
      schemaVersion: 1,
      run: { runId: "ambiguous-run", status: "known" },
      identity: {
        state: "ambiguous",
        reasonCode: "execution_selection_required",
        candidates: [
          { executionId: "execution:a/b", contextId: "candidate-context", createdAt: 1 },
        ],
        missingEvidence: ["execution.selection"],
        remediation: [],
      },
      decisionDisplays: [],
      coverage: { state: "unknown", missingEvidence: ["execution.selection"] },
      nextExecutionCursor: "opaque-cursor",
    };

    const onLoadMoreExecutions = vi.fn();
    const container = renderState({ status: "ready", result }, onLoadMoreExecutions);
    const link = container.querySelector<HTMLAnchorElement>('a[href*="execution="]');
    expect(link?.textContent).toContain("execution:a/b");
    expect(link?.getAttribute("href")).toBe(
      "/operator/activity?view=run&execution=execution%3Aa%2Fb",
    );
    const loadMore = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Load more executions"),
    );
    loadMore?.click();
    expect(onLoadMoreExecutions).toHaveBeenCalledOnce();

    const loading = renderState({ status: "ready", result, executionPageStatus: "loading" });
    expect(loading.querySelector("button")?.disabled).toBe(true);
    expect(loading.textContent).toContain("Loading executions…");

    const failed = renderState({ status: "ready", result, executionPageStatus: "error" });
    expect(failed.querySelector('[role="alert"]')?.textContent).toContain(
      "More executions could not be loaded",
    );
  });
});
