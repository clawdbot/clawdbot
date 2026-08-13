import { describe, expect, it } from "vitest";
import { canonicalUiSessionKeyForPersistence } from "../../lib/sessions/session-key.ts";
import {
  normalizeSidebarSessionActivePanels,
  normalizeSidebarSessionLayouts,
  type SidebarSessionLayouts,
  updateSidebarSessionActivePanel,
  updateSidebarSessionLayout,
} from "./sidebar-layout-persistence.ts";
import { openSlot } from "./sidebar-layout.ts";

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
      main: openSlot({ columns: [] }, "detail"),
      broken: { columns: [] },
    });
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
