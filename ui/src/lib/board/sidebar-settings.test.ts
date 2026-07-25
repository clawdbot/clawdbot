import { describe, expect, it } from "vitest";
import { openSlot } from "../../pages/chat/sidebar-layout.ts";
import { canonicalUiSessionKeyForPersistence } from "../sessions/session-key.ts";
import {
  normalizeSidebarSessionLayouts,
  type SidebarSessionLayouts,
  updateSidebarSessionLayout,
} from "./settings.ts";

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
});
