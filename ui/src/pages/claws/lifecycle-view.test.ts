/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClawCatalogDetail,
  ClawLifecyclePlanResult,
  ClawStatusEntry,
} from "../../../../packages/gateway-protocol/src/index.js";
import { i18n } from "../../i18n/index.ts";
import { renderClawLifecycle, type ClawLifecycleViewProps } from "./lifecycle-view.ts";

const detail: ClawCatalogDetail = {
  packageName: "financial-analyst",
  displayName: "Financial Analyst",
  version: "1.2.0",
  channel: "community",
  official: false,
  workspaceFiles: 3,
  skills: 2,
  plugins: 1,
  mcpServers: 1,
  scheduledJobs: 1,
};

const selected: ClawStatusEntry = {
  agentId: "analyst",
  name: "financial-analyst",
  version: "1.1.0",
  sourceKind: "package",
  status: "complete",
  agentState: "present",
  bootstrapState: "pending",
  orphaned: false,
  addedAtMs: 1,
  updatedAtMs: 2,
  resources: [],
};

const plan: ClawLifecyclePlanResult = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "update",
  planIntegrity: "sha256:plan",
  target: { agentId: "analyst", targetVersion: "1.2.0" },
  actions: [{ kind: "workspace-file", id: "SOUL.md", action: "update", blocked: false }],
  capabilities: [],
  blockers: [],
  riskAcknowledgementRequired: true,
};

function props(overrides: Partial<ClawLifecycleViewProps> = {}): ClawLifecycleViewProps {
  return {
    catalogAvailable: true,
    lifecycleAvailable: true,
    mutationAvailable: true,
    busy: false,
    error: null,
    query: "finance",
    entries: [],
    detail,
    selected,
    plan: null,
    completion: null,
    removeUnused: false,
    riskAcknowledged: false,
    onQueryChange: vi.fn(),
    onSearch: vi.fn(),
    onSelectCatalog: vi.fn(),
    onPreviewAdd: vi.fn(),
    onPreviewUpdate: vi.fn(),
    onPreviewRemove: vi.fn(),
    onApply: vi.fn(),
    onCancelPlan: vi.fn(),
    onRemoveUnusedChange: vi.fn(),
    onRiskAcknowledgedChange: vi.fn(),
    onOpenChat: vi.fn(),
    ...overrides,
  };
}

describe("renderClawLifecycle", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  it("shows package contents and targets the selected matching agent", () => {
    const container = document.createElement("div");
    render(renderClawLifecycle(props()), container);
    expect(container.textContent).toContain("Financial Analyst");
    expect(container.textContent).toContain("Workspace files");
    expect(container.textContent).toContain("Complete setup");
    expect(container.textContent).toContain("Package-authored setup");
    expect(container.textContent).toContain("never paste passwords, tokens");
    expect(container.querySelectorAll("button:disabled")).toHaveLength(0);
  });

  it("does not show the package-authored setup warning after bootstrap completes", () => {
    const container = document.createElement("div");
    render(
      renderClawLifecycle(props({ selected: { ...selected, bootstrapState: "complete" } })),
      container,
    );
    expect(container.textContent).not.toContain("Package-authored setup");
    expect(container.textContent).not.toContain("Complete setup");
  });

  it("requires explicit risk consent before apply", () => {
    const container = document.createElement("div");
    render(renderClawLifecycle(props({ plan })), container);
    const apply = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Apply approved changes"),
    );
    expect(apply?.disabled).toBe(true);
    expect(container.textContent).toContain("accept this package risk");
  });

  it("never offers chat for a completed removal", () => {
    const container = document.createElement("div");
    render(
      renderClawLifecycle(
        props({
          selected: null,
          completion: {
            schemaVersion: "openclaw.clawsGatewayApply.v1",
            operation: "remove",
            status: "complete",
            agentId: "analyst",
            message: "Removed.",
          },
        }),
      ),
      container,
    );
    expect(container.textContent).toContain("Removed.");
    expect(container.textContent).not.toContain("Open chat");
  });

  it("presents a partial mutation as needing recovery and suppresses chat", () => {
    const container = document.createElement("div");
    render(
      renderClawLifecycle(
        props({
          completion: {
            schemaVersion: "openclaw.clawsGatewayApply.v1",
            operation: "update",
            status: "partial",
            agentId: "analyst",
            message: "Claw update needs operator attention.",
          },
        }),
      ),
      container,
    );
    expect(container.querySelector(".callout.warn")).not.toBeNull();
    expect(container.textContent).toContain("review Diagnostics");
    expect(container.textContent).not.toContain("Open chat");
  });
});
