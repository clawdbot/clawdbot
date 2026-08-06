/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ActivityEntry, ActivityStatus } from "./tool-activity.ts";
import { renderActivity } from "./view.ts";

type ActivityProps = Parameters<typeof renderActivity>[0];

function createEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: "run-1:tool-1",
    toolCallId: "tool-1",
    runId: "run-1",
    sessionKey: "main",
    toolName: "exec",
    entryKind: "tool",
    status: "running",
    startedAt: 1_000,
    updatedAt: 120_900,
    durationMs: 119_900,
    outputPreview: "ok",
    outputTruncated: false,
    summary: "exec running; 0 arguments hidden",
    hiddenArgumentCount: 0,
    ...overrides,
  };
}

function createProps(overrides: Partial<ActivityProps> = {}): ActivityProps {
  const statusFilters: Record<ActivityStatus, boolean> = {
    running: true,
    done: true,
    error: true,
  };
  return {
    entries: [createEntry()],
    filterText: "",
    statusFilters,
    toolFilter: "",
    expandedIds: new Set<string>(),
    autoFollow: true,
    onFilterTextChange: vi.fn(),
    onToolFilterChange: vi.fn(),
    onStatusToggle: vi.fn(),
    onToggleAutoFollow: vi.fn(),
    onClear: vi.fn(),
    onExpandAll: vi.fn(),
    onCollapseAll: vi.fn(),
    onEntryToggle: vi.fn(),
    onScroll: vi.fn(),
    ...overrides,
  };
}

describe("renderActivity", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the summary from localized labels", async () => {
    await i18n.setLocale("de");
    const container = document.createElement("div");
    document.body.append(container);

    render(renderActivity(createProps()), container);

    expect(container.querySelector(".activity-entry__text")?.textContent?.trim()).toBe(
      "0 Argumente ausgeblendet",
    );
  });

  it("exposes the activity stream as a named list", async () => {
    await i18n.setLocale("en");
    const container = document.createElement("div");
    document.body.append(container);

    render(renderActivity(createProps()), container);

    const stream = container.querySelector(".activity-stream");
    expect(stream?.getAttribute("role")).toBe("list");
    expect(stream?.getAttribute("aria-label")).toBe("Agent activity entries");
    expect(container.querySelector(".activity-entry")?.getAttribute("role")).toBe("listitem");
  });

  it("renders selected answer candidates without tool-only facts", async () => {
    await i18n.setLocale("en");
    const container = document.createElement("div");
    document.body.append(container);

    render(
      renderActivity(
        createProps({
          entries: [
            createEntry({
              id: "run-1:answer_candidate:answer-1",
              entryKind: "answer_candidate",
              itemId: "answer-1",
              toolCallId: "answer-1",
              toolName: "answer_candidate",
              candidateStatus: "selected",
              status: "done",
              outputPreview: "Final answer",
            }),
          ],
        }),
      ),
      container,
    );

    expect(container.querySelector(".activity-entry__tool")?.textContent?.trim()).toBe(
      "Answer candidate",
    );
    expect(container.querySelector(".activity-entry__text")?.textContent?.trim()).toBe(
      "Selected answer",
    );
    expect(container.querySelector(".activity-entry__facts")?.textContent).toContain(
      "Item: answer-1",
    );
    expect(container.querySelector(".activity-entry__facts")?.textContent).not.toContain(
      "arguments hidden",
    );
  });

  it("lets the route shell own the page heading", async () => {
    await i18n.setLocale("en");
    const container = document.createElement("div");
    document.body.append(container);

    render(renderActivity(createProps()), container);

    expect(container.querySelector(".activity-page__title")).toBeNull();
    expect(container.querySelector(".activity-page__subtitle")).toBeNull();
    expect(container.querySelector(".activity-count")?.textContent?.trim()).toBe("1 of 1");
  });

  it("normalizes rounded minute durations that would otherwise show 60 seconds", async () => {
    await i18n.setLocale("en");
    const container = document.createElement("div");
    document.body.append(container);

    render(renderActivity(createProps()), container);

    const meta = Array.from(container.querySelectorAll(".activity-entry__meta span")).map(
      (element) => element.textContent?.trim(),
    );
    expect(meta).toContain("2m");
  });
});
