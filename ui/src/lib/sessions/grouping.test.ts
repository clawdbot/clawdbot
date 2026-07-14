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
  it("orders pinned, alphabetical categories, and ungrouped while preserving row order", () => {
    const rows = [
      row({ key: "z-1", category: "Zulu" }),
      row({ key: "p-1", pinned: true, category: "Alpha" }),
      row({ key: "a-1", category: "Alpha" }),
      row({ key: "u-1" }),
      row({ key: "a-2", category: "Alpha" }),
    ];

    const sections = groupSidebarSessionRows(rows);

    expect(sections.map((section) => section.id)).toEqual([
      "pinned",
      "category:Alpha",
      "category:Zulu",
      "ungrouped",
    ]);
    expect(sections[1]?.rows.map((item) => item.key)).toEqual(["a-1", "a-2"]);
    expect(sections[3]?.rows.map((item) => item.key)).toEqual(["u-1"]);
  });

  it("classifies channel and work rows into built-in smart sections", () => {
    const rows = [
      row({ key: "tg-1" }),
      row({ key: "dash-1" }),
      row({ key: "wt-1" }),
      row({ key: "grouped-tg" }),
    ];
    const decorated = [
      { ...rows[0], channel: "telegram", channelSession: true },
      { ...rows[1] },
      { ...rows[2], workSession: true },
      // Explicit user category beats smart channel classification.
      { ...rows[3], channel: "telegram", channelSession: true, category: "Project X" },
    ];

    const sections = groupSidebarSessionRows(decorated);

    expect(sections.map((section) => section.id)).toEqual([
      "channel:telegram",
      "work",
      "category:Project X",
      "ungrouped",
    ]);
    expect(sections[0]?.channel).toBe("telegram");
    expect(sections[0]?.rows.map((item) => item.key)).toEqual(["tg-1"]);
    expect(sections[1]?.work).toBe(true);
    expect(sections[1]?.rows.map((item) => item.key)).toEqual(["wt-1"]);
    expect(sections[2]?.rows.map((item) => item.key)).toEqual(["grouped-tg"]);
    expect(sections[3]?.rows.map((item) => item.key)).toEqual(["dash-1"]);
  });

  it("orders channel sections alphabetically before work", () => {
    const sections = groupSidebarSessionRows([
      { ...row({ key: "wa" }), channel: "whatsapp", channelSession: true },
      { ...row({ key: "dc" }), channel: "discord", channelSession: true },
      { ...row({ key: "wt" }), workSession: true },
    ]);
    expect(sections.map((section) => section.id)).toEqual([
      "channel:discord",
      "channel:whatsapp",
      "work",
      "ungrouped",
    ]);
  });

  it("collapses smart sections into the flat list when grouping is none", () => {
    const sections = groupSidebarSessionRows(
      [
        { ...row({ key: "tg" }), channel: "telegram", channelSession: true },
        { ...row({ key: "wt" }), workSession: true },
        { ...row({ key: "pin" }), pinned: true },
      ],
      { grouping: "none" },
    );
    expect(sections.map((section) => section.id)).toEqual(["pinned", "ungrouped"]);
    expect(sections[1]?.rows.map((item) => item.key)).toEqual(["tg", "wt"]);
  });

  it("keeps the ungrouped section when no categories exist", () => {
    expect(groupSidebarSessionRows([row({ key: "a" })]).map((section) => section.id)).toEqual([
      "ungrouped",
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
    ]);
  });

  it("collapses categories into the ungrouped list when grouping is none", () => {
    const sections = groupSidebarSessionRows(
      [
        row({ key: "p-1", pinned: true }),
        row({ key: "a-1", category: "Alpha" }),
        row({ key: "u-1" }),
      ],
      { grouping: "none", knownGroups: ["Alpha", "Apps"] },
    );
    expect(sections.map((section) => section.id)).toEqual(["pinned", "ungrouped"]);
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

function row(overrides: Partial<GatewaySessionRow> & { key: string }): GatewaySessionRow {
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
