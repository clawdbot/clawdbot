import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  groupSidebarSessionRows,
  groupSessionRows,
  normalizeSessionsGroupBy,
  normalizeSidebarSessionsGrouping,
  resolveSessionGroupId,
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

describe("resolveSessionGroupId", () => {
  const now = Date.parse("2026-07-05T12:00:00Z");

  it("derives channel from the session key for message-channel sessions", () => {
    expect(
      resolveSessionGroupId(row({ key: "agent:main:discord:channel:123" }), "channel", now),
    ).toBe("discord");
    expect(resolveSessionGroupId(row({ key: "agent:main:telegram:group:9" }), "channel", now)).toBe(
      "telegram",
    );
    expect(resolveSessionGroupId(row({ key: "global", kind: "global" }), "channel", now)).toBe(
      UNGROUPED_ID,
    );
  });

  it("prefers the row channel field when present", () => {
    expect(
      resolveSessionGroupId(
        row({ key: "agent:main:whatsapp:direct:1", channel: "whatsapp" }),
        "channel",
        now,
      ),
    ).toBe("whatsapp");
  });

  it("uses the category for custom grouping and treats blank as ungrouped", () => {
    expect(resolveSessionGroupId(row({ key: "a", category: "Research" }), "category", now)).toBe(
      "Research",
    );
    expect(resolveSessionGroupId(row({ key: "a" }), "category", now)).toBe(UNGROUPED_ID);
  });

  it("groups plain agent sessions under their agent id", () => {
    expect(resolveSessionGroupId(row({ key: "agent:main:main" }), "agent", now)).toBe("main");
    expect(resolveSessionGroupId(row({ key: "agent:kimi:discord:channel:1" }), "agent", now)).toBe(
      "kimi",
    );
    expect(resolveSessionGroupId(row({ key: "global", kind: "global" }), "agent", now)).toBe(
      UNGROUPED_ID,
    );
  });

  it("buckets dates relative to now", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(resolveSessionGroupId(row({ key: "a", updatedAt: now }), "date", now)).toBe("today");
    expect(resolveSessionGroupId(row({ key: "a", updatedAt: now - day }), "date", now)).toBe(
      "yesterday",
    );
    expect(resolveSessionGroupId(row({ key: "a", updatedAt: now - 4 * day }), "date", now)).toBe(
      "week",
    );
    expect(resolveSessionGroupId(row({ key: "a", updatedAt: now - 30 * day }), "date", now)).toBe(
      "older",
    );
    expect(resolveSessionGroupId(row({ key: "a", updatedAt: null }), "date", now)).toBe(
      UNGROUPED_ID,
    );
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
