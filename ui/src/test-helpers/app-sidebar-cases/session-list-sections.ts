import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGateway,
  createSessions,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar session section visibility", () => {
  it("paginates each expanded section independently", async () => {
    const threadKeys = Array.from({ length: 12 }, (_, index) => `agent:main:thread-${index}`);
    const categoryKeys = Array.from({ length: 12 }, (_, index) => `agent:main:alpha-${index}`);
    const sessions = createSessionsHarness("main", [...threadKeys, ...categoryKeys]);
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list fixture");
    }
    for (const row of result.sessions) {
      if (categoryKeys.includes(row.key)) {
        row.category = "Alpha";
      }
    }
    sessions.publish({ groups: ["Alpha"] });
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);
    const category = sidebar.querySelector('[data-session-section="category:Alpha"]');
    const threads = sidebar.querySelector('[data-session-section="ungrouped"]');

    expect(category?.querySelectorAll(".sidebar-recent-session")).toHaveLength(10);
    expect(threads?.querySelectorAll(".sidebar-recent-session")).toHaveLength(10);
    expect(threads?.querySelector(".sidebar-recent-sessions__label-text")?.textContent).toBe(
      "Other",
    );
    expect(category?.querySelector('[aria-label="Show more"]')).not.toBeNull();
    expect(threads?.querySelector('[aria-label="Show more"]')).not.toBeNull();
    expect(sidebar.querySelectorAll(".sidebar-session-pagination")).toHaveLength(2);

    threads?.querySelector<HTMLButtonElement>('[aria-label="Show more"]')?.click();
    await sidebar.updateComplete;

    expect(category?.querySelectorAll(".sidebar-recent-session")).toHaveLength(10);
    expect(threads?.querySelectorAll(".sidebar-recent-session")).toHaveLength(12);
    expect(category?.querySelector('[aria-label="Show more"]')).not.toBeNull();
    expect(threads?.querySelector('[aria-label="Show more"]')).toBeNull();
  });

  it("keeps global session actions when every unpinned thread has a custom group", async () => {
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:research",
      "agent:main:operations",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected categorized session fixtures");
    }
    for (const row of result.sessions) {
      if (row.key === "agent:main:research") {
        row.category = "Research";
      }
      if (row.key === "agent:main:operations") {
        row.category = "Operations";
      }
    }
    harness.publish({ groups: ["Research", "Operations"] });

    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    const threads = sidebar.querySelector('[data-session-section="ungrouped"]');

    expect(sidebar.querySelector('[data-session-section="category:Research"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-section="category:Operations"]')).not.toBeNull();
    expect(threads).toBeNull();

    const toolbar = sidebar.querySelector(".sidebar-session-toolbar");
    expect(toolbar?.querySelector(".sidebar-recent-sessions__label-text")?.textContent).toBe(
      "Sessions",
    );
    const filter = toolbar?.querySelector<HTMLButtonElement>(".sidebar-session-sort");
    expect(filter).not.toBeNull();
    expect(filter?.getAttribute("aria-label")).toBe("Filter & sort");
    expect(toolbar?.querySelector('[aria-label="New session"]')).not.toBeNull();
    filter?.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).not.toBeNull();
  });

  it("renders a lone ungrouped list without a header despite stale collapsed state", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", "agent:main:other"]),
    );

    sidebar.sessionOrganizer.saveCollapsedSessionSections(new Set(["ungrouped"]));
    await sidebar.updateComplete;

    const ungrouped = sidebar.querySelector('[data-session-section="ungrouped"]');
    expect(ungrouped?.querySelector(".sidebar-recent-sessions__head")).toBeNull();
    expect(ungrouped?.querySelector('[data-session-key="agent:main:other"]')).not.toBeNull();
  });

  it("marks the toolbar filter when the status is not active", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", "agent:main:other"]),
    );
    const filter = sidebar.querySelector<HTMLButtonElement>(
      ".sidebar-session-toolbar .sidebar-session-sort",
    );
    expect(filter?.getAttribute("aria-label")).toBe("Filter & sort");
    expect(filter?.classList.contains("sidebar-session-sort--filtered")).toBe(false);

    filter?.click();
    await sidebar.updateComplete;
    sidebar.querySelector(".sidebar-session-sort-menu")?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: "status:all" } },
      }),
    );
    await sidebar.updateComplete;

    expect(filter?.classList.contains("sidebar-session-sort--filtered")).toBe(true);
  });

  it("hides empty Other at rest but keeps empty categories and the drag drop target", async () => {
    const harness = createSessionsHarness("main", ["agent:main:main", "agent:main:alpha"]);
    const result = harness.sessions.state.result;
    const alpha = result?.sessions.find((row) => row.key === "agent:main:alpha");
    if (!alpha) {
      throw new Error("expected Alpha session fixture");
    }
    alpha.category = "Alpha";
    alpha.pinned = true;
    harness.publish({ groups: ["Empty", "Alpha"] });
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);

    // Empty user-created groups stay visible (creation and drag targets);
    // only the bare Other header disappears while nothing lives in it.
    const emptyCategory = sidebar.querySelector('[data-session-section="category:Empty"]');
    const emptyCategoryHeader = emptyCategory?.querySelector(
      ":scope > .sidebar-recent-sessions__head",
    );
    expect(emptyCategory).not.toBeNull();
    expect(emptyCategoryHeader).not.toBeNull();
    expect(emptyCategory?.querySelector(".sidebar-session-group-toggle")?.textContent).toContain(
      "Empty",
    );
    expect(emptyCategory?.querySelector(".sidebar-session-empty-hint")).toBeNull();
    expect(emptyCategory?.querySelector(".sidebar-recent-sessions__list")).toBeNull();
    expect(emptyCategory?.children).toHaveLength(1);
    expect(emptyCategory?.firstElementChild).toBe(emptyCategoryHeader);
    expect(sidebar.querySelector('[data-session-section="ungrouped"]')).toBeNull();

    sidebar.sessionOrganizer.draggingSessionKey = "agent:main:alpha";
    sidebar.requestUpdate();
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-session-section="ungrouped"]')).not.toBeNull();
  });

  it("renders no chat rows when only the main session exists", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    await sidebar.updateComplete;

    // The identity card is the main-session entry; the list stays empty.
    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(0);
    expect(sidebar.querySelector("openclaw-sidebar-agent-card")).not.toBeNull();
  });

  it("keeps a selected child reachable when its parent is outside the loaded window", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:child"]);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:child",
            spawnedBy: "agent:main:missing-parent",
            kind: "direct",
            label: "Reachable orphan",
            updatedAt: 2,
            status: "done",
          },
        ],
      },
    });
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = "agent:main:child";
    await sidebar.updateComplete;

    const row = sidebar.querySelector('[data-session-key="agent:main:child"]');
    expect(row?.textContent).toContain("Reachable orphan");
    expect(row?.classList.contains("sidebar-recent-session--child")).toBe(false);
  });
});
