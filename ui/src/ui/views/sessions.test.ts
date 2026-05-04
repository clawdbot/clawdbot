/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../types.ts";
import { renderSessions, type SessionsProps } from "./sessions.ts";

function buildResult(session: SessionsListResult["sessions"][number]): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [session],
  };
}

function buildMultiResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function buildProps(result: SessionsListResult): SessionsProps {
  return {
    loading: false,
    result,
    error: null,
    activeMinutes: "",
    limit: "120",
    includeGlobal: false,
    includeUnknown: false,
    showArchived: false,
    filtersCollapsed: false,
    basePath: "",
    searchQuery: "",
    agentIdentityById: {},
    sortColumn: "updated",
    sortDir: "desc",
    page: 0,
    pageSize: 10,
    selectedKeys: new Set<string>(),
    expandedCheckpointKey: null,
    checkpointItemsByKey: {},
    checkpointLoadingKey: null,
    checkpointBusyKey: null,
    checkpointErrorByKey: {},
    onFiltersChange: () => undefined,
    onToggleFiltersCollapsed: () => undefined,
    onClearFilters: () => undefined,
    onSearchChange: () => undefined,
    onSortChange: () => undefined,
    onPageChange: () => undefined,
    onPageSizeChange: () => undefined,
    onRefresh: () => undefined,
    onPatch: () => undefined,
    onToggleSelect: () => undefined,
    onSelectPage: () => undefined,
    onDeselectPage: () => undefined,
    onDeselectAll: () => undefined,
    onDeleteSelected: () => undefined,
    onToggleCheckpointDetails: () => undefined,
    onBranchFromCheckpoint: () => undefined,
    onRestoreCheckpoint: () => undefined,
  };
}

describe("sessions view", () => {
  it("renders an explicit archived-session toggle", async () => {
    const container = document.createElement("div");
    const onFiltersChange = vi.fn();
    render(
      renderSessions({
        ...buildProps(buildMultiResult([])),
        onFiltersChange,
      }),
      container,
    );
    await Promise.resolve();

    const archivedToggle = container.querySelector(
      ".session-archive-toggle input",
    ) as HTMLInputElement | null;
    expect(archivedToggle?.checked).toBe(false);

    archivedToggle!.checked = true;
    archivedToggle!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onFiltersChange).toHaveBeenCalledWith({
      activeMinutes: "",
      limit: "120",
      includeGlobal: false,
      includeUnknown: false,
      showArchived: true,
    });
  });

  it("uses one short styled tooltip per session filter", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(buildMultiResult([])),
        activeMinutes: "120",
      }),
      container,
    );
    await Promise.resolve();

    const filters = container.querySelector(".sessions-filter-bar");
    const activeField = filters
      ?.querySelector<HTMLInputElement>(".session-filter-input--minutes")
      ?.closest("label");
    const limitField = filters
      ?.querySelector<HTMLInputElement>(".session-filter-input--limit")
      ?.closest("label");
    const globalToggle = filters
      ?.querySelector<HTMLInputElement>(".session-filter-check__input[name=includeGlobal]")
      ?.closest("label");
    const unknownToggle = filters
      ?.querySelector<HTMLInputElement>(".session-filter-check__input[name=includeUnknown]")
      ?.closest("label");
    const archivedToggle = filters
      ?.querySelector<HTMLInputElement>(".session-filter-check__input[name=showArchived]")
      ?.closest("label");

    expect(activeField?.getAttribute("data-tooltip")).toBe("Updated in the last 120 minutes.");
    expect(limitField?.getAttribute("data-tooltip")).toBe("Max sessions to load.");
    expect(globalToggle?.getAttribute("data-tooltip")).toBe("Include global sessions.");
    expect(unknownToggle?.getAttribute("data-tooltip")).toBe("Include unknown sessions.");
    expect(archivedToggle?.getAttribute("data-tooltip")).toBe("Include archived sessions.");
    expect(
      Array.from(filters?.querySelectorAll("[title]") ?? []).map((node) => node.className),
    ).toEqual([]);
  });

  it("keeps active and limit together and renders streamlined source toggles", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(buildMultiResult([])),
        activeMinutes: "120",
        limit: "200",
        includeGlobal: true,
      }),
      container,
    );
    await Promise.resolve();

    const primaryRow = container.querySelector(".session-filter-primary-row");
    expect(primaryRow?.querySelector(".session-filter-input--minutes")?.closest("label")).toBe(
      primaryRow?.firstElementChild,
    );
    expect(primaryRow?.querySelector(".session-filter-input--limit")?.closest("label")).toBe(
      primaryRow?.lastElementChild,
    );

    const toggleGroup = container.querySelector(".session-filter-toggle-group");
    expect(toggleGroup?.getAttribute("role")).toBe("group");
    expect(toggleGroup?.getAttribute("aria-label")).toBe("Session source filters");
    expect(toggleGroup?.querySelectorAll(".session-filter-check")).toHaveLength(3);
    expect(
      toggleGroup
        ?.querySelector<HTMLInputElement>(".session-filter-check__input[name=includeGlobal]")
        ?.closest("label")
        ?.classList.contains("session-filter-check--active"),
    ).toBe(true);
    expect(toggleGroup?.querySelector(".session-filter-check__box")).toBeNull();
  });

  it("collapses the whole session filter section from the header", async () => {
    const container = document.createElement("div");
    const onToggleFiltersCollapsed = vi.fn();
    render(
      renderSessions({
        ...buildProps(buildMultiResult([])),
        filtersCollapsed: true,
        onToggleFiltersCollapsed,
      }),
      container,
    );
    await Promise.resolve();

    const toggle = container.querySelector<HTMLButtonElement>(".sessions-filter-panel__toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".sessions-filter-bar")).toBeNull();

    toggle?.click();

    expect(onToggleFiltersCollapsed).toHaveBeenCalledTimes(1);
  });

  it("renders and patches provider-owned thinking ids", async () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            thinkingLevel: "adaptive",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "adaptive", label: "adaptive" },
              { id: "max", label: "maximum" },
            ],
          }),
        ),
        onPatch,
      }),
      container,
    );
    await Promise.resolve();

    const thinking = container.querySelector("tbody select") as HTMLSelectElement | null;
    expect(thinking?.value).toBe("adaptive");
    expect(Array.from(thinking?.options ?? []).map((option) => option.value)).toEqual([
      "",
      "off",
      "adaptive",
      "max",
    ]);
    expect(
      Array.from(thinking?.options ?? [])
        .find((option) => option.value === "max")
        ?.textContent?.trim(),
    ).toBe("maximum");

    thinking!.value = "max";
    thinking!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onPatch).toHaveBeenCalledWith("agent:main:main", { thinkingLevel: "max" });
  });

  it("labels inherited thinking with the resolved session default", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            thinkingDefault: "adaptive",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "adaptive", label: "adaptive" },
            ],
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const thinking = container.querySelector("tbody select") as HTMLSelectElement | null;
    expect(thinking?.value).toBe("");
    expect(thinking?.options[0]?.textContent?.trim()).toBe("Default (adaptive)");
  });

  it("keeps legacy binary thinking labels patching canonical ids", async () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            thinkingLevel: "low",
            thinkingOptions: ["off", "on"],
          }),
        ),
        onPatch,
      }),
      container,
    );
    await Promise.resolve();

    const thinking = container.querySelector("tbody select") as HTMLSelectElement | null;
    expect(thinking?.value).toBe("low");
    expect(
      Array.from(thinking?.options ?? [])
        .find((option) => option.value === "low")
        ?.textContent?.trim(),
    ).toBe("on");

    thinking!.value = "low";
    thinking!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onPatch).toHaveBeenCalledWith("agent:main:main", { thinkingLevel: "low" });
  });

  it("shows agent identity name and emoji for matching session keys", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:data-expert:dingtalk:cidzg6sF43NZMy52Rnk8EN",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
        agentIdentityById: {
          "data-expert": {
            agentId: "data-expert",
            name: "Data Expert",
            avatar: "",
            emoji: "📊",
          },
        },
      }),
      container,
    );
    await Promise.resolve();

    const keyCell = container.querySelector(".session-key-cell");
    expect(keyCell?.textContent).toContain("📊 Data Expert (dingtalk)");
    expect(keyCell?.getAttribute("title")).toBe("📊 Data Expert (dingtalk)");
  });

  it("keeps raw keys when identity data is unavailable", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:unknown-agent:telegram:abc123",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const keyCell = container.querySelector(".session-key-cell");
    expect(keyCell?.textContent).toContain("agent:unknown-agent:telegram:abc123");
    expect(keyCell?.getAttribute("title")).toBe("agent:unknown-agent:telegram:abc123");
  });

  it("renders cron session kind distinctly", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:cron:daily-digest",
            kind: "cron",
            updatedAt: Date.now(),
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const badge = container.querySelector(".data-table-badge--cron");
    expect(badge?.textContent?.trim()).toBe("cron");
  });

  it("keeps raw keys for inherited identity object properties", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:constructor:telegram:abc123",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const text = container.querySelector(".session-key-cell")?.textContent ?? "";
    expect(text).toContain("agent:constructor:telegram:abc123");
    expect(text).not.toContain("Object (telegram)");
  });

  it("expands checkpoint details from row activation when checkpoints exist", async () => {
    const container = document.createElement("div");
    const onToggleCheckpointDetails = vi.fn();
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            totalTokens: 123456,
            contextTokens: 200000,
            compactionCheckpointCount: 1,
            latestCompactionCheckpoint: {
              checkpointId: "checkpoint-1",
              createdAt: Date.now(),
              reason: "manual",
            },
          }),
        ),
        onToggleCheckpointDetails,
      }),
      container,
    );
    await Promise.resolve();

    const row = container.querySelector("tbody tr.session-data-row");
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onToggleCheckpointDetails).toHaveBeenCalledWith("agent:main:main");
    const tokenCell = container.querySelector(".session-token-cell");
    expect(tokenCell?.textContent?.trim()).toBe("123456 / 200000");
  });

  it("does not expand checkpoint details when the row has none or a nested control was used", async () => {
    const container = document.createElement("div");
    const onToggleCheckpointDetails = vi.fn();
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            {
              key: "agent:main:with-checkpoint",
              kind: "direct",
              updatedAt: 20,
              compactionCheckpointCount: 1,
              latestCompactionCheckpoint: {
                checkpointId: "checkpoint-1",
                createdAt: 20,
                reason: "manual",
              },
            },
            {
              key: "agent:main:no-checkpoint",
              kind: "direct",
              updatedAt: 10,
              compactionCheckpointCount: 0,
            },
          ]),
        ),
        onToggleCheckpointDetails,
      }),
      container,
    );
    await Promise.resolve();

    const rows = container.querySelectorAll("tbody tr.session-data-row");
    const checkbox = rows[0]?.querySelector("input[type=checkbox]");
    checkbox?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    rows[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onToggleCheckpointDetails).not.toHaveBeenCalled();
  });

  it("filters rows by agent identity name", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            {
              key: "agent:data-expert:dingtalk:cidzg6sF43NZMy52Rnk8EN",
              kind: "direct",
              updatedAt: 20,
            },
            {
              key: "agent:code-agent:telegram:abc123",
              kind: "direct",
              updatedAt: 10,
            },
          ]),
        ),
        searchQuery: "data expert",
        agentIdentityById: {
          "data-expert": {
            agentId: "data-expert",
            name: "Data Expert",
            avatar: "",
          },
        },
      }),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".session-key-cell")?.textContent).toContain(
      "Data Expert (dingtalk)",
    );
    expect(container.textContent).not.toContain("code-agent");
  });

  it("keeps session selects stable and deselects only the current page", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            fastMode: true,
            verboseLevel: "full",
            reasoningLevel: "custom-mode",
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const selects = container.querySelectorAll("select");
    const fast = selects[1] as HTMLSelectElement | undefined;
    const verbose = selects[2] as HTMLSelectElement | undefined;
    const reasoning = selects[3] as HTMLSelectElement | undefined;
    expect(fast?.value).toBe("on");
    expect(verbose?.value).toBe("full");
    expect(Array.from(verbose?.options ?? []).some((option) => option.value === "full")).toBe(true);
    expect(reasoning?.value).toBe("custom-mode");
    expect(
      Array.from(reasoning?.options ?? []).some((option) => option.value === "custom-mode"),
    ).toBe(true);

    const onSelectPage = vi.fn();
    const onDeselectPage = vi.fn();
    const onDeselectAll = vi.fn();
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            {
              key: "page-0",
              kind: "direct",
              updatedAt: 20,
            },
            {
              key: "page-1",
              kind: "direct",
              updatedAt: 10,
            },
          ]),
        ),
        pageSize: 1,
        selectedKeys: new Set(["page-0", "off-page"]),
        onSelectPage,
        onDeselectPage,
        onDeselectAll,
      }),
      container,
    );
    await Promise.resolve();

    const headerCheckbox = container.querySelector("thead input[type=checkbox]");
    headerCheckbox?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onDeselectPage).toHaveBeenCalledWith(["page-0"]);
    expect(onDeselectAll).not.toHaveBeenCalled();
    expect(onSelectPage).not.toHaveBeenCalled();
  });

  it("shows a reset action when filters hide every session", async () => {
    const container = document.createElement("div");
    const onClearFilters = vi.fn();
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            {
              key: "agent:main:main",
              kind: "direct",
              updatedAt: Date.now(),
            },
          ]),
        ),
        searchQuery: "missing",
        onClearFilters,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("No sessions match your filters.");
    const showAll = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Show all",
    );
    expect(showAll).toBeTruthy();
    showAll?.click();
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("keeps the plain empty state when no filters are active", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(buildMultiResult([])),
        activeMinutes: "",
        limit: "",
        includeGlobal: true,
        includeUnknown: true,
        showArchived: true,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("No sessions found.");
    expect(container.textContent).not.toContain("Show all");
  });
});
