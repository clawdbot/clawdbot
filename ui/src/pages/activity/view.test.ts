/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderCurrentWork } from "./current-work-view.ts";
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
    basePath: "/control",
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

  it("keeps raw global status visible without linking to another session outside global scope", async () => {
    await i18n.setLocale("en");
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderCurrentWork({
        basePath: "/control",
        fallbackAgentId: "main",
        mainKey: "main",
        globalScope: false,
        navigate: vi.fn(),
        connected: true,
        loading: false,
        incomplete: false,
        onRetry: vi.fn(),
        result: {
          ts: 1,
          path: "",
          count: 2,
          defaults: { model: null, modelProvider: null, contextTokens: null },
          sessions: [
            {
              key: "global",
              agentId: "work",
              sessionId: "raw-global",
              kind: "global",
              label: "Existing global work",
              hasActiveRun: true,
            },
            {
              key: "agent:work:global",
              agentId: "work",
              sessionId: "literal-global",
              kind: "direct",
              hasActiveRun: true,
            },
          ],
        },
      }),
      container,
    );
    const raw = container.querySelector('[data-session-key="global"]');
    expect(raw?.textContent).toContain("Existing global work");
    expect(raw?.tagName).toBe("DIV");
    expect(raw?.hasAttribute("href")).toBe(false);
    expect(
      container.querySelector('a[data-session-key="agent:work:global"]')?.getAttribute("href"),
    ).toBe("/control/chat/work/~key/global");
  });

  it.each([false, true])(
    "distinguishes an incomplete empty snapshot from a normal empty refresh (incomplete: %s)",
    async (incomplete) => {
      await i18n.setLocale("en");
      const container = document.createElement("div");
      document.body.append(container);
      render(
        renderCurrentWork({
          basePath: "/control",
          fallbackAgentId: "main",
          mainKey: "main",
          globalScope: false,
          navigate: vi.fn(),
          connected: true,
          loading: true,
          incomplete,
          onRetry: vi.fn(),
          result: {
            ts: 1,
            path: "",
            count: 0,
            defaults: { model: null, modelProvider: null, contextTokens: null },
            sessions: [],
          },
        }),
        container,
      );
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        incomplete ? "Loading active sessions…" : "No active sessions.",
      );
      expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
    },
  );

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

  it("keeps primary live filters visible and moves the tool picker into the filter disclosure", async () => {
    await i18n.setLocale("en");
    const container = document.createElement("div");
    document.body.append(container);
    const onFilterTextChange = vi.fn();
    const onToolFilterChange = vi.fn();

    render(
      renderActivity(
        createProps({
          entries: [
            createEntry({ toolName: "exec" }),
            createEntry({ id: "run-2", toolName: "read" }),
          ],
          onFilterTextChange,
          onToolFilterChange,
        }),
      ),
      container,
    );

    const toolbar = container.querySelector(".activity-live-toolbar");
    expect(
      toolbar?.querySelectorAll('.activity-status-filter input[type="checkbox"]'),
    ).toHaveLength(3);
    expect(toolbar?.querySelector(".activity-live-autofollow wa-switch")).not.toBeNull();
    const filterTrigger = toolbar?.querySelector("#activity-live-filter-trigger");
    expect(filterTrigger?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(filterTrigger?.getAttribute("aria-expanded")).toBe("false");

    const search = toolbar?.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) {
      throw new Error("Expected the live activity search input");
    }
    search.value = "run";
    search.dispatchEvent(new Event("input"));
    expect(onFilterTextChange).toHaveBeenCalledWith("run");

    const tool = container.querySelector<HTMLSelectElement>(".activity-live-filter-popover select");
    if (!tool) {
      throw new Error("Expected the live activity tool filter");
    }
    tool.value = "read";
    tool.dispatchEvent(new Event("change"));
    expect(onToolFilterChange).toHaveBeenCalledWith("read");
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

  it("links the displayed run id to the deep-link inspector", async () => {
    await i18n.setLocale("en");
    const container = document.createElement("div");
    document.body.append(container);

    render(
      renderActivity(createProps({ entries: [createEntry({ runId: "live run:a/b" })] })),
      container,
    );

    expect(
      container.querySelector<HTMLAnchorElement>(".activity-entry__run-link")?.getAttribute("href"),
    ).toBe("/control/activity?view=run&run=live%20run%3Aa%2Fb");
  });
});
