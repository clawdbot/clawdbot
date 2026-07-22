// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  groupSidebarSessionRows,
  groupSessionRows,
  normalizeSessionsGroupBy,
  normalizeSidebarSessionsGrouping,
  UNGROUPED_ID,
} from "./grouping.ts";

describe("groupSidebarSessionRows", () => {
  it("orders pinned, categories, threads, groups, then coding while preserving row order", () => {
    const rows = [
      row({ key: "z-1", category: "Zulu" }),
      row({ key: "p-1", pinned: true, category: "Alpha" }),
      row({ key: "a-1", category: "Alpha" }),
      row({ key: "u-1" }),
      row({ key: "g-1", kind: "group" }),
      row({ key: "wt-1", workSession: true }),
      row({ key: "a-2", category: "Alpha" }),
    ];

    const sections = groupSidebarSessionRows(rows);

    expect(sections.map((section) => section.id)).toEqual([
      "pinned",
      "category:Alpha",
      "category:Zulu",
      "ungrouped",
      "groups",
      "work",
    ]);
    expect(sections[1]?.rows.map((item) => item.key)).toEqual(["a-1", "a-2"]);
    expect(sections[3]?.rows.map((item) => item.key)).toEqual(["u-1"]);
    expect(sections[4]?.groups).toBe(true);
    expect(sections[4]?.rows.map((item) => item.key)).toEqual(["g-1"]);
    expect(sections[5]?.work).toBe(true);
    expect(sections[5]?.rows.map((item) => item.key)).toEqual(["wt-1"]);
  });

  it("folds DM channel sessions into threads and group kinds into the groups zone", () => {
    const sections = groupSidebarSessionRows([
      { ...row({ key: "tg-dm" }), channel: "telegram", channelSession: true },
      { ...row({ key: "dash-1" }) },
      { ...row({ key: "wa-group", kind: "group" }), channel: "whatsapp", channelSession: true },
      // Explicit user category beats smart group/coding classification.
      { ...row({ key: "grouped-tg", kind: "group" }), category: "Project X" },
      { ...row({ key: "acp-1" }), acpSession: true },
    ]);

    expect(sections.map((section) => section.id)).toEqual([
      "category:Project X",
      "ungrouped",
      "groups",
      "work",
    ]);
    expect(sections[0]?.rows.map((item) => item.key)).toEqual(["grouped-tg"]);
    expect(sections[1]?.rows.map((item) => item.key)).toEqual(["tg-dm", "dash-1"]);
    expect(sections[2]?.rows.map((item) => item.key)).toEqual(["wa-group"]);
    expect(sections[3]?.rows.map((item) => item.key)).toEqual(["acp-1"]);
  });

  it("keeps the kind-based zones split when grouping is none", () => {
    const sections = groupSidebarSessionRows(
      [
        { ...row({ key: "tg" }), channel: "telegram", channelSession: true },
        { ...row({ key: "wt" }), workSession: true },
        { ...row({ key: "grp", kind: "group" }) },
        { ...row({ key: "pin" }), pinned: true },
      ],
      { grouping: "none" },
    );
    expect(sections.map((section) => section.id)).toEqual([
      "pinned",
      "ungrouped",
      "groups",
      "work",
    ]);
    expect(sections[1]?.rows.map((item) => item.key)).toEqual(["tg"]);
  });

  it("always emits threads and coding so the renderer can host fallbacks and catalogs", () => {
    expect(groupSidebarSessionRows([row({ key: "a" })]).map((section) => section.id)).toEqual([
      "ungrouped",
      "work",
    ]);
  });

  it("keeps stored-but-empty known groups visible as sections", () => {
    const sections = groupSidebarSessionRows(
      [row({ key: "a" }), row({ key: "b", category: "Zulu" })],
      {
        knownGroups: ["Apps", " ", "Zulu"],
      },
    );
    expect(sections.map((section) => section.id)).toEqual([
      "category:Apps",
      "category:Zulu",
      "ungrouped",
      "work",
    ]);
    expect(sections[0]?.rows).toEqual([]);
    expect(sections[1]?.rows.map((item) => item.key)).toEqual(["b"]);
  });

  it("keeps custom groups in their persisted order", () => {
    const sections = groupSidebarSessionRows(
      [row({ key: "a", category: "Alpha" }), row({ key: "z", category: "Zulu" })],
      { knownGroups: ["Zulu", "Alpha"] },
    );
    expect(sections.map((section) => section.id)).toEqual([
      "category:Zulu",
      "category:Alpha",
      "ungrouped",
      "work",
    ]);
  });

  it("collapses categories into the threads list when grouping is none", () => {
    const sections = groupSidebarSessionRows(
      [
        row({ key: "p-1", pinned: true }),
        row({ key: "a-1", category: "Alpha" }),
        row({ key: "u-1" }),
      ],
      { grouping: "none", knownGroups: ["Alpha", "Apps"] },
    );
    expect(sections.map((section) => section.id)).toEqual(["pinned", "ungrouped", "work"]);
    expect(sections[1]?.rows.map((item) => item.key)).toEqual(["a-1", "u-1"]);
  });
});

describe("normalizeSidebarSessionsGrouping", () => {
  it("accepts none and falls back to category grouping", () => {
    expect(normalizeSidebarSessionsGrouping("none")).toBe("none");
    expect(normalizeSidebarSessionsGrouping("category")).toBe("category");
    expect(normalizeSidebarSessionsGrouping(null)).toBe("category");
    expect(normalizeSidebarSessionsGrouping("bogus")).toBe("category");
  });
});

type ZoneRowExtras = {
  workSession?: boolean;
  acpSession?: boolean;
  channelSession?: boolean;
};

function row(
  overrides: Partial<GatewaySessionRow> & ZoneRowExtras & { key: string },
): GatewaySessionRow & ZoneRowExtras {
  return {
    kind: "direct",
    updatedAt: null,
    ...overrides,
  };
}

describe("normalizeSessionsGroupBy", () => {
  it("accepts known modes and falls back to none", () => {
    expect(normalizeSessionsGroupBy("category")).toBe("category");
    expect(normalizeSessionsGroupBy("date")).toBe("date");
    expect(normalizeSessionsGroupBy("bogus")).toBe("none");
    expect(normalizeSessionsGroupBy(null)).toBe("none");
  });
});

describe("groupSessionRows", () => {
  it("keeps known categories in order, appends extras, and puts ungrouped last", () => {
    const rows = [
      row({ key: "a", category: "Zulu" }),
      row({ key: "b", category: "Research" }),
      row({ key: "c" }),
    ];
    const groups = groupSessionRows({
      rows,
      mode: "category",
      knownCategories: ["Research", "Empty"],
    });
    expect(groups.map((group) => group.id)).toEqual(["Research", "Empty", "Zulu", UNGROUPED_ID]);
    expect(groups[1]?.rows).toEqual([]);
    expect(groups[3]?.rows.map((r) => r.key)).toEqual(["c"]);
  });

  it("groups channel sessions alphabetically with unparseable keys last", () => {
    const rows = [
      row({ key: "agent:main:telegram:direct:1" }),
      row({ key: "agent:main:discord:channel:2" }),
      row({ key: "global", kind: "global" }),
    ];
    const groups = groupSessionRows({ rows, mode: "channel" });
    expect(groups.map((group) => group.id)).toEqual(["discord", "telegram", UNGROUPED_ID]);
  });

  it("preserves row order within a group", () => {
    const rows = [
      row({ key: "agent:main:discord:channel:1" }),
      row({ key: "agent:main:discord:channel:2" }),
    ];
    const groups = groupSessionRows({ rows, mode: "channel" });
    expect(groups[0]?.rows.map((r) => r.key)).toEqual([
      "agent:main:discord:channel:1",
      "agent:main:discord:channel:2",
    ]);
  });
});
