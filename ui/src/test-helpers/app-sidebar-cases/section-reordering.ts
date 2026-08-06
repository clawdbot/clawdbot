import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
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
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
}

describe("AppSidebar section reordering", () => {
  async function mountWithGroups(
    groups: string[],
    sectionOrder: string[] = [],
    options: { withCatalog?: boolean; scopes?: string[] } = {},
  ) {
    const request = vi
      .fn()
      .mockResolvedValue(catalogPage([{ threadId: "thread-codex", name: "Codex thread" }]));
    const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    if (options.withCatalog || options.scopes) {
      gateway.publish({
        hello: {
          ...(options.scopes ? { auth: { role: "operator", scopes: options.scopes } } : {}),
          features: {
            methods: [
              ...(options.withCatalog ? ["sessions.catalog.list"] : []),
              "sessions.groups.put",
            ],
          },
        } as ApplicationGatewaySnapshot["hello"],
      });
    }
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:plain",
      "agent:main:thread",
      "agent:main:builtin-group",
      ...groups.map((_, index) => `agent:main:group-${index}`),
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected grouped session fixtures");
    }
    const codingRow = result.sessions.find((entry) => entry.key === "agent:main:thread");
    if (!codingRow) {
      throw new Error("expected coding session fixture");
    }
    codingRow.worktree = { id: "worktree-1", branch: "feature", repoRoot: "/repo" };
    const builtinGroupRow = result.sessions.find(
      (entry) => entry.key === "agent:main:builtin-group",
    );
    if (!builtinGroupRow) {
      throw new Error("expected built-in group session fixture");
    }
    builtinGroupRow.kind = "group";
    for (const [index, group] of groups.entries()) {
      const row = result.sessions.find((entry) => entry.key === `agent:main:group-${index}`);
      if (!row) {
        throw new Error(`expected session fixture for ${group}`);
      }
      row.category = group;
    }
    const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
    sidebar.connected = true;
    harness.publish({ groups, sectionOrder });
    await sidebar.updateComplete;
    if (options.withCatalog) {
      await waitForFast(() =>
        expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).not.toBeNull(),
      );
    }
    return { sidebar, harness };
  }

  function groupHeader(sidebar: SidebarLifecycleState, sectionId: string) {
    const header = sidebar.querySelector(
      `[data-session-section="${sectionId}"] .sidebar-recent-sessions__head`,
    );
    if (!header) {
      throw new Error(`expected header for section ${sectionId}`);
    }
    return header;
  }

  it("marks every section header draggable and renders a grip", async () => {
    const { sidebar } = await mountWithGroups(["Alpha", "Beta"], [], { withCatalog: true });

    expect(groupHeader(sidebar, "category:Alpha").getAttribute("draggable")).toBe("true");
    expect(groupHeader(sidebar, "ungrouped").getAttribute("draggable")).toBe("true");
    expect(groupHeader(sidebar, "groups").getAttribute("draggable")).toBe("true");
    expect(groupHeader(sidebar, "work").getAttribute("draggable")).toBe("true");
    expect(groupHeader(sidebar, "catalog:codex").getAttribute("draggable")).toBe("true");
    const codingSection = sidebar.querySelector('[data-session-section="work"]');
    const catalogSection = sidebar.querySelector('[data-session-section="catalog:codex"]');
    expect(catalogSection?.parentElement).toBe(codingSection?.parentElement);
    expect(catalogSection?.previousElementSibling).toBe(codingSection);
    for (const sectionId of [
      "category:Alpha",
      "category:Beta",
      "ungrouped",
      "groups",
      "work",
      "catalog:codex",
    ]) {
      expect(
        groupHeader(sidebar, sectionId).querySelector(".sidebar-session-group-drag-handle"),
      ).not.toBeNull();
    }
  });

  it("disables section and row dragging without group write access", async () => {
    const { sidebar, harness } = await mountWithGroups(["Alpha"], [], {
      scopes: ["operator.read"],
    });
    const header = groupHeader(sidebar, "category:Alpha");
    const row = sidebar.querySelector('[data-session-key="agent:main:plain"]');

    expect(header.getAttribute("draggable")).toBe("false");
    expect(header.getAttribute("title")).toBeTruthy();
    expect(row?.getAttribute("draggable")).toBe("false");
    expect(row?.getAttribute("title")).toBeTruthy();

    const dataTransfer = createDataTransferStub();
    dispatchDragEvent(header, "dragstart", dataTransfer);
    const threadsSection = sidebar.querySelector('[data-session-section="ungrouped"]');
    if (!threadsSection) {
      throw new Error("expected Threads section");
    }
    dispatchDragEvent(threadsSection, "drop", dataTransfer);

    expect(dataTransfer.types).toEqual([]);
    expect(harness.groupsPut).not.toHaveBeenCalled();
  });

  it("does not start a section drag from a header action button", async () => {
    const { sidebar } = await mountWithGroups([]);
    const dataTransfer = createDataTransferStub();
    const newSessionButton = groupHeader(sidebar, "ungrouped").querySelector(
      ".sidebar-new-session",
    );
    if (!newSessionButton) {
      throw new Error("expected new-session header action");
    }

    newSessionButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    dispatchDragEvent(groupHeader(sidebar, "ungrouped"), "dragstart", dataTransfer);

    expect(dataTransfer.types).toEqual([]);
    expect(sidebar.sessionOrganizer.draggingSidebarSection).toBeNull();
  });

  it("persists the new catalog order when a group header drops onto another group", async () => {
    const { sidebar, harness } = await mountWithGroups(["Alpha", "Beta", "Gamma"]);
    const dataTransfer = createDataTransferStub();

    dispatchDragEvent(groupHeader(sidebar, "category:Gamma"), "dragstart", dataTransfer);
    const alphaSection = sidebar.querySelector('[data-session-section="category:Alpha"]');
    if (!alphaSection) {
      throw new Error("expected Alpha section");
    }
    dispatchDragEvent(alphaSection, "drop", dataTransfer);

    await waitForFast(() =>
      expect(harness.groupsPut).toHaveBeenCalledWith(
        ["Gamma", "Alpha", "Beta"],
        ["category:Gamma", "category:Alpha", "category:Beta", "ungrouped", "groups", "work"],
      ),
    );
  });

  it("persists a built-in section move with the full section order", async () => {
    const { sidebar, harness } = await mountWithGroups([]);
    const dataTransfer = createDataTransferStub();

    dispatchDragEvent(groupHeader(sidebar, "work"), "dragstart", dataTransfer);
    const threadsSection = sidebar.querySelector('[data-session-section="ungrouped"]');
    if (!threadsSection) {
      throw new Error("expected Threads section");
    }
    dispatchDragEvent(threadsSection, "drop", dataTransfer);

    await waitForFast(() =>
      expect(harness.groupsPut).toHaveBeenCalledWith([], ["work", "ungrouped", "groups"]),
    );
  });

  it("preserves saved catalog slots while the first catalog load is pending", async () => {
    const { sidebar, harness } = await mountWithGroups(
      [],
      ["ungrouped", "groups", "work", "catalog:codex"],
    );
    const dataTransfer = createDataTransferStub();

    dispatchDragEvent(groupHeader(sidebar, "work"), "dragstart", dataTransfer);
    const threadsSection = sidebar.querySelector('[data-session-section="ungrouped"]');
    if (!threadsSection) {
      throw new Error("expected Threads section");
    }
    dispatchDragEvent(threadsSection, "drop", dataTransfer);

    await waitForFast(() =>
      expect(harness.groupsPut).toHaveBeenCalledWith(
        [],
        ["work", "ungrouped", "groups", "catalog:codex"],
      ),
    );
  });

  it("persists a catalog section move relative to Coding", async () => {
    const { sidebar, harness } = await mountWithGroups([], [], { withCatalog: true });
    const dataTransfer = createDataTransferStub();

    dispatchDragEvent(groupHeader(sidebar, "catalog:codex"), "dragstart", dataTransfer);
    const codingSection = sidebar.querySelector('[data-session-section="work"]');
    if (!codingSection) {
      throw new Error("expected Coding section");
    }
    dispatchDragEvent(codingSection, "drop", dataTransfer);

    await waitForFast(() =>
      expect(harness.groupsPut).toHaveBeenCalledWith(
        [],
        ["ungrouped", "groups", "catalog:codex", "work"],
      ),
    );
  });
});
