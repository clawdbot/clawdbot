import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
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
    sidebar.connected = true;
    harness.publish({
      groups: ["Alpha"],
      sectionOrder: ["category:Alpha", "ungrouped", "groups", "work"],
    });
    await sidebar.updateComplete;
    return { sidebar, harness, gatewayHarness };
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
    const { sidebar, harness } = await mountCollapsedGroup({
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
    promptSpy.mockRestore();
  });

  it("rewrites collapsed keys only after group rename succeeds", async () => {
    const { sidebar, harness } = await mountCollapsedGroup({
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
    const { sidebar, harness } = await mountCollapsedGroup({
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
    confirmSpy.mockRestore();
  });

  it("drops collapsed keys only after group delete succeeds", async () => {
    const { sidebar, harness } = await mountCollapsedGroup({
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
    confirmSpy.mockRestore();
  });

  it("disables only group actions whose exact method is unavailable", async () => {
    const { sidebar, harness, gatewayHarness } = await mountCollapsedGroup({});
    gatewayHarness.publish({
      hello: {
        auth: { role: "operator", scopes: ["operator.write"] },
        features: { methods: ["sessions.groups.put"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await sidebar.updateComplete;
    const menu = await openGroupMenu(sidebar);
    const dropdown = menu.closest("wa-dropdown");
    const rename = menu.querySelector<HTMLElement>('[value="rename-group"]');
    const create = menu.querySelector<HTMLElement>('[value="new-group"]');
    const remove = menu.querySelector<HTMLElement>('[value="delete-group"]');

    expect(rename?.hasAttribute("disabled")).toBe(true);
    expect(create?.hasAttribute("disabled")).toBe(false);
    expect(remove?.hasAttribute("disabled")).toBe(true);

    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        cancelable: true,
        detail: { item: { value: "rename-group" } },
      }),
    );
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        cancelable: true,
        detail: { item: { value: "delete-group" } },
      }),
    );

    expect(harness.groupsRename).not.toHaveBeenCalled();
    expect(harness.groupsDelete).not.toHaveBeenCalled();
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
    sidebar.connected = true;
    harness.publish({ groups });
    await sidebar.updateComplete;
    return { sidebar, harness };
  }

  function section(sidebar: SidebarLifecycleState, sectionId: string): Element {
    const element = sidebar.querySelector(`[data-session-section="${sectionId}"]`);
    if (!element) {
      throw new Error(`expected section ${sectionId}`);
    }
    return element;
  }

  function renderedSectionIds(sidebar: SidebarLifecycleState): string[] {
    return Array.from(sidebar.querySelectorAll<HTMLElement>("[data-session-section]")).flatMap(
      (element) => (element.dataset.sessionSection ? [element.dataset.sessionSection] : []),
    );
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
    const { sidebar, harness } = await mountWithGroups(["Alpha", "Beta"]);

    await dropGroupBeforeCoding(sidebar, "Beta");

    await waitForFast(() =>
      expect(harness.groupsPut).toHaveBeenCalledWith(
        ["Alpha", "Beta"],
        ["category:Alpha", "ungrouped", "groups", "category:Beta", "work"],
      ),
    );
  });

  it("also updates catalog order when a group crosses another group on its way to Coding", async () => {
    const { sidebar, harness } = await mountWithGroups(["Alpha", "Beta"]);

    await dropGroupBeforeCoding(sidebar, "Alpha");

    await waitForFast(() =>
      expect(harness.groupsPut).toHaveBeenCalledWith(
        ["Beta", "Alpha"],
        ["category:Beta", "ungrouped", "groups", "category:Alpha", "work"],
      ),
    );
  });

  it("does not persist cross-group ordering when the catalog update fails", async () => {
    const { sidebar, harness } = await mountWithGroups(["Alpha", "Beta"]);
    const before = renderedSectionIds(sidebar);
    harness.groupsPut.mockRejectedValue(new Error("catalog update failed"));

    await dropGroupBeforeCoding(sidebar, "Alpha");

    await waitForFast(() =>
      expect(harness.groupsPut).toHaveBeenCalledWith(
        ["Beta", "Alpha"],
        ["category:Beta", "ungrouped", "groups", "category:Alpha", "work"],
      ),
    );
    await Promise.resolve();
    await sidebar.updateComplete;
    expect(renderedSectionIds(sidebar)).toEqual(before);
  });
});
