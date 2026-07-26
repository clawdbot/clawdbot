import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SessionGroupMutationResult,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

function createDataTransferStub() {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "none",
    dropEffect: "none",
  };
}

function dispatchDragEvent(
  target: Element,
  type: "dragstart" | "dragover" | "drop",
  dataTransfer: ReturnType<typeof createDataTransferStub>,
  clientY = 0,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientY: { value: clientY },
  });
  target.dispatchEvent(event);
}

describe("AppSidebar group mutation collapsed state", () => {
  const COLLAPSED_STORAGE_KEY = "openclaw:sidebar:sessions:collapsed-sections";

  async function mountCollapsedGroup(options: {
    groupsRename?: () => Promise<SessionGroupMutationResult>;
    groupsDelete?: () => Promise<SessionGroupMutationResult>;
  }) {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(["category:Alpha"]));
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:main", "agent:main:alpha"]);
    const alpha = harness.sessions.state.result?.sessions.find(
      (row) => row.key === "agent:main:alpha",
    );
    if (!alpha) {
      throw new Error("expected Alpha session fixture");
    }
    alpha.category = "Alpha";
    if (options.groupsRename) {
      harness.groupsRename.mockImplementation(options.groupsRename);
    }
    if (options.groupsDelete) {
      harness.groupsDelete.mockImplementation(options.groupsDelete);
    }
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, harness.sessions);
    const onUpdateSessionSectionOrder = vi.fn();
    sidebar.sessionSectionOrder = ["category:Alpha", "ungrouped", "groups", "work"];
    sidebar.onUpdateSessionSectionOrder = onUpdateSessionSectionOrder;
    sidebar.connected = true;
    harness.publish({ groups: ["Alpha"] });
    await sidebar.updateComplete;
    return { sidebar, harness, gatewayHarness, onUpdateSessionSectionOrder };
  }

  async function openGroupMenu(sidebar: SidebarLifecycleState) {
    const actions = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-section="category:Alpha"] .sidebar-session-group-actions',
    );
    if (!actions) {
      throw new Error("expected group actions trigger");
    }
    actions.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector(".sidebar-session-group-menu");
    if (!menu) {
      throw new Error("expected group menu");
    }
    return menu;
  }

  it("keeps collapsed keys when group rename is rejected", async () => {
    const { sidebar, harness, onUpdateSessionSectionOrder } = await mountCollapsedGroup({
      groupsRename: () => Promise.reject(new Error("rename failed")),
    });
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Beta");
    const menu = await openGroupMenu(sidebar);
    const rename = menu.querySelectorAll<HTMLButtonElement>(".session-menu__item")[0];
    rename?.click();
    await waitForFast(() => expect(harness.groupsRename).toHaveBeenCalledWith("Alpha", "Beta"));
    await Promise.resolve();
    await Promise.resolve();

    expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe(JSON.stringify(["category:Alpha"]));
    expect(onUpdateSessionSectionOrder).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("rewrites collapsed keys only after group rename succeeds", async () => {
    const { sidebar, harness, onUpdateSessionSectionOrder } = await mountCollapsedGroup({
      groupsRename: () => Promise.resolve("completed"),
    });
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Beta");
    const menu = await openGroupMenu(sidebar);
    menu.querySelectorAll<HTMLButtonElement>(".session-menu__item")[0]?.click();
    await waitForFast(() => expect(harness.groupsRename).toHaveBeenCalledWith("Alpha", "Beta"));
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? "[]")).toEqual([
      "category:Beta",
    ]);
    expect(onUpdateSessionSectionOrder).toHaveBeenCalledWith([
      "category:Beta",
      "ungrouped",
      "groups",
      "work",
    ]);
    promptSpy.mockRestore();
  });

  it("ignores a stale group rename after its Gateway reconnects with the same client", async () => {
    let resolveRename!: (result: SessionGroupMutationResult) => void;
    const rename = new Promise<SessionGroupMutationResult>((resolve) => {
      resolveRename = resolve;
    });
    const { sidebar, harness, gatewayHarness } = await mountCollapsedGroup({
      groupsRename: () => rename,
    });
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Beta");
    const menu = await openGroupMenu(sidebar);
    menu.querySelectorAll<HTMLButtonElement>(".session-menu__item")[0]?.click();
    await waitForFast(() => expect(harness.groupsRename).toHaveBeenCalledWith("Alpha", "Beta"));

    gatewayHarness.publish({ phase: "stopped" });
    gatewayHarness.publish({ phase: "connected" });
    resolveRename("stale");
    await Promise.resolve();
    await Promise.resolve();

    expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe(JSON.stringify(["category:Alpha"]));
    promptSpy.mockRestore();
  });

  it("keeps collapsed keys when group delete is rejected", async () => {
    const { sidebar, harness, onUpdateSessionSectionOrder } = await mountCollapsedGroup({
      groupsDelete: () => Promise.reject(new Error("delete failed")),
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const menu = await openGroupMenu(sidebar);
    const items = menu.querySelectorAll<HTMLButtonElement>(".session-menu__item");
    items[items.length - 1]?.click();
    await waitForFast(() => expect(harness.groupsDelete).toHaveBeenCalledWith("Alpha"));
    await Promise.resolve();
    await Promise.resolve();

    expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe(JSON.stringify(["category:Alpha"]));
    expect(onUpdateSessionSectionOrder).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("drops collapsed keys only after group delete succeeds", async () => {
    const { sidebar, harness, onUpdateSessionSectionOrder } = await mountCollapsedGroup({
      groupsDelete: () => Promise.resolve("completed"),
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const menu = await openGroupMenu(sidebar);
    const items = menu.querySelectorAll<HTMLButtonElement>(".session-menu__item");
    items[items.length - 1]?.click();
    await waitForFast(() => expect(harness.groupsDelete).toHaveBeenCalledWith("Alpha"));
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? "[]")).toEqual([]);
    expect(onUpdateSessionSectionOrder).toHaveBeenCalledWith(["ungrouped", "groups", "work"]);
    confirmSpy.mockRestore();
  });
});

describe("AppSidebar group section ordering", () => {
  async function mountWithGroups(groups: string[]) {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:work",
      ...groups.map((_, index) => `agent:main:group-${index}`),
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected grouped session fixtures");
    }
    const work = result.sessions.find((row) => row.key === "agent:main:work");
    if (!work) {
      throw new Error("expected Coding session fixture");
    }
    work.worktree = { id: "work", branch: "test", repoRoot: "/repo" };
    for (const [index, group] of groups.entries()) {
      const row = result.sessions.find((entry) => entry.key === `agent:main:group-${index}`);
      if (!row) {
        throw new Error(`expected session fixture for ${group}`);
      }
      row.category = group;
    }
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, harness.sessions);
    const onUpdateSessionSectionOrder = vi.fn();
    sidebar.sessionSectionOrder = [];
    sidebar.onUpdateSessionSectionOrder = onUpdateSessionSectionOrder;
    sidebar.connected = true;
    harness.publish({ groups });
    await sidebar.updateComplete;
    return { sidebar, harness, onUpdateSessionSectionOrder };
  }

  function section(sidebar: SidebarLifecycleState, sectionId: string): Element {
    const element = sidebar.querySelector(`[data-session-section="${sectionId}"]`);
    if (!element) {
      throw new Error(`expected section ${sectionId}`);
    }
    return element;
  }

  function groupHeader(sidebar: SidebarLifecycleState, group: string): Element {
    const header = section(sidebar, `category:${group}`).querySelector(
      ".sidebar-recent-sessions__head",
    );
    if (!header) {
      throw new Error(`expected group header for ${group}`);
    }
    return header;
  }

  async function dropGroupBeforeCoding(sidebar: SidebarLifecycleState, group: string) {
    const dataTransfer = createDataTransferStub();
    dispatchDragEvent(groupHeader(sidebar, group), "dragstart", dataTransfer);
    const coding = section(sidebar, "work");
    dispatchDragEvent(coding, "dragover", dataTransfer, -1);
    dispatchDragEvent(coding, "drop", dataTransfer, -1);
    await sidebar.updateComplete;
  }

  it("persists a group dropped before Coding without rewriting unchanged catalog order", async () => {
    const { sidebar, harness, onUpdateSessionSectionOrder } = await mountWithGroups([
      "Alpha",
      "Beta",
    ]);

    await dropGroupBeforeCoding(sidebar, "Beta");

    await waitForFast(() =>
      expect(onUpdateSessionSectionOrder).toHaveBeenCalledWith([
        "category:Alpha",
        "ungrouped",
        "groups",
        "category:Beta",
        "work",
      ]),
    );
    expect(harness.groupsPut).not.toHaveBeenCalled();
  });

  it("also updates catalog order when a group crosses another group on its way to Coding", async () => {
    const { sidebar, harness, onUpdateSessionSectionOrder } = await mountWithGroups([
      "Alpha",
      "Beta",
    ]);

    await dropGroupBeforeCoding(sidebar, "Alpha");

    await waitForFast(() =>
      expect(onUpdateSessionSectionOrder).toHaveBeenCalledWith([
        "category:Beta",
        "ungrouped",
        "groups",
        "category:Alpha",
        "work",
      ]),
    );
    await waitForFast(() => expect(harness.groupsPut).toHaveBeenCalledWith(["Beta", "Alpha"]));
  });

  it("does not persist cross-group ordering when the catalog update fails", async () => {
    const { sidebar, harness, onUpdateSessionSectionOrder } = await mountWithGroups([
      "Alpha",
      "Beta",
    ]);
    harness.groupsPut.mockRejectedValue(new Error("catalog update failed"));

    await dropGroupBeforeCoding(sidebar, "Alpha");

    await waitForFast(() => expect(harness.groupsPut).toHaveBeenCalledWith(["Beta", "Alpha"]));
    await Promise.resolve();
    expect(onUpdateSessionSectionOrder).not.toHaveBeenCalled();
  });
});
