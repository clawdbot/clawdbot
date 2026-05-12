/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../types.ts";
import { renderSessions, type SessionsProps } from "./sessions.ts";

function buildResult(
  session: SessionsListResult["sessions"][number],
  defaults?: Partial<SessionsListResult["defaults"]>,
): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null, ...defaults },
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

function readSessionDetailStats(container: ParentNode): Map<string, string> {
  return new Map(
    Array.from(container.querySelectorAll(".session-detail-stat")).map((stat) => [
      stat.querySelector(".session-detail-stat__label")?.textContent?.trim() ?? "",
      stat.querySelector(".session-detail-stat__value")?.textContent?.trim() ?? "",
    ]),
  );
}

function sessionTableHeaders(container: HTMLElement): Array<string | undefined> {
  return Array.from(container.querySelectorAll("thead th")).map((cell) => cell.textContent?.trim());
}

const SESSION_TABLE_HEADERS = [
  "",
  "Key",
  "Label",
  "Kind",
  "Status",
  "Runtime",
  "Updated",
  "Tokens",
  "Compaction",
  "Thinking",
  "Fast",
  "Verbose",
  "Reasoning",
];

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

    expect(activeField?.querySelector(".session-filter-label")?.textContent).toBe("Updated within");
    expect(activeField?.getAttribute("data-tooltip")).toBe(
      "Loads sessions updated in the last 120 minutes.",
    );
    expect(limitField?.getAttribute("data-tooltip")).toBe("Max sessions to load.");
    expect(globalToggle?.getAttribute("data-tooltip")).toBe("Include global sessions.");
    expect(unknownToggle?.getAttribute("data-tooltip")).toBe("Include unknown sessions.");
    expect(archivedToggle?.getAttribute("data-tooltip")).toBe("Include archived sessions.");
    expect(
      Array.from(filters?.querySelectorAll("[title]") ?? []).map((node) => node.className),
    ).toStrictEqual([]);
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
      Array.from(toggleGroup?.querySelectorAll(".session-filter-check") ?? []).map((toggle) => [
        toggle.querySelector("input")?.getAttribute("name"),
        [...toggle.classList],
      ]),
    ).toEqual([
      [
        "includeGlobal",
        ["session-filter-check", "session-filter-toggle", "session-filter-check--active"],
      ],
      ["includeUnknown", ["session-filter-check", "session-filter-toggle"]],
      ["showArchived", ["session-filter-check", "session-filter-toggle", "session-archive-toggle"]],
    ]);
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

    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    toggle!.click();

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
    ).toBe("Override: maximum");

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
    expect(thinking?.options[0]?.textContent?.trim()).toBe("Inherited: adaptive");
    expect(
      Array.from(thinking?.options ?? [])
        .find((option) => option.value === "adaptive")
        ?.textContent?.trim(),
    ).toBe("Override: adaptive");
  });

  it("labels inherited thinking from list defaults when lightweight rows omit row defaults", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult(
            {
              key: "agent:main:main",
              kind: "direct",
              updatedAt: Date.now(),
            },
            {
              modelProvider: "openai-codex",
              model: "gpt-5.5",
              thinkingDefault: "high",
              thinkingLevels: [
                { id: "off", label: "off" },
                { id: "high", label: "high" },
              ],
            },
          ),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const thinking = container.querySelector("tbody select") as HTMLSelectElement | null;
    expect(thinking?.value).toBe("");
    expect(thinking?.options[0]?.textContent?.trim()).toBe("Inherited: high");
    expect(Array.from(thinking?.options ?? []).map((option) => option.textContent?.trim())).toEqual(
      ["Inherited: high", "Off", "Override: high"],
    );
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
    ).toBe("Override: on");

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
    expect(keyCell?.textContent?.trim()).toBe("📊 Data Expert (dingtalk)");
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
    expect(keyCell?.textContent?.trim()).toBe("agent:unknown-agent:telegram:abc123");
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

  it("renders live and terminal run status badges", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildMultiResult([
            {
              key: "agent:main:live",
              kind: "direct",
              updatedAt: 30,
              hasActiveRun: true,
              status: "running",
            },
            {
              key: "agent:main:idle",
              kind: "direct",
              updatedAt: 20,
              hasActiveRun: false,
            },
            {
              key: "agent:main:failed",
              kind: "direct",
              updatedAt: 10,
              status: "failed",
            },
          ]),
        ),
      ),
      container,
    );
    await Promise.resolve();

    expect(sessionTableHeaders(container)).toEqual(SESSION_TABLE_HEADERS);
    const badges = Array.from(container.querySelectorAll(".session-status-badge"));
    expect(badges.map((badge) => badge.textContent?.trim())).toEqual(["Live", "Idle", "Failed"]);
    expect(badges.map((badge) => [...badge.classList])).toEqual([
      ["session-status-badge", "session-status-badge--live"],
      ["session-status-badge", "session-status-badge--idle"],
      ["session-status-badge", "session-status-badge--failed"],
    ]);
    expect(badges.map((badge) => badge.getAttribute("aria-label"))).toEqual([
      "Status: Live",
      "Status: Idle",
      "Status: Failed",
    ]);
  });

  it("renders and filters the session runtime", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            {
              key: "agent:main:claude",
              kind: "direct",
              updatedAt: 20,
              agentRuntime: { id: "claude-cli", fallback: "none", source: "agent" },
            },
            {
              key: "agent:main:pi",
              kind: "direct",
              updatedAt: 10,
              agentRuntime: { id: "pi", source: "implicit" },
            },
          ]),
        ),
        searchQuery: "fallback none",
      }),
      container,
    );
    await Promise.resolve();

    expect(sessionTableHeaders(container)).toEqual(SESSION_TABLE_HEADERS);
    expect(container.querySelector(".session-runtime-cell")?.textContent?.trim()).toBe(
      "claude-cli (fallback none)",
    );
    const rows = container.querySelectorAll("tbody tr.session-data-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector(".session-key-cell")?.textContent?.trim()).toBe(
      "agent:main:claude",
    );
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
    expect(text.trim()).toBe("agent:constructor:telegram:abc123");
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

    const row = container.querySelector<HTMLTableRowElement>("tbody tr.session-data-row");
    expect(row).toBeInstanceOf(HTMLTableRowElement);
    row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onToggleCheckpointDetails).toHaveBeenCalledWith("agent:main:main");
    const tokenCell = container.querySelector(".session-token-cell");
    expect(tokenCell?.textContent?.trim()).toBe("123456 / 200000");
  });

  it("renders the checkpoint count as the compaction disclosure", async () => {
    const container = document.createElement("div");
    const onToggleCheckpointDetails = vi.fn();
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
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

    const trigger = container.querySelector<HTMLButtonElement>(".session-compaction-trigger");
    expect(trigger?.querySelector(".session-compaction-count")?.textContent?.trim()).toBe(
      "1 Checkpoint",
    );
    expect(trigger?.textContent?.trim()).toBe("1 Checkpoint");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".session-checkpoint-toggle")).toBeNull();

    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onToggleCheckpointDetails).toHaveBeenCalledWith("agent:main:main");
  });

  it("renders expanded session details with compaction history", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            totalTokens: 123456,
            contextTokens: 200000,
            model: "gpt-5.5",
            modelProvider: "openai",
            status: "running",
            runtimeMs: 125000,
            compactionCheckpointCount: 1,
            latestCompactionCheckpoint: {
              checkpointId: "checkpoint-1",
              createdAt: Date.now(),
              reason: "manual",
            },
          }),
        ),
        expandedCheckpointKey: "agent:main:main",
        checkpointItemsByKey: {
          "agent:main:main": [
            {
              checkpointId: "checkpoint-1",
              sessionKey: "agent:main:main",
              sessionId: "session-1",
              createdAt: Date.now(),
              reason: "manual",
              tokensBefore: 123456,
              tokensAfter: 38920,
              summary: "Trimmed earlier setup chatter and kept the active execution plan.",
              preCompaction: { sessionId: "session-1" },
              postCompaction: { sessionId: "session-1" },
            },
          ],
        },
      }),
      container,
    );
    await Promise.resolve();

    const details = container.querySelector(".session-details-panel");
    expect(details?.querySelector(".session-details-panel__eyebrow")?.textContent?.trim()).toBe(
      "Session details",
    );
    expect(details?.querySelector(".session-details-panel__title")?.textContent?.trim()).toBe(
      "agent:main:main",
    );
    expect(
      Array.from(details?.querySelectorAll(".session-details-panel__badges > *") ?? []).map(
        (badge) => badge.textContent?.trim(),
      ),
    ).toEqual(["Live", "direct"]);

    const stats = readSessionDetailStats(details ?? container);
    expect(stats.get("Status")).toBe("running");
    expect(stats.get("Model")).toBe("gpt-5.5");
    expect(stats.get("Provider")).toBe("openai");
    expect(stats.get("Runtime")).toBe("2m 5s");
    expect(stats.get("Tokens")).toBe("123456 / 200000");
    expect(stats.get("Compaction")).toBe("1 Checkpoint");

    const compactionSection = details?.querySelector(".session-details-section");
    expect(
      compactionSection?.querySelector(".session-details-panel__eyebrow")?.textContent?.trim(),
    ).toBe("Compaction history");
    expect(
      compactionSection?.querySelector(".session-details-section__title")?.textContent?.trim(),
    ).toBe("1 Checkpoint");
    expect(
      compactionSection?.querySelector(".session-checkpoint-card__delta")?.textContent?.trim(),
    ).toBe("123,456 to 38,920 tokens");
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
    const checkbox = rows[0]?.querySelector<HTMLInputElement>("input[type=checkbox]");
    expect(checkbox).toBeInstanceOf(HTMLInputElement);
    expect(rows[1]).toBeInstanceOf(HTMLTableRowElement);
    if (!(checkbox instanceof HTMLInputElement) || !(rows[1] instanceof HTMLTableRowElement)) {
      throw new Error("Expected checkpoint toggle row controls");
    }
    checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    rows[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));

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

    const rows = container.querySelectorAll("tbody tr.session-data-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector(".session-key-cell")?.textContent?.trim()).toBe(
      "Data Expert (dingtalk)",
    );
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
    expect(Array.from(verbose?.options ?? []).map((option) => option.value)).toEqual([
      "",
      "off",
      "on",
      "full",
    ]);
    expect(reasoning?.value).toBe("custom-mode");
    expect(Array.from(reasoning?.options ?? []).map((option) => option.value)).toEqual([
      "",
      "off",
      "on",
      "stream",
      "custom-mode",
    ]);

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

    const headerCheckbox = container.querySelector<HTMLInputElement>("thead input[type=checkbox]");
    expect(headerCheckbox).toBeInstanceOf(HTMLInputElement);
    headerCheckbox!.dispatchEvent(new Event("change", { bubbles: true }));

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

    const emptyState = container.querySelector(".data-table-empty-state");
    expect(emptyState?.getAttribute("role")).toBe("status");
    expect(emptyState?.firstElementChild?.textContent?.trim()).toBe(
      "No sessions match your filters.",
    );
    const showAll = emptyState?.querySelector<HTMLButtonElement>("button");
    if (!(showAll instanceof HTMLButtonElement)) {
      throw new Error("Expected filtered empty state to render a Show all button");
    }
    expect(showAll.textContent?.trim()).toBe("Show all");
    showAll.click();
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

    const emptyCell = container.querySelector(".data-table-empty-cell");
    expect(emptyCell?.textContent?.trim()).toBe("No sessions found.");
    expect(emptyCell?.querySelector("button")).toBeNull();
  });
});
