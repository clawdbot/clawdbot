/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { renderSessionRowBadges, type SessionPlacementState } from "./session-row-badges.ts";

let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
});

function renderBadges(placementState?: SessionPlacementState) {
  render(
    renderSessionRowBadges({
      hasAutomation: false,
      placementState,
    }),
    container,
  );
}

describe("session row placement badges", () => {
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
    expect(badge?.querySelector("circle")).not.toBeNull();
    expect(badge?.querySelector("rect")).toBeNull();
  });

  it("keeps unrelated badges while omitting local placement", () => {
    render(
      renderSessionRowBadges({
        hasAutomation: true,
        placementState: "local",
        worktreeId: "worktree-1",
      }),
      container,
    );

    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(2);
    expect(container.querySelector(".session-row-badge--cloud")).toBeNull();
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
    expect(badge?.querySelector("svg")).not.toBeNull();
  });

  it("keeps child-only worktree and placement badges hidden while showing approval", () => {
    render(
      renderSessionRowBadges({
        isChild: true,
        worktreeId: "worktree-1",
        hasAutomation: true,
        hasApproval: true,
        placementState: "active",
      }),
      container,
    );

    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);
    expect(container.querySelector(".session-row-badge--approval")).not.toBeNull();
    expect(container.querySelector(".session-row-badge--cloud")).toBeNull();
  });
});
