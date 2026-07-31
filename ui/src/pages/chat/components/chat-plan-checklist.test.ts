/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { PlanStatus } from "../tool-stream.ts";
import { renderChatPlanChecklist } from "./chat-plan-checklist.ts";

const planStatus: PlanStatus = {
  explanation: "Keep the change focused",
  steps: [
    { step: "Inspect the route", status: "completed" },
    { step: "Wire the checklist", status: "in_progress" },
    { step: "Run focused tests", status: "pending" },
  ],
};

function renderChecklist(status: PlanStatus | null, active: boolean) {
  const container = document.createElement("div");
  render(renderChatPlanChecklist(status, { active, variant: "card" }), container);
  return container;
}

describe("renderChatPlanChecklist", () => {
  it("renders the full card plan with explanation and step statuses", () => {
    const container = renderChecklist(planStatus, true);
    const card = container.querySelector(".plan-checklist--card");

    expect(card).not.toBeNull();
    expect(card).not.toBeInstanceOf(HTMLDetailsElement);
    expect(card?.querySelector(".plan-checklist__current")?.textContent).toBe("Wire the checklist");
    expect(card?.querySelector(".plan-checklist__count")?.textContent).toBe("1/3");
    expect(card?.querySelector(".plan-checklist__explanation")?.textContent).toBe(
      "Keep the change focused",
    );
    expect(
      [...(card?.querySelectorAll(".plan-checklist__step") ?? [])].map((step) => ({
        label: step.getAttribute("aria-label"),
        status: [...step.classList].find((name) => name.startsWith("plan-checklist__step--")),
      })),
    ).toEqual([
      { label: "Inspect the route, completed", status: "plan-checklist__step--completed" },
      { label: "Wire the checklist, in progress", status: "plan-checklist__step--in_progress" },
      { label: "Run focused tests, pending", status: "plan-checklist__step--pending" },
    ]);
  });

  it("hides the checklist without a plan or active run", () => {
    expect(renderChecklist(null, true).querySelector(".plan-checklist")).toBeNull();
    expect(renderChecklist(planStatus, false).querySelector(".plan-checklist")).toBeNull();
  });
});
