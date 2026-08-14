import { describe, expect, it } from "vitest";
import {
  buildSidebarCustomizerEntries,
  buildSidebarCustomizerSections,
  mergeSidebarCustomizerEntries,
  sidebarCustomizerValuesEqual,
} from "./app-sidebar-customizer.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-navigation-logic.ts";

describe("sidebar customizer model", () => {
  it("restores customizable entries without replacing other current entries", () => {
    expect(
      mergeSidebarCustomizerEntries(
        ["fixed:current", "route:tasks"],
        ["route:cron", "route:plugins"],
        ["route:cron", "route:plugins", "route:tasks"],
      ),
    ).toEqual(["fixed:current", "route:cron", "route:plugins"]);
  });

  it("returns to pristine when the current values match the baseline", () => {
    const baseline = {
      sidebarEntries: ["route:cron", "route:plugins"],
      hiddenCatalogIds: ["claude"],
      groups: ["Research"],
      sectionOrder: ["work", "ungrouped"],
    };

    expect(
      sidebarCustomizerValuesEqual(
        {
          sidebarEntries: [...baseline.sidebarEntries],
          hiddenCatalogIds: [...baseline.hiddenCatalogIds],
          groups: [...baseline.groups],
          sectionOrder: [...baseline.sectionOrder],
        },
        baseline,
      ),
    ).toBe(true);
    expect(
      sidebarCustomizerValuesEqual(
        { ...baseline, sidebarEntries: [...baseline.sidebarEntries, "route:tasks"] },
        baseline,
      ),
    ).toBe(false);
  });

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

  it("keeps pinned sessions in their canonical page positions with a remove action", () => {
    const items = buildSidebarCustomizerEntries({
      canonical: ["route:tasks", "session:agent:main:taxes", "route:cron"],
      enabledRouteIds: ["cron", "tasks", "plugins"],
      pinnedSessions: new Map([
        ["agent:main:taxes", { key: "agent:main:taxes", label: "Tax filing research" }],
      ]),
      workboards: [],
    });

    expect(items.map((item) => item.id)).toEqual([
      "fixed:home",
      "route:tasks",
      "session:agent:main:taxes",
      "route:cron",
      "route:plugins",
    ]);
    expect(items[2]).toMatchObject({
      label: "Tax filing research",
      sessionKey: "agent:main:taxes",
      visible: true,
    });
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
