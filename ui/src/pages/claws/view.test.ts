/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClawCatalogDetail,
  ClawLifecyclePlanResult,
  ClawsDoctorResult,
  ClawsStatusResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { i18n } from "../../i18n/index.ts";
import { renderClaws } from "./view.ts";

const status: ClawsStatusResult = {
  schemaVersion: "openclaw.clawsGatewayStatus.v1",
  records: [
    {
      agentId: "analyst",
      name: "financial-analyst",
      version: "1.2.0",
      sourceKind: "package",
      status: "complete",
      agentState: "present",
      orphaned: false,
      addedAtMs: 1_000,
      updatedAtMs: 2_000,
      resources: [
        {
          kind: "plugin",
          id: "@openclaw/markets@2.0.0",
          state: "present",
          relationship: "referenced",
          origin: "pre-existing",
          independentOwner: true,
        },
      ],
    },
  ],
  summary: { claws: 1, healthy: 1, attention: 0, managed: 0, referenced: 1 },
};

const doctor: ClawsDoctorResult = {
  schemaVersion: "openclaw.clawsGatewayDoctor.v1",
  findings: [],
  summary: { info: 0, warnings: 0, errors: 0 },
};

const catalogDetail: ClawCatalogDetail = {
  packageName: "financial-analyst",
  displayName: "Financial Analyst",
  summary: "Market research and reporting.",
  channel: "official",
  official: true,
  version: "1.3.0",
  workspaceFiles: 2,
  skills: 1,
  plugins: 1,
  mcpServers: 1,
  scheduledJobs: 1,
};

const plan: ClawLifecyclePlanResult = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "update",
  planIntegrity: "sha256:preview",
  target: { agentId: "analyst", name: "financial-analyst", targetVersion: "1.3.0" },
  actions: [{ kind: "workspace-file", id: "SOUL.md", action: "update", blocked: false }],
  capabilities: [
    { kind: "plugin", id: "@openclaw/markets", action: "install", reason: "Required" },
  ],
  blockers: [],
  trustWarning: "This release needs review.",
  riskAcknowledgementRequired: true,
};

function props(overrides: Partial<Parameters<typeof renderClaws>[0]> = {}) {
  return {
    connected: true,
    available: true,
    catalogAvailable: true,
    lifecycleAvailable: true,
    lifecycleMutationAvailable: true,
    configureAvailable: true,
    configureMutationAvailable: true,
    loading: false,
    operationBusy: false,
    error: null,
    status,
    doctor,
    selectedAgentId: "analyst",
    mode: "installed" as const,
    query: "",
    catalogEntries: [],
    catalogDetail: null,
    installedCatalogAgents: [],
    plan: null,
    outcome: null,
    answers: {},
    regenerateSeeds: [],
    planStale: false,
    completionReadiness: null,
    removeUnused: false,
    riskAcknowledged: false,
    onSelect: vi.fn(),
    onModeChange: vi.fn(),
    onQueryChange: vi.fn(),
    onSearch: vi.fn(),
    onSelectCatalog: vi.fn(),
    onPreviewAdd: vi.fn(),
    onPreviewUpdate: vi.fn(),
    onPreviewConfigure: vi.fn(),
    onPreviewRemove: vi.fn(),
    onRemoveUnusedChange: vi.fn(),
    onRiskAcknowledgedChange: vi.fn(),
    onAnswerChange: vi.fn(),
    onSeedSelectionChange: vi.fn(),
    onReviewPersonalization: vi.fn(),
    onCancelPlan: vi.fn(),
    onApplyPlan: vi.fn(),
    ...overrides,
  };
}

describe("renderClaws", () => {
  it("uses the shared segmented control and disables unavailable discovery", () => {
    const container = document.createElement("div");
    render(renderClaws(props({ catalogAvailable: false })), container);

    expect(container.querySelector("[role='tablist']")).toBeNull();
    const options = [
      ...container.querySelectorAll<HTMLElement & { disabled: boolean }>("wa-radio"),
    ];
    expect(options.map((option) => option.textContent?.trim())).toEqual(["Installed", "Discover"]);
    expect(options[0]?.disabled).toBe(false);
    expect(options[1]?.disabled).toBe(true);
  });

  it("keeps existing lifecycle actions available when configure is unavailable", () => {
    const personalizedStatus: ClawsStatusResult = {
      ...status,
      records: [
        {
          ...status.records[0]!,
          personalization: {
            status: "complete",
            seeds: [],
            updatePending: false,
          },
        },
      ],
    };
    render(
      renderClaws(props({ configureAvailable: false, status: personalizedStatus })),
      document.body,
    );

    expect(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Personalize",
      )?.disabled,
    ).toBe(true);
    expect(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Preview update",
      )?.disabled,
    ).toBe(false);
    expect(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Preview remove",
      )?.disabled,
    ).toBe(false);
  });

  it("keeps read-scoped previews available without mutation methods", () => {
    const container = document.createElement("div");
    render(
      renderClaws(
        props({
          plan: { ...plan, riskAcknowledgementRequired: false },
          lifecycleMutationAvailable: false,
          configureMutationAvailable: false,
        }),
      ),
      container,
    );

    expect(
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Preview update",
      )?.disabled,
    ).toBe(false);
    expect(
      (container.querySelector(".claws-plan__actions .btn.primary") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  it("renders inventory, provenance, and lifecycle health", () => {
    const container = document.createElement("div");
    render(renderClaws(props()), container);

    expect(container.querySelector(".claws-inventory__name")?.textContent).toBe(
      "financial-analyst",
    );
    expect(container.querySelector(".claws-resource__id")?.textContent).toContain(
      "@openclaw/markets@2.0.0",
    );
    expect(container.textContent).toContain("Referenced");
    expect(container.textContent).toContain("Pre-existing");
    expect(container.textContent).toContain("Healthy");
  });

  it("does not render lifecycle state when the method is unavailable", () => {
    const container = document.createElement("div");
    render(renderClaws(props({ available: false })), container);

    expect(container.textContent).toContain("not enabled");
    expect(container.textContent).not.toContain("financial-analyst");
  });

  it("renders catalog contents and previews an update for an installed Claw", () => {
    const onPreviewUpdate = vi.fn();
    const container = document.createElement("div");
    render(
      renderClaws(
        props({
          mode: "discover",
          catalogDetail,
          installedCatalogAgents: [status.records[0]!],
          onPreviewUpdate,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Financial Analyst");
    expect(container.textContent).toContain("Scheduled work");
    (container.querySelector(".claws-catalog-detail .btn.primary") as HTMLButtonElement).click();
    expect(onPreviewUpdate).toHaveBeenCalledWith(status.records[0], catalogDetail);
  });

  it("does not guess an update target when a package has multiple installed agents", () => {
    const container = document.createElement("div");
    render(
      renderClaws(
        props({
          mode: "discover",
          catalogDetail,
          installedCatalogAgents: [
            status.records[0]!,
            { ...status.records[0]!, agentId: "analyst-two" },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Multiple agents");
    expect(container.querySelector(".claws-catalog-detail .btn.primary")).toBeNull();
  });

  it("requires trust acknowledgement before confirming an unblocked plan", () => {
    const onApplyPlan = vi.fn();
    const container = document.createElement("div");
    render(renderClaws(props({ plan, onApplyPlan })), container);

    const confirm = container.querySelector(
      ".claws-plan__actions .btn.primary",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(container.textContent).toContain("Capabilities requiring consent");

    render(renderClaws(props({ plan, riskAcknowledged: true, onApplyPlan })), container);
    const enabledConfirm = container.querySelector(
      ".claws-plan__actions .btn.primary",
    ) as HTMLButtonElement;
    expect(enabledConfirm.disabled).toBe(false);
    enabledConfirm.click();
    expect(onApplyPlan).toHaveBeenCalledOnce();
  });

  it("never enables confirmation while the canonical plan has blockers", () => {
    const container = document.createElement("div");
    render(
      renderClaws(
        props({
          plan: {
            ...plan,
            blockers: [{ code: "workspace_conflict", path: "workspace", message: "Resolve it." }],
          },
          riskAcknowledged: true,
        }),
      ),
      container,
    );

    expect(
      (container.querySelector(".claws-plan__actions .btn.primary") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(container.textContent).toContain("workspace_conflict");
  });

  it("renders bounded setup controls and requires a fresh review after edits", () => {
    const onAnswerChange = vi.fn();
    const onReviewPersonalization = vi.fn();
    const container = document.createElement("div");
    render(
      renderClaws(
        props({
          plan: {
            ...plan,
            operation: "add",
            riskAcknowledgementRequired: false,
            setup: {
              valid: false,
              inputs: [
                { id: "name", label: "Name", type: "string", maxLength: 80, required: true },
                { id: "bio", label: "Bio", type: "multiline", maxLength: 500 },
                { id: "count", label: "Count", type: "integer", minimum: 1, maximum: 10 },
                { id: "enabled", label: "Enabled", type: "boolean" },
                {
                  id: "tone",
                  label: "Tone",
                  type: "choice",
                  options: [{ value: "brief", label: "Brief" }],
                },
                {
                  id: "topics",
                  label: "Topics",
                  type: "multiChoice",
                  options: [{ value: "markets", label: "Markets" }],
                },
              ],
              providedInputIds: [],
              defaultedInputIds: [],
              missingOptionalInputIds: ["bio", "count", "enabled", "tone", "topics"],
              seeds: [],
              diagnostics: [
                {
                  code: "setup_answer_required",
                  path: "$.answers.name",
                  message: "Provide a valid personalization value before continuing.",
                },
              ],
            },
          },
          planStale: true,
          onAnswerChange,
          onReviewPersonalization,
        }),
      ),
      container,
    );

    expect(container.querySelectorAll(".claws-stages__item")).toHaveLength(6);
    expect(container.querySelector('input[type="text"]')).not.toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector('input[type="number"]')).not.toBeNull();
    expect(container.querySelector("select")).not.toBeNull();
    expect(
      (container.querySelector(".claws-plan__actions .btn.primary") as HTMLButtonElement).disabled,
    ).toBe(true);
    (container.querySelector(".claws-setup > .btn.primary") as HTMLButtonElement).click();
    expect(onReviewPersonalization).toHaveBeenCalledOnce();
  });

  it("offers an explicit clear action for optional configured answers", () => {
    const onAnswerChange = vi.fn();
    const container = document.createElement("div");
    render(
      renderClaws(
        props({
          plan: {
            ...plan,
            operation: "configure",
            riskAcknowledgementRequired: false,
            setup: {
              valid: true,
              inputs: [{ id: "enabled", label: "Enabled", type: "boolean" }],
              providedInputIds: ["enabled"],
              defaultedInputIds: [],
              missingOptionalInputIds: [],
              seeds: [],
              diagnostics: [],
            },
          },
          answers: {},
          onAnswerChange,
        }),
      ),
      container,
    );

    const clear = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear stored answer"]',
    );
    expect(clear).not.toBeNull();
    clear!.click();
    expect(onAnswerChange).toHaveBeenCalledWith("enabled", undefined);
  });
});
