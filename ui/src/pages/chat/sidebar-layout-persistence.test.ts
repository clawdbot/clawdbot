import { describe, expect, it } from "vitest";
import { canonicalUiSessionKeyForPersistence } from "../../lib/sessions/session-key.ts";
import {
  normalizeSidebarSessionActivePanels,
  normalizeSidebarSessionLayouts,
  type SidebarSessionLayouts,
  updateSidebarSessionActivePanel,
  updateSidebarSessionLayout,
} from "./sidebar-layout-persistence.ts";
import {
  activatePanel,
  openSlot,
  resizeSidebarPanel,
  setSidebarExpanded,
  setSidebarOpen,
} from "./sidebar-layout.ts";

describe("sidebar session layout settings", () => {
  it("uses one persistence key for configured main-session aliases", () => {
    const host = {
      agentsList: { defaultId: "main", mainKey: "main" },
      hello: {
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "agent:main:current",
          },
        },
      },
    } as never;
    expect(canonicalUiSessionKeyForPersistence(host, "main")).toBe("agent:main:current");
    expect(canonicalUiSessionKeyForPersistence(host, "agent:main:main")).toBe("agent:main:current");
  });

  it("normalizes every persisted session layout", () => {
    expect(
      normalizeSidebarSessionLayouts({
        main: openSlot({ columns: [] }, "detail"),
        broken: { columns: "nope" },
        "": openSlot({ columns: [] }, "discussion"),
      }),
    ).toEqual({
      main: { ...openSlot({ columns: [] }, "detail"), dock: "right", expanded: false },
      broken: { columns: [], open: false, expanded: false },
    });
  });

  it("persists tab order, active tab, width, visibility, and expanded state per session", () => {
    let layout = openSlot(openSlot({ columns: [] }, "workspace"), "terminal");
    layout = activatePanel(layout, layout.columns[0]!.panels[0]!.id);
    layout = resizeSidebarPanel(layout, layout.columns[0]!.id, 512);
    layout = setSidebarExpanded(layout, true);
    layout = setSidebarOpen(layout, false);

    const persisted = updateSidebarSessionLayout({}, "main", layout).main;
    expect(persisted).toEqual({ ...layout, dock: "right" });
    expect(persisted?.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "workspace",
      "terminal",
    ]);
    expect(persisted?.columns[0]?.activePanelId).toBe("workspace");
    expect(persisted?.columns[0]?.width).toBe(512);
    expect(persisted).toMatchObject({ open: false, expanded: true });
  });

  it("caps the newest session layouts", () => {
    let layouts: SidebarSessionLayouts = {};
    for (let index = 0; index < 55; index += 1) {
      layouts = updateSidebarSessionLayout(
        layouts,
        `session-${index}`,
        openSlot({ columns: [] }, "discussion"),
      );
    }
    expect(Object.keys(layouts)).toHaveLength(50);
    expect(layouts["session-0"]).toBeUndefined();
    expect(layouts["session-54"]).toBeDefined();
  });

  it("normalizes and caps collapsed active-panel selections", () => {
    let selections = normalizeSidebarSessionActivePanels({
      main: " discussion ",
      broken: 42,
      "": "detail",
    });
    expect(selections).toEqual({ main: "discussion" });

    for (let index = 0; index < 55; index += 1) {
      selections = updateSidebarSessionActivePanel(
        selections,
        `session-${index}`,
        `panel-${index}`,
      );
    }
    expect(Object.keys(selections)).toHaveLength(50);
    expect(selections["session-0"]).toBeUndefined();
    expect(selections["session-54"]).toBe("panel-54");
  });
});
