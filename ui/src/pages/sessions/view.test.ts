/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { renderSessions, type SessionsProps } from "./view.ts";

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
    statusFilter: "active",
    basePath: "",
    searchQuery: "",
    transcriptSearchAvailable: true,
    transcriptSearchQuery: "",
    transcriptSearch: { status: "idle" },
    agentIdentityById: {},
    sortColumn: "updated",
    sortDir: "desc",
    groupBy: "none",
    knownCategories: [],
    page: 0,
    pageSize: 10,
    selectedKeys: new Set<string>(),
    sessionMenu: null,
    expandedSessionKey: null,
    checkpointItemsByKey: {},
    checkpointLoadingKey: null,
    checkpointBusyKey: null,
    checkpointErrorByKey: {},
    onFiltersChange: () => undefined,
    onClearFilters: () => undefined,
    onSearchChange: () => undefined,
    onTranscriptSearchChange: () => undefined,
    onTranscriptSearch: () => undefined,
    onClearTranscriptSearch: () => undefined,
    onSortChange: () => undefined,
    onGroupByChange: () => undefined,
    onAssignCategory: () => undefined,
    onRequestNewCategory: () => undefined,
    onPageChange: () => undefined,
    onPageSizeChange: () => undefined,
    onRefresh: () => undefined,
    onStatusFilterChange: () => undefined,
    onDeleteAllArchived: () => undefined,
    onPatch: () => undefined,
    onToggleSelect: () => undefined,
    onSelectPage: () => undefined,
    onDeselectPage: () => undefined,
    onDeselectAll: () => undefined,
    onDeleteSelected: () => undefined,
    onOpenSessionMenu: () => undefined,
    onToggleDetails: () => undefined,
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

const SESSION_TABLE_HEADERS = ["", "Key", "Kind", "Status", "Updated", "Tokens", "Actions"];

describe("sessions view", () => {
  it("keeps transcript search distinct from the loaded-roster filter", async () => {
    const container = document.createElement("div");
    const onTranscriptSearchChange = vi.fn();
    const onTranscriptSearch = vi.fn();
    render(
      renderSessions({
        ...buildProps(buildMultiResult([])),
        searchQuery: "agent label",
        transcriptSearchQuery: "  exact phrase  ",
        onTranscriptSearchChange,
        onTranscriptSearch,
      }),
      container,
    );
    await Promise.resolve();

    const rosterFilter = container.querySelector<HTMLInputElement>(
      '.sessions-filter-bar input[type="text"]',
    );
    const transcriptInput = container.querySelector<HTMLInputElement>(
      '.sessions-transcript-search input[type="search"]',
    );
    expect(rosterFilter?.value).toBe("agent label");
    expect(transcriptInput?.value).toBe("  exact phrase  ");

    transcriptInput!.value = "different words";
    transcriptInput!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onTranscriptSearchChange).toHaveBeenCalledWith("different words");
    expect(onTranscriptSearch).not.toHaveBeenCalled();

    container
      .querySelector(".sessions-transcript-search__form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onTranscriptSearch).toHaveBeenCalledOnce();
  });

  it("renders transcript provenance and opens the matching session", async () => {
    const container = document.createElement("div");
    const onNavigateToChat = vi.fn();
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            {
              key: "agent:main:launch",
              kind: "direct",
              label: "Launch planning",
              updatedAt: Date.parse("2026-07-12T12:00:00.000Z"),
            },
          ]),
        ),
        transcriptSearchQuery: "launch code",
        transcriptSearch: {
          status: "results",
          results: [
            {
              sessionKey: "agent:main:launch",
              sessionId: "session-launch",
              messageId: "message-1",
              role: "assistant",
              timestamp: Date.parse("2026-07-12T12:00:00.000Z"),
              snippet: "The <launch code> is ready.",
              score: 1,
            },
          ],
          indexing: true,
          truncated: true,
        },
        onNavigateToChat,
      }),
      container,
    );
    await Promise.resolve();

    const result = container.querySelector<HTMLButtonElement>(
      ".sessions-transcript-search__result",
    );
    expect(result?.textContent).toContain("Launch planning");
    expect(result?.textContent).toContain("Assistant");
    expect(result?.textContent).toContain("The <launch code> is ready.");
    expect(result?.querySelector("launch")).toBeNull();
    expect(container.textContent).toContain("The transcript index is still updating");
    expect(container.textContent).toContain("Showing the first 25 matches.");

    result?.click();
    expect(onNavigateToChat).toHaveBeenCalledWith("agent:main:launch");
  });

  it("disables transcript search when the Gateway does not advertise it", async () => {
    const container = document.createElement("div");
    const onTranscriptSearch = vi.fn();
    render(
      renderSessions({
        ...buildProps(buildMultiResult([])),
        transcriptSearchAvailable: false,
        transcriptSearchQuery: "hidden",
        onTranscriptSearch,
      }),
      container,
    );
    await Promise.resolve();

    expect(
      container.querySelector<HTMLInputElement>('.sessions-transcript-search input[type="search"]')
        ?.disabled,
    ).toBe(true);
    expect(container.textContent).toContain("Transcript search requires a newer Gateway.");
    container
      .querySelector(".sessions-transcript-search__form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onTranscriptSearch).not.toHaveBeenCalled();
  });

  it("renders Active, Archived, and All status segments", async () => {
    const container = document.createElement("div");
    const onStatusFilterChange = vi.fn();
    render(
      renderSessions({
        ...buildProps(buildMultiResult([])),
        onStatusFilterChange,
      }),
      container,
    );
    await Promise.resolve();

    const buttons = container.querySelectorAll<HTMLButtonElement>(".sessions-view-segment button");
    expect([...buttons].map((button) => button.textContent?.trim())).toEqual([
      "Active",
      "Archived",
      "All",
    ]);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");
    expect(buttons[2]?.getAttribute("aria-pressed")).toBe("false");

    buttons[2]?.click();

    expect(onStatusFilterChange).toHaveBeenCalledWith("all");
  });

  it("dims and labels archived rows in the mixed view", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            { key: "agent:main:active", kind: "direct", updatedAt: 2, archived: false },
            { key: "agent:main:archived", kind: "direct", updatedAt: 1, archived: true },
          ]),
        ),
        statusFilter: "all",
      }),
      container,
    );
    await Promise.resolve();

    const archivedRow = container.querySelector(".session-data-row--archived");
    expect(archivedRow?.textContent).toContain("Archived");
    expect(container.querySelectorAll(".session-data-row--archived")).toHaveLength(1);
  });

  it("groups sessions by channel with section headers and no pagination", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            { key: "agent:main:discord:channel:1", kind: "group", updatedAt: 3 },
            { key: "agent:main:telegram:direct:2", kind: "direct", updatedAt: 2 },
            { key: "agent:main:discord:channel:3", kind: "group", updatedAt: 1 },
          ]),
        ),
        groupBy: "channel",
      }),
      container,
    );
    await Promise.resolve();

    const headers = Array.from(container.querySelectorAll(".session-group-row__label")).map((el) =>
      el.textContent?.trim(),
    );
    expect(headers).toEqual(["discord", "telegram"]);
    const counts = Array.from(container.querySelectorAll(".session-group-row__count")).map((el) =>
      el.textContent?.trim(),
    );
    expect(counts).toEqual(["2 threads", "1 thread"]);
    expect(container.querySelector(".data-table-pagination")).toBeNull();
  });

  it("keeps the filtered empty state when grouping is active", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([{ key: "agent:main:discord:channel:1", kind: "group", updatedAt: 1 }]),
        ),
        groupBy: "category",
        knownCategories: ["Research"],
        searchQuery: "no-such-session",
      }),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".data-table-empty-state")).not.toBeNull();
    expect(container.querySelector(".session-group-row")).toBeNull();
  });

  it("assigns custom groups from the group cell and header drop targets", async () => {
    const container = document.createElement("div");
    const onAssignCategory = vi.fn();
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            { key: "agent:main:discord:channel:1", kind: "group", updatedAt: 2 },
            { key: "agent:main:main", kind: "direct", updatedAt: 1, category: "Research" },
          ]),
        ),
        groupBy: "category",
        knownCategories: ["Research"],
        onAssignCategory,
      }),
      container,
    );
    await Promise.resolve();

    const headers = Array.from(container.querySelectorAll(".session-group-row__label")).map((el) =>
      el.textContent?.trim(),
    );
    expect(headers).toEqual(["Research", "Ungrouped"]);

    // Rows render in group order: Research (agent:main:main) first, then Ungrouped (discord).
    const select = container.querySelectorAll<HTMLSelectElement>(
      'select[aria-label="Move thread to a group"]',
    )[1];
    if (!select) {
      throw new Error("Expected group select");
    }
    select.value = "Research";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onAssignCategory).toHaveBeenCalledWith("agent:main:discord:channel:1", "Research");

    const headerRow = container.querySelector(".session-group-row");
    if (!headerRow) {
      throw new Error("Expected group header row");
    }
    const dropWithPayload = (types: string[], data: Record<string, string>) => {
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", {
        value: { types, getData: (type: string) => data[type] ?? "" },
      });
      headerRow.dispatchEvent(drop);
    };

    // Generic text drags (e.g. selected page text) must not trigger patches.
    dropWithPayload(["text/plain"], { "text/plain": "not-a-session" });
    expect(onAssignCategory).toHaveBeenCalledTimes(1);

    dropWithPayload(["application/x-openclaw-session-key"], {
      "application/x-openclaw-session-key": "agent:main:main",
    });
    expect(onAssignCategory).toHaveBeenCalledWith("agent:main:main", "Research");
  });

  it("opens the session menu from the kebab and row context menu", async () => {
    const container = document.createElement("div");
    const onOpenSessionMenu = vi.fn();
    const session = {
      key: "agent:main:dashboard:1",
      kind: "direct",
      updatedAt: Date.now(),
    } as const;
    render(
      renderSessions({
        ...buildProps(buildResult(session)),
        onOpenSessionMenu,
      }),
      container,
    );
    await Promise.resolve();

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open thread menu"]',
    );
    if (!button) {
      throw new Error("Expected session menu button");
    }
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    button.click();
    expect(onOpenSessionMenu).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ key: session.key }),
      { x: expect.any(Number), y: expect.any(Number) },
      button,
    );

    const row = container.querySelector(".session-data-row");
    if (!row) {
      throw new Error("Expected session row");
    }
    const contextMenu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 123,
      clientY: 45,
    });
    row.dispatchEvent(contextMenu);
    expect(onOpenSessionMenu).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ key: session.key }),
      { x: 123, y: 45 },
      null,
    );
    expect(contextMenu.defaultPrevented).toBe(true);
  });

  it("keeps pinned sessions above newer unpinned sessions", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            { key: "newer", kind: "direct", updatedAt: 200 },
            { key: "pinned", kind: "direct", updatedAt: 100, pinned: true, pinnedAt: 300 },
          ]),
        ),
      }),
      container,
    );
    await Promise.resolve();

    const keys = Array.from(container.querySelectorAll("tbody .session-data-row")).map((row) =>
      row.querySelector(".session-key-cell")?.textContent?.trim(),
    );
    expect(keys).toEqual(["pinned", "newer"]);
  });

  it("uses the shared tooltip component for session filters", async () => {
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
    const activeField = filters?.querySelector(".session-filter-input--minutes")?.closest("label");
    const tooltips = Array.from(
      filters?.querySelectorAll<HTMLElement>("openclaw-tooltip") ?? [],
    ).map((tooltip) => (tooltip as HTMLElement & { content: string }).content);

    expect(activeField?.querySelector(".session-filter-label")?.textContent).toBe("Updated within");
    expect(tooltips).toEqual([
      "Loads threads updated in the last 120 minutes.",
      "Max threads to load.",
      "Include global threads.",
      "Include unknown threads.",
    ]);
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
      primaryRow?.firstElementChild?.querySelector("label"),
    );
    expect(primaryRow?.querySelector(".session-filter-input--limit")?.closest("label")).toBe(
      primaryRow?.lastElementChild?.querySelector("label"),
    );

    const toggleGroup = container.querySelector(".session-filter-toggle-group");
    expect(toggleGroup?.getAttribute("role")).toBe("group");
    expect(toggleGroup?.getAttribute("aria-label")).toBe("Thread source filters");
    expect(toggleGroup?.querySelectorAll(".session-filter-check")).toHaveLength(2);
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
    ]);
    expect(toggleGroup?.querySelector(".session-filter-check__box")).toBeNull();
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
        expandedSessionKey: "agent:main:main",
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
    ).toBe("Maximum");

    thinking!.value = "max";
    thinking!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onPatch).toHaveBeenCalledWith("agent:main:main", { thinkingLevel: "max" });
  });

  it("labels inherited thinking with the resolved session default", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
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
        expandedSessionKey: "agent:main:main",
      }),
      container,
    );
    await Promise.resolve();

    const thinking = container.querySelector("tbody select") as HTMLSelectElement | null;
    expect(thinking?.value).toBe("");
    expect(thinking?.options[0]?.textContent?.trim()).toBe("Inherited: Adaptive");
    expect(
      Array.from(thinking?.options ?? [])
        .find((option) => option.value === "adaptive")
        ?.textContent?.trim(),
    ).toBe("Adaptive");
  });

  it("labels inherited thinking from list defaults when lightweight rows omit row defaults", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildResult(
            {
              key: "agent:main:main",
              kind: "direct",
              updatedAt: Date.now(),
            },
            {
              modelProvider: "openai",
              model: "gpt-5.5",
              thinkingDefault: "high",
              thinkingLevels: [
                { id: "off", label: "off" },
                { id: "high", label: "high" },
              ],
            },
          ),
        ),
        expandedSessionKey: "agent:main:main",
      }),
      container,
    );
    await Promise.resolve();

    const thinking = container.querySelector("tbody select") as HTMLSelectElement | null;
    expect(thinking?.value).toBe("");
    expect(thinking?.options[0]?.textContent?.trim()).toBe("Inherited: High");
    expect(Array.from(thinking?.options ?? []).map((option) => option.textContent?.trim())).toEqual(
      ["Inherited: High", "Off", "High"],
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
        expandedSessionKey: "agent:main:main",
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
    ).toBe("On");

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
    expect((keyCell?.parentElement as (HTMLElement & { content: string }) | null)?.content).toBe(
      "📊 Data Expert (dingtalk)",
    );
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
    expect((keyCell?.parentElement as (HTMLElement & { content: string }) | null)?.content).toBe(
      "agent:unknown-agent:telegram:abc123",
    );
  });

  it("renders cron session kind distinctly", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:cron:daily-digest",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const badge = container.querySelector(".session-kind--cron");
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
              status: "running",
            },
            {
              key: "agent:main:failed",
              kind: "direct",
              updatedAt: 10,
              status: "failed",
            },
            {
              key: "agent:main:done",
              kind: "direct",
              updatedAt: 5,
              hasActiveRun: true,
              status: "done",
            },
          ]),
        ),
      ),
      container,
    );
    await Promise.resolve();

    expect(sessionTableHeaders(container)).toEqual(SESSION_TABLE_HEADERS);
    const badges = Array.from(container.querySelectorAll(".settings-status"));
    expect(badges.map((badge) => badge.textContent?.trim())).toEqual([
      "Live",
      "Idle",
      "Failed",
      "Done",
    ]);
    expect(badges.map((badge) => [...badge.classList])).toEqual([
      ["settings-status", "settings-status--ok"],
      ["settings-status"],
      ["settings-status", "settings-status--danger"],
      ["settings-status", "settings-status--ok"],
    ]);
    expect(
      badges.map(
        (badge) => (badge.parentElement as (HTMLElement & { content: string }) | null)?.content,
      ),
    ).toEqual(["Status: Live", "Status: Idle", "Status: Failed", "Status: Done"]);
  });

  it("renders session goals in the status cell and search index", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:goal",
            kind: "direct",
            updatedAt: 20,
            hasActiveRun: true,
            status: "running",
            goal: {
              schemaVersion: 1,
              id: "goal-1",
              objective: "Ship the web goal indicator",
              status: "active",
              createdAt: 1,
              updatedAt: 2,
              tokenStart: 100,
              tokensUsed: 12_400,
              tokenBudget: 50_000,
              continuationTurns: 0,
            },
          }),
        ),
        searchQuery: "web goal",
      }),
      container,
    );
    await Promise.resolve();

    const statuses = container.querySelectorAll(".session-status-stack .settings-status");
    const goal = statuses[1];
    expect(goal?.textContent?.replace(/\s+/g, " ").trim()).toBe("Pursuing goal (12k/50k)");
    // The wrapper span exposes the objective to keyboard/screen-reader users.
    const wrapper = goal?.parentElement;
    expect(wrapper?.getAttribute("tabindex")).toBe("0");
    expect(wrapper?.getAttribute("aria-label")).toBe(
      "Pursuing goal (12k/50k): Ship the web goal indicator",
    );
    const tooltip = wrapper?.parentElement as (HTMLElement & { content: string }) | null;
    expect(tooltip?.content).toBe("Pursuing goal (12k/50k): Ship the web goal indicator");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("filters by agent runtime and surfaces it in the details drawer", async () => {
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
        expandedSessionKey: "agent:main:claude",
      }),
      container,
    );
    await Promise.resolve();

    expect(sessionTableHeaders(container)).toEqual(SESSION_TABLE_HEADERS);
    // The roster no longer has a Runtime column; the drawer carries it.
    expect(container.querySelector(".session-runtime-cell")).toBeNull();
    const rows = container.querySelectorAll("tbody tr.session-data-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector(".session-key-cell")?.textContent?.trim()).toBe(
      "agent:main:claude",
    );
    const stats = readSessionDetailStats(container);
    expect(stats.get("Runtime")).toBe("claude-cli (fallback none)");
  });

  it("does not filter terminal sessions as live when active-run flags are stale", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            {
              key: "agent:main:done",
              kind: "direct",
              updatedAt: 20,
              hasActiveRun: true,
              status: "done",
            },
            {
              key: "agent:main:running",
              kind: "direct",
              updatedAt: 10,
              hasActiveRun: true,
              status: "running",
            },
          ]),
        ),
        searchQuery: "live",
      }),
      container,
    );
    await Promise.resolve();

    const rows = container.querySelectorAll("tbody tr.session-data-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector(".session-key-cell")?.textContent?.trim()).toBe(
      "agent:main:running",
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

  it("opens session details from row activation", async () => {
    const container = document.createElement("div");
    const onToggleDetails = vi.fn();
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
        onToggleDetails,
      }),
      container,
    );
    await Promise.resolve();

    const row = container.querySelector<HTMLTableRowElement>("tbody tr.session-data-row");
    expect(row).toBeInstanceOf(HTMLTableRowElement);
    row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onToggleDetails).toHaveBeenCalledWith("agent:main:main");
    const tokenCell = container.querySelector(".session-token-cell");
    expect(tokenCell?.textContent?.trim()).toBe("123k / 200k");
  });

  it("renders the checkpoint count on the details disclosure", async () => {
    const container = document.createElement("div");
    const onToggleDetails = vi.fn();
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
        onToggleDetails,
      }),
      container,
    );
    await Promise.resolve();

    const trigger = container.querySelector<HTMLButtonElement>(".session-details-toggle");
    expect(trigger?.querySelector(".session-compaction-count")?.textContent?.trim()).toBe("1");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onToggleDetails).toHaveBeenCalledWith("agent:main:main");
  });

  it("omits the checkpoint count pill when a session has no checkpoints", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const trigger = container.querySelector<HTMLButtonElement>(".session-details-toggle");
    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    expect(trigger?.querySelector(".session-compaction-count")).toBeNull();
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
            goal: {
              schemaVersion: 1,
              id: "goal-1",
              objective: "Finish the compaction details",
              status: "blocked",
              createdAt: 1,
              updatedAt: 2,
              tokenStart: 1000,
              tokensUsed: 24_000,
              continuationTurns: 3,
              lastStatusNote: "Waiting for owner review",
              blockedAt: 3,
            },
            compactionCheckpointCount: 1,
            latestCompactionCheckpoint: {
              checkpointId: "checkpoint-1",
              createdAt: Date.now(),
              reason: "manual",
            },
          }),
        ),
        expandedSessionKey: "agent:main:main",
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
      "Thread details",
    );
    expect(details?.querySelector(".session-details-panel__title")?.textContent?.trim()).toBe(
      "agent:main:main",
    );
    expect(
      Array.from(details?.querySelectorAll(".session-details-panel__badges > *") ?? []).map(
        (badge) => badge.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual(["Live", "Goal blocked (24k used)", "direct"]);

    const stats = readSessionDetailStats(details ?? container);
    expect(stats.get("Status")).toBe("running");
    expect(stats.get("Model")).toBe("gpt-5.5");
    expect(stats.get("Provider")).toBe("openai");
    expect(stats.get("Runtime")).toBe("pi");
    expect(stats.get("Run duration")).toBe("2m 5s");
    expect(stats.get("Tokens")).toBe("123456 / 200000");
    expect(stats.get("Compaction")).toBe("1 Checkpoint");
    expect(stats.get("Goal")).toBe(
      "Goal blocked (24k used): Finish the compaction details - Waiting for owner review",
    );
    expect(stats.get("Goal note")).toBe("Waiting for owner review");

    const sections = Array.from(details?.querySelectorAll(".session-details-section") ?? []);
    expect(sections).toHaveLength(2);
    const [overridesSection, compactionSection] = sections;
    expect(
      overridesSection?.querySelector(".session-details-panel__eyebrow")?.textContent?.trim(),
    ).toBe("Overrides");
    expect(
      Array.from(overridesSection?.querySelectorAll(".session-override-field__label") ?? []).map(
        (label) => label.textContent?.trim(),
      ),
    ).toEqual(["Label", "Thinking", "Fast", "Verbose", "Reasoning"]);

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

  it("opens details for sessions without checkpoints but ignores nested control clicks", async () => {
    const container = document.createElement("div");
    const onToggleDetails = vi.fn();
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
        onToggleDetails,
      }),
      container,
    );
    await Promise.resolve();

    const rows = container.querySelectorAll("tbody tr.session-data-row");
    const checkbox = rows[0]?.querySelector<HTMLInputElement>("input[type=checkbox]");
    expect(checkbox).toBeInstanceOf(HTMLInputElement);
    expect(rows[1]).toBeInstanceOf(HTMLTableRowElement);
    if (!(checkbox instanceof HTMLInputElement) || !(rows[1] instanceof HTMLTableRowElement)) {
      throw new Error("Expected details toggle row controls");
    }
    // Nested controls (like the select checkbox) must not toggle the drawer.
    checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onToggleDetails).not.toHaveBeenCalled();

    // Sessions without checkpoints still open the drawer for overrides and stats.
    rows[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onToggleDetails).toHaveBeenCalledWith("agent:main:no-checkpoint");
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
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            fastMode: true,
            verboseLevel: "full",
            reasoningLevel: "custom-mode",
          }),
        ),
        expandedSessionKey: "agent:main:main",
      }),
      container,
    );
    await Promise.resolve();

    // Scope to drawer selects; the toolbar also renders a group-by select.
    const selects = container.querySelectorAll("tbody select");
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
      "No threads match your filters.",
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
        statusFilter: "archived",
      }),
      container,
    );
    await Promise.resolve();

    const emptyCell = container.querySelector(".data-table-empty-cell");
    expect(emptyCell?.textContent?.trim()).toBe("No archived sessions.");
    expect(emptyCell?.querySelector("button")).toBeNull();
  });

  it.each([
    { activeMinutes: "60minutes", limit: "1e2", filtered: false },
    { activeMinutes: "+30", limit: "060", filtered: true },
  ])("keeps numeric-filter empty state consistent: $activeMinutes / $limit", async (testCase) => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(buildMultiResult([])),
        activeMinutes: testCase.activeMinutes,
        limit: testCase.limit,
        includeGlobal: true,
        includeUnknown: true,
        statusFilter: "archived",
      }),
      container,
    );
    await Promise.resolve();

    const emptyState = container.querySelector(".data-table-empty-state");
    expect(emptyState?.firstElementChild?.textContent?.trim()).toBe(
      testCase.filtered ? "No threads match your filters." : "No archived sessions.",
    );
    expect(emptyState?.querySelector("button") !== null).toBe(testCase.filtered);
  });

  it("summarizes loaded sessions in the overview tiles", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildMultiResult([
            {
              key: "agent:main:live",
              kind: "direct",
              updatedAt: 2,
              hasActiveRun: true,
              status: "running",
              totalTokens: 1200,
            },
            {
              key: "agent:main:idle",
              kind: "direct",
              updatedAt: 1,
              unread: true,
              totalTokens: 300,
            },
          ]),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const tiles = Array.from(container.querySelectorAll(".sessions-overview__tile"));
    const readTile = (tile: Element) => [
      tile.querySelector(".sessions-overview__label")?.textContent?.trim(),
      tile.querySelector(".sessions-overview__value")?.textContent?.trim(),
    ];
    expect(tiles.map(readTile)).toEqual([
      ["Threads", "2"],
      ["Live", "1"],
      ["Unread", "1"],
      ["Tokens", "1.5k"],
    ]);
    expect(tiles[1]?.classList.contains("sessions-overview__tile--active")).toBe(true);
    expect(tiles[2]?.classList.contains("sessions-overview__tile--active")).toBe(true);
  });

  it("renders a context meter with usage tone on the tokens cell", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            totalTokens: 180_000,
            contextTokens: 200_000,
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const meter = container.querySelector(".session-context-meter");
    expect(meter?.classList.contains("session-context-meter--danger")).toBe(true);
    expect(meter?.getAttribute("aria-label")).toBe(
      "90% of context used (180,000 / 200,000 tokens)",
    );
    expect(container.querySelector<HTMLElement>(".session-context-meter__fill")?.style.width).toBe(
      "90%",
    );
    expect(container.querySelector(".session-token-cell")?.textContent?.trim()).toBe("180k / 200k");
  });

  it("keeps stale token snapshots out of the warning tones", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            totalTokens: 180_000,
            totalTokensFresh: false,
            contextTokens: 200_000,
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const meter = container.querySelector(".session-context-meter");
    expect(meter?.classList.contains("session-context-meter--stale")).toBe(true);
    expect(meter?.classList.contains("session-context-meter--danger")).toBe(false);
    expect(meter?.getAttribute("aria-label")).toBe(
      "~90% of context used (180,000 / 200,000 tokens, approximate)",
    );
    expect(container.querySelector(".session-token-cell")?.textContent?.trim()).toBe(
      "~180k / 200k",
    );
  });

  it("reports the overview token sum as unavailable or partial when snapshots are missing", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildMultiResult([
            { key: "agent:main:a", kind: "direct", updatedAt: 2, totalTokens: 1200 },
            { key: "agent:main:b", kind: "direct", updatedAt: 1 },
          ]),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const tokensTile = container.querySelector(".sessions-overview__tile--tokens");
    expect(tokensTile?.querySelector(".sessions-overview__value")?.textContent?.trim()).toBe(
      "~1.2k",
    );

    render(
      renderSessions(
        buildProps(buildMultiResult([{ key: "agent:main:b", kind: "direct", updatedAt: 1 }])),
      ),
      container,
    );
    await Promise.resolve();

    expect(
      container
        .querySelector(".sessions-overview__tile--tokens .sessions-overview__value")
        ?.textContent?.trim(),
    ).toBe("n/a");
  });

  it("omits the context meter when a session reports no context window", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            totalTokens: 4200,
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".session-context-meter")).toBeNull();
    expect(container.querySelector(".session-token-cell")?.textContent?.trim()).toBe("4.2k");
  });

  it("renders kind avatars with a live status dot", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildMultiResult([
            {
              // Cron display kind derives from the key shape, never the wire kind.
              key: "agent:main:cron:live",
              kind: "direct",
              updatedAt: 2,
              hasActiveRun: true,
              status: "running",
            },
            { key: "agent:main:idle", kind: "direct", updatedAt: 1, hasActiveRun: false },
          ]),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const avatars = Array.from(container.querySelectorAll(".session-avatar"));
    expect(avatars.map((avatar) => [...avatar.classList])).toEqual([
      ["session-avatar", "session-avatar--cron"],
      ["session-avatar", "session-avatar--direct"],
    ]);
    expect(avatars[0]?.querySelector(".session-avatar__status")).not.toBeNull();
    expect(avatars[1]?.querySelector(".session-avatar__status")).toBeNull();
  });

  it("shows skeleton rows during the initial load", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({ ...buildProps(buildMultiResult([])), result: null, loading: true }),
      container,
    );
    await Promise.resolve();

    expect(container.querySelectorAll(".session-skeleton-row").length).toBeGreaterThan(0);
    expect(container.querySelector(".data-table-empty-cell")).toBeNull();
    expect(container.querySelector(".sessions-overview")).toBeNull();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
