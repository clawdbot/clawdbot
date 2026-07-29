/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { renderSessionRowBadges, type SessionPlacementState } from "./session-row-badges.ts";
import "./tooltip.ts";

let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
});

function renderBadges(placementState?: SessionPlacementState, workspaceConflictCount?: number) {
  render(
    renderSessionRowBadges({
      hasAutomation: false,
      placementState,
      workspaceConflictCount,
    }),
    container,
  );
}

function expectTooltipText(badge: Element | null | undefined, text: string) {
  expect(badge?.hasAttribute("title")).toBe(false);
  expect(
    (badge?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)?.content,
  ).toBe(text);
}

describe("session row placement badges", () => {
  it("renders the incognito indicator", () => {
    render(
      renderSessionRowBadges({
        hasAutomation: false,
        incognito: true,
      }),
      container,
    );

    const badge = container.querySelector(".session-row-badge--incognito");
    expect(badge?.getAttribute("aria-label")).toBe("Incognito thread");
    expectTooltipText(badge, "Incognito thread");
  });

  it("renders the durable outbox count and stays quiet when empty", () => {
    render(
      renderSessionRowBadges({
        hasAutomation: false,
        outboxCount: 3,
      }),
      container,
    );

    const badge = container.querySelector<HTMLElement>(".session-row-badge--queued");
    expect(badge?.getAttribute("aria-label")).toBe("3 messages queued to send");
    expectTooltipText(badge, "3 messages queued to send");
    expect(badge?.textContent).toContain("3");
    expect(badge?.querySelector("svg")).not.toBeNull();

    render(renderSessionRowBadges({ hasAutomation: false, outboxCount: 0 }), container);
    expect(container.querySelector(".session-row-badges")).toBeNull();
  });

  it.each(["local", "reclaimed"] satisfies SessionPlacementState[])(
    "keeps %s placement visually quiet",
    (placementState) => {
      renderBadges(placementState);

      expect(container.querySelector(".session-row-badges")).toBeNull();
    },
  );

  it.each([
    "requested",
    "provisioning",
    "syncing",
    "starting",
    "active",
    "draining",
    "reconciling",
    "failed",
  ] satisfies SessionPlacementState[])("renders %s as a cloud-worker globe", (placementState) => {
    renderBadges(placementState);

    const badge = container.querySelector<HTMLElement>(".session-row-badge--cloud");
    expect(badge?.dataset.placementState).toBe(placementState);
    expect(badge?.getAttribute("aria-label")).toBe(`Cloud worker: ${placementState}`);
    expectTooltipText(badge, `Cloud worker: ${placementState}`);
    expect(badge?.querySelector("circle")).not.toBeNull();
    expect(badge?.querySelector("rect")).toBeNull();
  });

  it("keeps unrelated badges while omitting local placement", () => {
    render(
      renderSessionRowBadges({
        hasAutomation: true,
        placementState: "local",
      }),
      container,
    );

    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);
    expectTooltipText(container.querySelector(".session-row-badge"), "Automation attached");
    expect(container.querySelector(".session-row-badge--cloud")).toBeNull();
  });

  it("renders a green open-pull-request indicator", () => {
    render(
      renderSessionRowBadges({
        hasAutomation: false,
        pullRequest: { numbers: [111532], state: "open" },
      }),
      container,
    );

    const badge = container.querySelector(".session-row-badge--pull-request");
    expect(badge?.getAttribute("aria-label")).toBe("#111532 · Open");
    expectTooltipText(badge, "#111532 · Open");
    expect(badge?.getAttribute("data-pull-request-state")).toBe("open");
    expect(badge?.querySelector("svg")).not.toBeNull();
  });

  it.each([
    { state: "draft" as const, label: "#107302 · Draft" },
    { state: "merged" as const, label: "#111751, #111772 · Merged" },
  ])("renders catalog pull request metadata for $state threads", ({ state, label }) => {
    render(
      renderSessionRowBadges({
        hasAutomation: false,
        pullRequest: {
          numbers: state === "draft" ? [107302] : [111751, 111772],
          state,
        },
      }),
      container,
    );

    const badge = container.querySelector(".session-row-badge--pull-request");
    expect(badge?.getAttribute("aria-label")).toBe(label);
    expectTooltipText(badge, label);
    expect(badge?.getAttribute("data-pull-request-state")).toBe(state);
  });

  it("renders a warning-colored approval-needed indicator", () => {
    render(
      renderSessionRowBadges({
        hasApproval: true,
        hasAutomation: false,
      }),
      container,
    );

    const badge = container.querySelector(".session-row-badge--approval");
    expect(badge?.getAttribute("aria-label")).toBe("Approval needed");
    expectTooltipText(badge, "Approval needed");
    expect(badge?.querySelector("svg")).not.toBeNull();
  });

  it("keeps child-only automation and placement badges hidden while showing PR and approval", () => {
    render(
      renderSessionRowBadges({
        isChild: true,
        hasAutomation: true,
        pullRequest: { numbers: [111532], state: "open" },
        hasApproval: true,
        placementState: "active",
      }),
      container,
    );

    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(2);
    expect(container.querySelector(".session-row-badge--pull-request")).not.toBeNull();
    expect(container.querySelector(".session-row-badge--approval")).not.toBeNull();
    expect(container.querySelector(".session-row-badge--cloud")).toBeNull();
  });

  it("keeps conflict attention visible for child sessions", () => {
    render(
      renderSessionRowBadges({
        isChild: true,
        hasAutomation: false,
        placementState: "reclaimed",
        workspaceConflictCount: 2,
      }),
      container,
    );

    const badge = container.querySelector<HTMLElement>(".session-row-badge--cloud");
    expect(badge?.dataset.placementState).toBe("reclaimed");
    expect(badge?.dataset.workspaceConflicts).toBe("2");
    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);
  });

  it("uses the existing cloud badge to call out workspace conflicts", () => {
    renderBadges("active", 3);

    const badge = container.querySelector<HTMLElement>(".session-row-badge--cloud");
    expect(badge?.dataset.workspaceConflicts).toBe("3");
    expectTooltipText(badge, "Cloud worker: active · 3 workspace conflicts");
    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);

    renderBadges("active", 1);
    expectTooltipText(
      container.querySelector(".session-row-badge--cloud"),
      "Cloud worker: active · 1 workspace conflict",
    );
  });

  it("keeps retained workspace conflicts visible after reclaim", () => {
    renderBadges("reclaimed", 2);

    const badge = container.querySelector<HTMLElement>(".session-row-badge--cloud");
    expect(badge?.dataset.placementState).toBe("reclaimed");
    expect(badge?.dataset.workspaceConflicts).toBe("2");
    expectTooltipText(badge, "Cloud worker: reclaimed · 2 workspace conflicts");
  });

  it("renders descendant conflict attention without claiming a parent placement state", () => {
    renderBadges(undefined, 2);

    const badge = container.querySelector<HTMLElement>(".session-row-badge--cloud");
    expect(badge?.dataset.placementState).toBeUndefined();
    expect(badge?.dataset.workspaceConflicts).toBe("2");
    expectTooltipText(badge, "Cloud worker children: 2 workspace conflicts");
  });
});
