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
    harness.publish({ groups: ["Alpha"] });
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
});
