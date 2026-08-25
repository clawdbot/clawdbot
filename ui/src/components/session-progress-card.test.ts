/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderSessionProgressCard } from "./session-progress-card.ts";

const progressCard: ProgressCard = {
  sessionKey: "agent:main:work",
  revision: 2,
  updatedAt: 1,
  markdown: '**Focused change**\n\n<progress value="1" max="3"></progress>',
  steps: [
    { step: "Inspect the route", status: "completed" },
    { step: "Wire the checklist", status: "in_progress" },
    { step: "Run focused tests", status: "pending" },
  ],
};

describe("renderSessionProgressCard", () => {
  it.each(["board", "composer", "dock", "hovercard", "rail"] as const)(
    "shows the last activity time for %s cards with and without checklist steps",
    (placement) => {
      const container = document.createElement("div");

      for (const steps of [progressCard.steps, undefined]) {
        render(renderSessionProgressCard({ ...progressCard, steps }, placement), container);

        const timestamp = container.querySelector(".session-progress-card time");
        expect(timestamp?.getAttribute("datetime")).toBe(
          new Date(progressCard.updatedAt).toISOString(),
        );
        expect(timestamp?.textContent).toMatch(/\d{1,2}:\d{2}:\d{2}/);
        expect(timestamp?.getAttribute("aria-label")).toMatch(/^Last activity: /);
        expect(timestamp?.getAttribute("title")).toBe(timestamp?.getAttribute("aria-label"));
        const accessibleCard =
          placement === "composer"
            ? timestamp?.closest("summary")
            : timestamp?.closest(".session-progress-card");
        expect(accessibleCard?.getAttribute("aria-label")).toContain(
          timestamp?.getAttribute("aria-label"),
        );
      }
    },
  );

  it("renders sanitized markdown and one accessible typed checklist", () => {
    const container = document.createElement("div");
    render(renderSessionProgressCard(progressCard, "rail"), container);

    const card = container.querySelector(".session-progress-card");
    expect(card?.getAttribute("aria-label")).toMatch(/^1 of 3 completed\. Last activity: /);
    expect(card?.querySelector("strong")?.textContent).toBe("Focused change");
    expect(card?.querySelector("progress")?.getAttribute("value")).toBe("1");
    expect(card?.querySelectorAll(".session-progress-card__count")).toHaveLength(0);
    expect(
      [...(card?.querySelectorAll(".session-progress-card__step") ?? [])].map((step) => ({
        label: step.getAttribute("aria-label"),
        marker: step.querySelector(".session-progress-card__step-marker")?.innerHTML,
        status: [...step.classList].find((name) =>
          name.startsWith("session-progress-card__step--"),
        ),
      })),
    ).toEqual([
      {
        label: "Inspect the route, completed",
        marker: expect.stringContaining("<path"),
        status: "session-progress-card__step--completed",
      },
      {
        label: "Wire the checklist, in progress",
        marker: expect.stringContaining("session-run-spinner"),
        status: "session-progress-card__step--in_progress",
      },
      {
        label: "Run focused tests, pending",
        marker: expect.stringContaining("<polyline"),
        status: "session-progress-card__step--pending",
      },
    ]);
    expect(
      card?.querySelector(
        ".session-progress-card__step--completed .session-progress-card__step-marker path",
      ),
    ).not.toBeNull();
    expect(
      card?.querySelector(
        ".session-progress-card__step--in_progress .session-progress-card__step-marker .session-run-spinner",
      ),
    ).not.toBeNull();
    expect(
      card?.querySelector(
        ".session-progress-card__step--pending .session-progress-card__step-marker polyline",
      ),
    ).not.toBeNull();
  });

  it.each([
    ["in_progress", ".session-run-spinner"],
    ["pending", "polyline"],
  ] as const)("uses the %s marker in the composer summary", (status, markerSelector) => {
    const container = document.createElement("div");
    const card = {
      ...progressCard,
      steps: [{ step: "Current step", status }],
    };
    render(renderSessionProgressCard(card, "composer"), container);

    expect(
      container.querySelector(
        `.session-progress-card__current-marker[data-status="${status}"] ${markerSelector}`,
      ),
    ).not.toBeNull();
  });

  it("keeps a disclosure affordance beside a completed dismissible composer card", () => {
    const container = document.createElement("div");
    const completed = {
      ...progressCard,
      steps: progressCard.steps?.map(({ step }) => ({ step, status: "completed" as const })),
    };
    render(
      renderSessionProgressCard(completed, "composer", () => undefined),
      container,
    );

    expect(container.querySelector(".session-progress-card__dismiss")).not.toBeNull();
    expect(container.querySelector(".session-progress-card__chevron svg")).not.toBeNull();
  });
});
