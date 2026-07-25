import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGateway,
  createSessions,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar session section visibility", () => {
  it("renders an active draft first inside an expanded empty Threads section", async () => {
    localStorage.setItem(
      "openclaw:sidebar:sessions:collapsed-sections",
      JSON.stringify(["ungrouped"]),
    );
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const draftSidebar = sidebar as SidebarLifecycleState & { draftSessionAgentId: string };
    draftSidebar.draftSessionAgentId = "main";
    draftSidebar.requestUpdate();
    await draftSidebar.updateComplete;

    const section = draftSidebar.querySelector('[data-session-section="ungrouped"]');
    const list = section?.querySelector(".sidebar-recent-sessions__list");
    expect(section).not.toBeNull();
    expect(
      section?.querySelector(".sidebar-session-group-toggle")?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(list?.firstElementChild?.classList.contains("sidebar-recent-session--draft")).toBe(true);
    expect(list?.querySelector(".sidebar-recent-session--draft")?.textContent?.trim()).toBe(
      "New thread",
    );
    expect(
      list?.querySelectorAll(".sidebar-recent-session:not(.sidebar-recent-session--draft)"),
    ).toHaveLength(0);

    // The draft expands the section for real, so the header toggle keeps
    // working: collapsing during a draft hides it and persists honestly.
    section?.querySelector<HTMLButtonElement>(".sidebar-session-group-toggle")?.click();
    await draftSidebar.updateComplete;
    expect(
      draftSidebar
        .querySelector('[data-session-section="ungrouped"] .sidebar-session-group-toggle')
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(draftSidebar.querySelector(".sidebar-recent-session--draft")).toBeNull();
  });

  it("keeps normal pagination when a draft overrides collapsed Threads", async () => {
    localStorage.setItem(
      "openclaw:sidebar:sessions:collapsed-sections",
      JSON.stringify(["ungrouped"]),
    );
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", [
        "agent:main:main",
        ...Array.from({ length: 12 }, (_, index) => `agent:main:thread-${index}`),
      ]),
    );
    const draftSidebar = sidebar as SidebarLifecycleState & { draftSessionAgentId: string };
    draftSidebar.draftSessionAgentId = "main";
    draftSidebar.requestUpdate();
    await draftSidebar.updateComplete;

    const section = draftSidebar.querySelector('[data-session-section="ungrouped"]');
    expect(
      section?.querySelectorAll(".sidebar-recent-session:not(.sidebar-recent-session--draft)"),
    ).toHaveLength(10);
    expect(draftSidebar.querySelector('[aria-label="Show more"]')).not.toBeNull();
  });

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

  it("hides empty Threads at rest but keeps empty categories and the drag drop target", async () => {
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
    // only the bare Threads header disappears while nothing lives in it.
    expect(sidebar.querySelector('[data-session-section="category:Empty"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-section="ungrouped"]')).toBeNull();

    sidebar.sessionOrganizer.draggingSessionKey = "agent:main:alpha";
    sidebar.requestUpdate();
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-session-section="ungrouped"]')).not.toBeNull();
  });
});
