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

function renderBadges(
  placementState?: SessionPlacementState,
  workspaceConflictCount?: number,
  diskSpaceStatus?: "ok" | "warning" | "critical",
) {
  render(
    renderSessionRowBadges({
      placementState,
      workspaceConflictCount,
      diskSpaceStatus,
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
  it("names the service and profile without losing conflict or disk attention", () => {
    render(
      renderSessionRowBadges({
        placementState: "active",
        placementProviderId: "machine0",
        placementProfileId: "team",
        workspaceConflictCount: 2,
        diskSpaceStatus: "warning",
      }),
      container,
    );
    const label =
      "machine0 · team · active · 2 workspace conflicts · Cloud session disk space is low";
    const badge = container.querySelector(".session-row-badge--cloud");
    expect(badge?.getAttribute("aria-label")).toBe(label);
    expectTooltipText(badge, label);
  });

  it("renders the incognito indicator", () => {
    render(
      renderSessionRowBadges({
        incognito: true,
      }),
      container,
    );

    const badge = container.querySelector(".session-row-badge--incognito");
    expect(badge?.getAttribute("aria-label")).toBe("Incognito session");
    expectTooltipText(badge, "Incognito session");
  });

  it("renders outbox attention and stays quiet when empty", () => {
    render(
      renderSessionRowBadges({
        hasApproval: true,
        outboxAttentionCount: 3,
      }),
      container,
    );

    const badge = container.querySelector<HTMLElement>(".session-row-badge--attention");
    expect(badge?.getAttribute("aria-label")).toBe("3 messages need attention");
    expectTooltipText(badge, "3 messages need attention");
    expect(badge?.textContent).toContain("3");
    const attentionIcon = badge?.querySelector("svg");
    const approvalIcon = container.querySelector(".session-row-badge--approval svg");
    expect(attentionIcon?.isEqualNode(approvalIcon ?? null)).toBe(true);

    render(renderSessionRowBadges({ outboxAttentionCount: 1 }), container);
    expect(
      container.querySelector(".session-row-badge--attention")?.getAttribute("aria-label"),
    ).toBe("1 message needs attention");

    render(renderSessionRowBadges({ outboxAttentionCount: 0 }), container);
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
    expect(badge?.getAttribute("aria-label")).toBe(`Placement: ${placementState}`);
    expectTooltipText(badge, `Placement: ${placementState}`);
    expect(badge?.querySelector("circle")).not.toBeNull();
    expect(badge?.querySelector("rect")).toBeNull();
  });

  it("renders a green open-pull-request indicator", () => {
    render(
      renderSessionRowBadges({
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
      }),
      container,
    );

    const badge = container.querySelector(".session-row-badge--approval");
    expect(badge?.getAttribute("aria-label")).toBe("Approval needed");
    expectTooltipText(badge, "Approval needed");
    expect(badge?.querySelector("svg")).not.toBeNull();
  });

  it("keeps child placement badges hidden while showing PR and approval", () => {
    render(
      renderSessionRowBadges({
        isChild: true,
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
    expectTooltipText(badge, "Placement: active · 3 workspace conflicts");
    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);

    renderBadges("active", 1);
    expectTooltipText(
      container.querySelector(".session-row-badge--cloud"),
      "Placement: active · 1 workspace conflict",
    );
  });

  it.each([
    { status: "warning" as const, label: "Cloud session disk space is low" },
    { status: "critical" as const, label: "Cloud session disk space is critically low" },
  ])("uses the cloud badge's $status tone for background pressure", ({ status, label }) => {
    renderBadges("active", undefined, status);

    const badge = container.querySelector<HTMLElement>(".session-row-badge--cloud");
    expect(badge?.dataset.diskSpaceStatus).toBe(status);
    expectTooltipText(badge, `Placement: active · ${label}`);
    expect(container.querySelectorAll(".session-row-badge--cloud")).toHaveLength(1);
  });

  it("keeps retained workspace conflicts visible after reclaim", () => {
    renderBadges("reclaimed", 2);

    const badge = container.querySelector<HTMLElement>(".session-row-badge--cloud");
    expect(badge?.dataset.placementState).toBe("reclaimed");
    expect(badge?.dataset.workspaceConflicts).toBe("2");
    expectTooltipText(badge, "Placement: reclaimed · 2 workspace conflicts");
  });

  it("renders descendant conflict attention without claiming a parent placement state", () => {
    renderBadges(undefined, 2);

    const badge = container.querySelector<HTMLElement>(".session-row-badge--cloud");
    expect(badge?.dataset.placementState).toBeUndefined();
    expect(badge?.dataset.workspaceConflicts).toBe("2");
    expectTooltipText(badge, "Cloud worker children: 2 workspace conflicts");
  });
});
