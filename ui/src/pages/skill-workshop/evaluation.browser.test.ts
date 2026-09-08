import { nothing, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type {
  SkillWorkshopEvaluation,
  SkillWorkshopMode,
  SkillWorkshopProposal,
} from "../../lib/skill-workshop/index.ts";
import { createSkillWorkshopHistoryScanState } from "./state.ts";
import type { SkillWorkshopProps } from "./view-types.ts";
import { renderSkillWorkshop } from "./view.ts";

const DRAFT_HASH = "a".repeat(64);

const evaluation: SkillWorkshopEvaluation = {
  id: "evaluation-1",
  proposedVersion: "v3",
  revisionHash: DRAFT_HASH,
  trigger: "manual",
  startedAt: "2026-07-29T10:00:00.000Z",
  completedAt: "2026-07-29T10:00:01.000Z",
  outcomes: [
    {
      pluginId: "quality-plugin",
      pluginVersion: "1.2.3",
      evaluatorId: "quality",
      status: "completed",
      result: {
        summary: "Static checks found a release blocker.",
        findings: [
          {
            ruleId: "skill.rollback",
            severity: "critical",
            message: "Missing retry step.",
            file: "SKILL.md",
            line: 18,
          },
        ],
        metrics: { score: 0.42, deterministic: true },
        evaluatorVersion: "rules-v2",
        mode: "static",
        decision: "block",
        decisionReason: "Add rollback and retry guidance.",
      },
    },
    {
      pluginId: "runtime-plugin",
      evaluatorId: "sandbox",
      status: "error",
      error: "Plugin crashed while loading the fixture.",
    },
    {
      pluginId: "compat-plugin",
      evaluatorId: "compatibility",
      status: "skipped",
    },
    {
      pluginId: "policy-plugin",
      evaluatorId: "policy",
      status: "completed",
      result: { decision: "pass", decisionReason: "Policy checks passed." },
    },
    {
      pluginId: "clarity-plugin",
      evaluatorId: "clarity",
      status: "completed",
      result: { decision: "revise", decisionReason: "Clarify the activation trigger." },
    },
  ],
};

const proposal: SkillWorkshopProposal = {
  key: "proposal-1",
  kind: "update",
  slug: "inbox-cleaner",
  name: "Inbox Cleaner",
  oneLine: "Clean inbox triage",
  body: "## Workflow\n- Review unread mail.",
  status: "pending",
  version: 3,
  revisionHash: DRAFT_HASH,
  evaluation,
  createdAt: Date.parse("2026-07-29T09:00:00.000Z"),
  updatedAt: Date.parse("2026-07-29T10:00:00.000Z"),
  recencyGroup: "today",
  ageLabel: "now",
  supportFiles: [],
  bodyLoaded: true,
};

function propsFor(mode: SkillWorkshopMode): SkillWorkshopProps {
  return {
    access: {
      canEvaluate: true,
      canApply: true,
      canRevise: true,
      canReject: true,
      canScanHistory: true,
    },
    loading: false,
    error: null,
    inspectingKey: null,
    proposals: [proposal],
    installedSkills: [],
    installedSelection: { status: "idle" },
    onSelectInstalled: vi.fn(),
    onRetryInstalled: vi.fn(),
    selectedKey: proposal.key,
    query: "",
    filePreviewKey: null,
    filePreviewQuery: "",
    queueWidth: 360,
    mode,
    actionBusy: null,
    actionNotice: null,
    revisionKey: null,
    revisionDraft: "",
    revisionRecoveryActive: false,
    assistantName: "OpenClaw",
    workshopAgentName: "Research",
    selfLearning: null,
    historyScan: createSkillWorkshopHistoryScanState(),
    onRetry: vi.fn(),
    onQueryChange: vi.fn(),
    onFilePreviewQueryChange: vi.fn(),
    onQueueWidthChange: vi.fn(),
    onModeChange: vi.fn(),
    onSelect: vi.fn(),
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onApply: vi.fn(),
    onEvaluate: vi.fn(),
    onRevise: vi.fn(),
    onReject: vi.fn(),
    onRevisionDraftChange: vi.fn(),
    onRevisionCancel: vi.fn(),
    onRevisionSubmit: vi.fn(),
    onPreviewFile: vi.fn(),
    onClosePreview: vi.fn(),
    onSelfLearningToggle: vi.fn(),
    onHistoryScan: vi.fn(),
  };
}

describe("Skill Workshop evaluation results (browser)", () => {
  it.each([800, 390])("keeps embedded images within the suggestion card at %spx", async (width) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 20;
    const container = document.createElement("div");
    container.style.width = `${width}px`;
    const props = propsFor("suggestions");
    props.proposals = [{ ...proposal, body: `![Diagram](${canvas.toDataURL()})` }];
    document.body.append(container);
    try {
      render(renderSkillWorkshop(props), container);
      const image = container.querySelector<HTMLImageElement>(".sidebar-markdown img")!;
      await vi.waitFor(() => expect(image.complete).toBe(true));
      expect(image.naturalWidth).toBe(1600);
      const card = container.querySelector(".sw-body-card")!.getBoundingClientRect();
      expect(image.getBoundingClientRect().right).toBeLessThanOrEqual(card.right);
      expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
    } finally {
      render(nothing, container);
      container.remove();
    }
  });

  it.each([
    ["suggestions", "apply", ".sw-action-bar .sw-btn--primary", "onApply"],
    ["suggestions", "reject", ".sw-action-bar .sw-btn--danger", "onReject"],
  ] as const)(
    "captures the rendered revision when %s %s is chosen",
    async (mode, _action, selector, callbackName) => {
      const container = document.createElement("div");
      const props = propsFor(mode);
      document.body.append(container);

      try {
        render(renderSkillWorkshop(props), container);
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });

        const actionButton = container.querySelector<HTMLButtonElement>(selector);
        expect(actionButton).toBeInstanceOf(HTMLButtonElement);
        actionButton?.click();
        expect(props[callbackName]).toHaveBeenCalledWith({
          proposalId: "proposal-1",
          expectedRevisionHash: DRAFT_HASH,
        });
      } finally {
        render(nothing, container);
        container.remove();
      }
    },
  );

  it.each([800, 390])(
    "renders attributed evaluator results and an Evaluate command at %spx",
    async (width) => {
      const container = document.createElement("div");
      const props = propsFor("suggestions");
      container.style.width = `${width}px`;
      document.body.append(container);

      try {
        render(renderSkillWorkshop(props), container);
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });

        const evaluateButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent?.includes("Evaluate"),
        );
        expect(evaluateButton).toBeInstanceOf(HTMLButtonElement);
        evaluateButton?.click();
        expect(props.onEvaluate).toHaveBeenCalledWith("proposal-1");

        const text = container.textContent ?? "";
        expect(text).toContain("quality-plugin 1.2.3");
        expect(text).toContain("Completed");
        expect(text).toContain("Block");
        expect(text).toContain("Static checks found a release blocker.");
        expect(text).toContain("Add rollback and retry guidance.");
        expect(text).toContain("Missing retry step.");
        expect(text).toContain("skill.rollback");
        expect(text).toContain("SKILL.md:18");
        expect(text).toContain("score");
        expect(text).toContain("0.42");
        expect(text).toContain("rules-v2");
        expect(text).toContain("Error");
        expect(text).toContain("Plugin crashed while loading the fixture.");
        expect(text).toContain("Skipped");
        expect(text).toContain("Pass");
        expect(text).toContain("Policy checks passed.");
        expect(text).toContain("Revise");
        expect(text).toContain("Clarify the activation trigger.");
        expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
      } finally {
        render(nothing, container);
        container.remove();
      }
    },
  );
});
