import { describe, expect, it } from "vitest";
import {
  buildSidebarCustomizerEntries,
  buildSidebarCustomizerSections,
} from "./app-sidebar-customizer.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-navigation-logic.ts";

describe("sidebar customizer model", () => {
  it("keeps Home fixed and orders visible pages before hidden pages", () => {
    const items = buildSidebarCustomizerEntries({
      canonical: ["route:tasks", "route:cron"],
      enabledRouteIds: ["cron", "tasks", "plugins"],
      workboards: [],
    });

    expect(items.map((item) => item.id)).toEqual([
      "fixed:home",
      "route:tasks",
      "route:cron",
      "route:plugins",
    ]);
    expect(items[0]).toMatchObject({ reorderable: false, toggleable: false, visible: true });
    expect(items.map((item) => item.visible)).toEqual([true, true, true, false]);
  });

  it("only exposes visibility for catalogs with an existing persistence owner", () => {
    const sections = [
      {
        id: "ungrouped",
        rows: [],
        totalRowCount: 0,
        visibleRowCount: 0,
        visibleLimit: 25,
        collapsedVisibleRowCount: 0,
      },
      {
        id: "work",
        work: true,
        rows: [],
        totalRowCount: 0,
        visibleRowCount: 0,
        visibleLimit: 25,
        collapsedVisibleRowCount: 0,
      },
      {
        id: "catalog:claude",
        rows: [],
        totalRowCount: 0,
        visibleRowCount: 0,
        visibleLimit: 25,
        collapsedVisibleRowCount: 0,
      },
    ] as SidebarVisibleSections["sections"];

    const items = buildSidebarCustomizerSections({
      sections,
      catalogLabels: new Map([["claude", "Claude Code"]]),
      hiddenCatalogIds: new Set(["claude"]),
    });

    expect(
      items.map(({ id, label, reorderable, toggleable, visible }) => ({
        id,
        label,
        reorderable,
        toggleable,
        visible,
      })),
    ).toEqual([
      { id: "ungrouped", label: "Sessions", reorderable: true, toggleable: false, visible: true },
      { id: "work", label: "Coding", reorderable: true, toggleable: false, visible: true },
      {
        id: "catalog:claude",
        label: "Claude Code",
        reorderable: true,
        toggleable: true,
        visible: false,
      },
    ]);
  });
});
