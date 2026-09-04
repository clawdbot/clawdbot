// Task-lanes panel render states: lanes present (sorted), empty, provider
// diagnostics (ok + error), and load failure.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { TaskLaneSnapshotPayload } from "../../../../packages/gateway-protocol/src/index.js";
import { renderTaskLanesPanel } from "./view-task-lanes.ts";

type PanelProps = Parameters<typeof renderTaskLanesPanel>[0];

function renderPanel(props: Partial<PanelProps> = {}) {
  const container = document.createElement("div");
  render(renderTaskLanesPanel({ taskLanes: null, taskLanesError: null, ...props }), container);
  return container;
}

function snapshot(overrides: Partial<TaskLaneSnapshotPayload> = {}): TaskLaneSnapshotPayload {
  return {
    lanes: [
      {
        id: "lane-b",
        label: "Lane B",
        items: [
          {
            id: "item-1",
            title: "older item",
            state: "succeeded",
            startedAtMs: 1_000,
            outcome: "ok",
          },
          {
            id: "item-2",
            title: "newer item",
            state: "failed",
            startedAtMs: 3_000,
            outcome: "boom",
            artifactUrl: "https://example.com/x",
          },
        ],
      },
      {
        id: "lane-a",
        label: "Lane A",
        items: [
          {
            id: "item-3",
            title: "running item",
            state: "running",
            startedAtMs: 2_000,
          },
        ],
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

describe("task lanes panel", () => {
  it("renders nothing before the first snapshot", () => {
    expect(renderPanel().innerHTML).not.toContain("cron-task-lanes");
  });

  it("renders lanes sorted by id with items newest first", () => {
    const container = renderPanel({ taskLanes: snapshot() });
    const labels = Array.from(container.querySelectorAll(".cron-task-lanes__lane-label")).map(
      (el) => el.textContent?.trim(),
    );
    expect(labels).toEqual(["Lane A", "Lane B"]);
    const titles = Array.from(container.querySelectorAll(".cron-task-lanes__item-title")).map(
      (el) => el.textContent?.trim(),
    );
    expect(titles).toEqual(["running item", "newer item", "older item"]);
  });

  it("renders outcome and artifact link as-is", () => {
    const container = renderPanel({ taskLanes: snapshot() });
    const link = container.querySelector<HTMLAnchorElement>(".cron-task-lanes__item-artifact");
    expect(link?.getAttribute("href")).toBe("https://example.com/x");
    const outcomes = Array.from(container.querySelectorAll(".cron-task-lanes__item-outcome")).map(
      (el) => el.textContent?.trim(),
    );
    expect(outcomes).toEqual(["boom", "ok"]);
  });

  it("renders per-provider diagnostic chips", () => {
    const container = renderPanel({
      taskLanes: snapshot({
        lanes: [],
        diagnostics: [
          { providerId: "cron", ok: true, laneCount: 2, itemCount: 5 },
          { providerId: "acme", ok: false, error: "provider offline" },
        ],
      }),
    });
    const chips = Array.from(container.querySelectorAll(".cron-task-lanes__chip")).map((el) =>
      el.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(chips[0]).toContain("acme");
    expect(chips[0]).toContain("provider offline");
    expect(chips[1]).toContain("cron");
    expect(chips[1]).toContain("2");
    expect(chips[1]).toContain("5");
  });

  it("marks an off-page lane as omitted instead of reading as an empty queue", () => {
    const container = renderPanel({
      taskLanes: snapshot({
        lanes: [
          { id: "quiet", label: "Quiet", items: [], totalItems: 1, omittedItems: 1 },
          {
            id: "busy",
            label: "Busy",
            items: [{ id: "b1", title: "b1", state: "running", startedAtMs: 5_000 }],
            totalItems: 1,
            omittedItems: 0,
          },
        ],
        paging: { offset: 0, limit: 50, totalItems: 2, returnedItems: 1 },
      }),
    });
    const counts = Array.from(container.querySelectorAll(".cron-task-lanes__lane-count")).map(
      (el) => el.textContent?.replace(/\s+/g, " ").trim(),
    );
    // A lane with items outside the page must never show a bare "0".
    expect(counts).toEqual(["1", "0 of 1"]);
    expect(
      container.querySelector(".cron-task-lanes__truncated")?.textContent?.replace(/\s+/g, " "),
    ).toContain("1 of 2");
  });

  it("renders the empty state when no lanes or diagnostics exist", () => {
    const container = renderPanel({ taskLanes: snapshot({ lanes: [], diagnostics: [] }) });
    expect(container.querySelector(".cron-task-lanes__empty")?.textContent).toBeTruthy();
    expect(container.querySelector(".cron-task-lanes__lane")).toBeNull();
  });

  it("renders a load failure as an alert", () => {
    const container = renderPanel({ taskLanesError: "gateway unavailable" });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("gateway unavailable");
  });
});
