/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSessionProgressCard } from "./session-progress-card.ts";

const NOW_MS = Date.UTC(2026, 7, 26, 13, 37);
const RUN_STARTED_MS = NOW_MS - 3 * 60_000;
const RUN_ENDED_MS = NOW_MS - 30_000;

const progressCard: ProgressCard = {
  sessionKey: "agent:main:work",
  revision: 2,
  updatedAt: NOW_MS - 2 * 60_000,
  markdown: '**Focused change**\n\n<progress value="1" max="3"></progress>',
  steps: [
    { step: "Inspect the route", status: "completed" },
    { step: "Wire the checklist", status: "in_progress" },
    { step: "Run focused tests", status: "pending" },
  ],
};

describe("renderSessionProgressCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["board", "composer", "hovercard"] as const)(
    "shows relative activity for %s cards with and without checklist steps",
    (placement) => {
      const container = document.createElement("div");

      for (const steps of [progressCard.steps, undefined]) {
        render(renderSessionProgressCard({ ...progressCard, steps }, placement), container);

        const timestamp = container.querySelector(".session-progress-card time");
        expect(timestamp?.getAttribute("datetime")).toBe(
          new Date(progressCard.updatedAt).toISOString(),
        );
        expect(timestamp?.textContent).toBe(placement === "hovercard" ? "2m" : "Updated 2m ago");
        expect(timestamp?.getAttribute("aria-label")).toBe("Updated 2m ago");
        expect(timestamp?.getAttribute("title")).toBe(timestamp?.getAttribute("aria-label"));
        const accessibleCard =
          placement === "composer"
            ? timestamp?.closest("summary")
            : timestamp?.closest(".session-progress-card");
        expect(accessibleCard?.getAttribute("aria-label")).not.toContain("Updated");
      }
    },
  );

  it.each([
    [undefined, "Updated 2m ago"],
    ["queued", "Updated 2m ago"],
    ["running", "Updated 2m ago"],
    ["done", "Updated 2m ago"],
    ["failed", "Updated 2m ago"],
    ["timeout", "Updated 2m ago"],
    ["killed", "Updated 2m ago"],
  ] as const)("maps canonical session status %s to %s", (status, expected) => {
    const container = document.createElement("div");

    render(renderSessionProgressCard(progressCard, "composer", undefined, status), container);

    expect(container.querySelector("time")?.textContent).toBe(expected);
  });

  it("uses endedAt for terminal wording and falls back to Updated without it", () => {
    const container = document.createElement("div");
    render(
      renderSessionProgressCard(
        progressCard,
        "composer",
        undefined,
        "done",
        RUN_STARTED_MS,
        RUN_ENDED_MS,
      ),
      container,
    );
    expect(container.querySelector("time")?.textContent).toBe("Completed just now");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(RUN_ENDED_MS).toISOString(),
    );

    render(renderSessionProgressCard(progressCard, "composer", undefined, "done"), container);
    expect(container.querySelector("time")?.textContent).toBe("Updated 2m ago");
  });

  it("refreshes relative time while connected and stops after disconnect", () => {
    const container = document.createElement("div");
    const part = render(
      renderSessionProgressCard({ ...progressCard, updatedAt: NOW_MS - 10_000 }, "composer"),
      container,
    );
    expect(container.querySelector("time")?.textContent).toBe("Updated just now");

    vi.advanceTimersByTime(60_000);
    expect(container.querySelector("time")?.textContent).toBe("Updated 1m ago");

    part.setConnected(false);
    vi.advanceTimersByTime(60_000);
    expect(container.querySelector("time")?.textContent).toBe("Updated 1m ago");

    render(null, container);
  });

  it("labels activity from the last minute as just now", () => {
    const container = document.createElement("div");

    render(
      renderSessionProgressCard(
        { ...progressCard, updatedAt: NOW_MS - 10_000 },
        "composer",
        undefined,
        "running",
      ),
      container,
    );

    expect(container.querySelector("time")?.textContent).toBe("Updated just now");
  });

  it("renders sanitized markdown and one accessible typed checklist", () => {
    const container = document.createElement("div");
    render(renderSessionProgressCard(progressCard, "hovercard"), container);

    const card = container.querySelector(".session-progress-card");
    expect(card?.getAttribute("aria-label")).toBe("1 of 3 completed");
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

  it("presents durable in-progress work as paused without an active run", () => {
    const container = document.createElement("div");
    render(
      renderSessionProgressCard(
        progressCard,
        "composer",
        undefined,
        undefined,
        undefined,
        undefined,
        false,
      ),
      container,
    );

    expect(container.querySelector(".session-run-spinner")).toBeNull();
    expect(
      container.querySelector('.session-progress-card__current-marker[data-status="paused"]'),
    ).not.toBeNull();
    const pausedStep = container.querySelector(".session-progress-card__step--paused");
    expect(pausedStep?.getAttribute("aria-label")).toBe("Wire the checklist, paused");
    expect(pausedStep?.querySelector("polyline")).not.toBeNull();
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

  it("opens active composer progress as a native disclosure without a progress bar", () => {
    const container = document.createElement("div");
    render(
      renderSessionProgressCard(
        { ...progressCard, markdown: "Working through the task." },
        "composer",
      ),
      container,
    );

    const card = container.querySelector<HTMLDetailsElement>(
      '[data-progress-card-placement="composer"]',
    );
    expect(card?.open).toBe(true);
    expect(card?.dataset.complete).toBe("false");
    expect(card?.querySelector("summary")?.getAttribute("aria-label")).toBe(
      "Wire the checklist. 1 of 3 completed",
    );
    expect(card?.querySelector("[role=region]")?.getAttribute("aria-label")).toBe(
      "1 of 3 completed",
    );
    expect(card?.querySelector("summary")?.textContent).toContain("Task progress");
    expect(
      card
        ?.querySelector(".session-progress-card__heading-actions")
        ?.textContent?.replaceAll(/\s+/gu, " ")
        .trim(),
    ).toBe("Updated 2m ago · 2 of 3");
    expect(card?.querySelector("progress")).toBeNull();
    expect(card?.querySelectorAll(".session-progress-card__step")).toHaveLength(3);
  });

  it("collapses active composer progress when requested and preserves manual expansion", () => {
    const container = document.createElement("div");
    render(
      renderSessionProgressCard(
        progressCard,
        "composer",
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
      container,
    );

    const card = container.querySelector<HTMLDetailsElement>(
      '[data-progress-card-placement="composer"]',
    );
    expect(card?.open).toBe(false);
    card!.open = true;

    render(
      renderSessionProgressCard(
        { ...progressCard, revision: progressCard.revision + 1 },
        "composer",
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
      container,
    );
    expect(card?.open).toBe(true);
  });

  it("keeps the collapsed counter in the summary action column", () => {
    const container = document.createElement("div");
    render(renderSessionProgressCard(progressCard, "composer"), container);

    const summary = container.querySelector(".session-progress-card__summary");
    const count = summary?.querySelector(".session-progress-card__summary-count--collapsed");
    expect(count?.textContent?.trim()).toBe("2/3");
    expect(count?.parentElement).toBe(summary);
    expect(count?.previousElementSibling?.classList).toContain(
      "session-progress-card__summary-collapsed",
    );
    expect(count?.nextElementSibling?.classList).toContain(
      "session-progress-card__summary-expanded",
    );
  });

  it.each([
    ["running", "2/3"],
    ["done", "Completed"],
    ["failed", "Failed"],
    ["timeout", "Failed"],
    ["killed", "Stopped"],
  ] as const)("shows %s as %s in the closed summary", (status, expected) => {
    const container = document.createElement("div");
    render(
      renderSessionProgressCard(
        progressCard,
        "composer",
        undefined,
        status,
        RUN_STARTED_MS,
        RUN_ENDED_MS,
      ),
      container,
    );

    expect(
      container.querySelector(".session-progress-card__summary-count--collapsed")?.textContent,
    ).toBe(expected);
  });

  it("uses a terminal circle-x instead of pausing after the run stops", () => {
    const container = document.createElement("div");
    render(
      renderSessionProgressCard(
        progressCard,
        "composer",
        undefined,
        "killed",
        RUN_STARTED_MS,
        RUN_ENDED_MS,
        false,
      ),
      container,
    );

    const indicator = container.querySelector(".session-progress-card__summary-indicator");
    expect(container.querySelector(".session-run-spinner")).toBeNull();
    expect(indicator?.querySelector('circle[cx="12"][cy="12"][r="10"]')).not.toBeNull();
    expect(indicator?.querySelector('path[d="m15 9-6 6"]')).not.toBeNull();
    expect(indicator?.querySelector('path[d="m9 9 6 6"]')).not.toBeNull();
    expect(
      container.querySelector('.session-progress-card__step-marker[data-outcome="killed"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('.session-progress-card__step[aria-label$=", stopped"]'),
    ).not.toBeNull();
    expect(container.querySelector("summary")?.getAttribute("aria-label")).toBe(
      "Wire the checklist. Stopped",
    );
  });

  it("does not apply a later run outcome to an older progress card", () => {
    const container = document.createElement("div");
    render(
      renderSessionProgressCard(
        { ...progressCard, updatedAt: RUN_STARTED_MS - 1 },
        "composer",
        undefined,
        "failed",
        RUN_STARTED_MS,
        RUN_ENDED_MS,
      ),
      container,
    );

    expect(container.querySelector("time")?.textContent).toBe("Updated 3m ago");
    expect(container.querySelector("[data-outcome=failed]")).toBeNull();
    expect(container.querySelector(".session-run-spinner")).not.toBeNull();
  });

  it("falls back safely for timestamps outside the Date range", () => {
    const container = document.createElement("div");
    render(
      renderSessionProgressCard(
        { ...progressCard, updatedAt: MAX_DATE_TIMESTAMP_MS + 1 },
        "composer",
        undefined,
        "failed",
        RUN_STARTED_MS,
        MAX_DATE_TIMESTAMP_MS + 1,
      ),
      container,
    );

    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(NOW_MS).toISOString(),
    );
    expect(container.querySelector("[data-outcome=failed]")).toBeNull();
  });

  it("starts completed composer progress collapsed", () => {
    const container = document.createElement("div");
    render(
      renderSessionProgressCard(
        {
          ...progressCard,
          steps: progressCard.steps?.map((step) =>
            Object.assign({}, step, { status: "completed" as const }),
          ),
        },
        "composer",
      ),
      container,
    );

    const card = container.querySelector<HTMLDetailsElement>(
      '[data-progress-card-placement="composer"]',
    );
    expect(card?.open).toBe(false);
    expect(card?.dataset.complete).toBe("true");
  });

  it("preserves the operator disclosure choice across progress updates", () => {
    const container = document.createElement("div");
    render(renderSessionProgressCard(progressCard, "composer"), container);
    const card = container.querySelector<HTMLDetailsElement>(
      '[data-progress-card-placement="composer"]',
    );
    expect(card?.open).toBe(true);
    card!.open = false;

    render(
      renderSessionProgressCard(
        {
          ...progressCard,
          revision: progressCard.revision + 1,
          steps: progressCard.steps?.map((step, index) =>
            index === 1 ? { ...step, step: "Wire the updated checklist" } : step,
          ),
        },
        "composer",
      ),
      container,
    );

    expect(
      container.querySelector<HTMLDetailsElement>('[data-progress-card-placement="composer"]')
        ?.open,
    ).toBe(false);
  });

  it("uses the default disclosure state for a different session", () => {
    const container = document.createElement("div");
    render(renderSessionProgressCard(progressCard, "composer"), container);
    const first = container.querySelector<HTMLDetailsElement>(
      '[data-progress-card-placement="composer"]',
    );
    first!.open = false;

    render(
      renderSessionProgressCard({ ...progressCard, sessionKey: "agent:main:next" }, "composer"),
      container,
    );

    expect(
      container.querySelector<HTMLDetailsElement>('[data-progress-card-placement="composer"]')
        ?.open,
    ).toBe(true);
  });
});
