/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "../../app/settings.ts";
import { migrateLegacyDockVisibility } from "./sidebar-layout-legacy-migration.ts";
import { openSlot } from "./sidebar-layout.ts";

describe("legacy dock visibility migration", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("moves shipped open docks into only the current session", () => {
    localStorage.setItem("openclaw.browser.panel.v1", JSON.stringify({ open: true }));
    localStorage.setItem("openclaw.desktopPanel", JSON.stringify({ open: true }));

    const migrated = migrateLegacyDockVisibility({
      settings: loadSettings(),
      sessionKey: "agent:main:current",
      browserAvailable: true,
      desktopAvailable: true,
    });

    expect(
      migrated.sidebarSessionLayouts?.["agent:main:current"]?.columns[0]?.panels.map(
        (panel) => panel.slot,
      ),
    ).toEqual(["browser", "desktop"]);
    const second = migrateLegacyDockVisibility({
      settings: migrated,
      sessionKey: "agent:main:unrelated",
      browserAvailable: true,
      desktopAvailable: true,
    });
    expect(second.sidebarSessionLayouts?.["agent:main:unrelated"]).toBeUndefined();
  });

  it("preserves an existing per-session layout and marks migration consumed", () => {
    const settings = {
      ...loadSettings(),
      sidebarSessionLayouts: {
        "agent:main:current": openSlot({ columns: [] }, "workspace"),
      },
    };
    localStorage.setItem("openclaw.browser.panel.v1", JSON.stringify({ open: true }));

    const migrated = migrateLegacyDockVisibility({
      settings,
      sessionKey: "agent:main:current",
      browserAvailable: true,
      desktopAvailable: true,
    });

    expect(
      migrated.sidebarSessionLayouts?.["agent:main:current"]?.columns[0]?.panels.map(
        (panel) => panel.slot,
      ),
    ).toEqual(["workspace"]);
    expect(
      migrateLegacyDockVisibility({
        settings: migrated,
        sessionKey: "agent:main:other",
        browserAvailable: true,
        desktopAvailable: true,
      }).sidebarSessionLayouts?.["agent:main:other"],
    ).toBeUndefined();
  });

  it("does not seed a tab from shipped closed docks", () => {
    localStorage.setItem("openclaw.browser.panel.v1", JSON.stringify({ open: false }));
    localStorage.setItem("openclaw.desktopPanel", JSON.stringify({ open: false }));

    const migrated = migrateLegacyDockVisibility({
      settings: loadSettings(),
      sessionKey: "agent:main:current",
      browserAvailable: true,
      desktopAvailable: true,
    });

    expect(migrated.sidebarSessionLayouts?.["agent:main:current"]).toBeUndefined();
  });
});
