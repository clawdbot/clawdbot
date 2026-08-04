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
  isNew: false,
};

function propsFor(mode: SkillWorkshopMode): SkillWorkshopProps {
  return {
    loading: false,
    error: null,
    inspectingKey: null,
    proposals: [proposal],
    selectedKey: proposal.key,
    statusFilter: "pending",
    query: "",
    filePreviewKey: null,
    filePreviewQuery: "",
    queueWidth: 360,
    mode,
    actionBusy: null,
    actionNotice: null,
    revisionKey: null,
    revisionDraft: "",
    assistantName: "OpenClaw",
    workshopAgentName: "Research",
    selfLearning: null,
    historyScan: createSkillWorkshopHistoryScanState(),
    counts: { all: 1, pending: 1, applied: 0, rejected: 0, quarantined: 0, stale: 0 },
    onStatusFilterChange: vi.fn(),
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
  it.each(["board", "today"] as const)(
    "renders attributed completed, error, and block results with an Evaluate command in %s",
    async (mode) => {
      const container = document.createElement("div");
      const props = propsFor(mode);
      if (mode === "today") {
        container.style.width = "390px";
      }
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
        if (mode === "today") {
          expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
        }
      } finally {
        render(nothing, container);
        container.remove();
      }
    },
  );
});
