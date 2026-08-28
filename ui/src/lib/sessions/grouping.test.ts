// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  groupSidebarSessionRows,
  groupSessionRows,
  moveSessionSection,
  normalizeSessionSectionOrder,
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

  it("flattens the kind-based zones into one list when grouping is none", () => {
    const sections = groupSidebarSessionRows(
      [
        { ...row({ key: "tg" }), channel: "telegram", channelSession: true },
        { ...row({ key: "wt" }), workSession: true },
        { ...row({ key: "grp", kind: "group" }) },
        { ...row({ key: "pin" }), pinned: true },
      ],
      { grouping: "none" },
    );
    expect(sections.map((section) => section.id)).toEqual(["pinned", "ungrouped", "work"]);
    expect(sections[1]?.rows.map((item) => item.key)).toEqual(["tg", "wt", "grp"]);
    expect(sections[2]?.rows).toEqual([]);
  });

  it("buckets rows by work checkout and leaves checkout-less rows in their smart zones", () => {
    const openclaw = { name: "openclaw", path: "/repos/openclaw" };
    const sections = groupSidebarSessionRows(
      [
        { ...row({ key: "z-1" }), workContext: { name: "zulu", path: "/repos/zulu" } },
        { ...row({ key: "oc-1" }), workContext: openclaw, workSession: true },
        row({ key: "thread" }),
        // Same basename, different checkout: the path keeps the sections apart.
        { ...row({ key: "fork-1" }), workContext: { name: "openclaw", path: "/forks/openclaw" } },
        row({ key: "grp", kind: "group" }),
        { ...row({ key: "no-repo" }), workSession: true },
        { ...row({ key: "oc-2", category: "Ignored" }), workContext: openclaw },
        // Worktree checkouts fold into their origin repo's section.
        {
          ...row({ key: "oc-wt" }),
          workContext: { name: "c7c338", path: "/repos/openclaw/.claude/worktrees/c7c338" },
        },
        // A trailing separator must not mint a second identical section.
        {
          ...row({ key: "oc-slash" }),
          workContext: { name: "openclaw", path: "/repos/openclaw/" },
        },
        { ...row({ key: "pin", pinned: true }), workContext: openclaw },
      ],
      { grouping: "project", knownGroups: ["Ignored"] },
    );

    expect(sections.map((section) => section.id)).toEqual([
      "pinned",
      "project:/forks/openclaw",
      "project:/repos/openclaw",
      "project:/repos/zulu",
      "ungrouped",
      "groups",
      "work",
    ]);
    expect(sections[2]?.project).toEqual(openclaw);
    expect(sections[2]?.rows.map((item) => item.key)).toEqual([
      "oc-1",
      "oc-2",
      "oc-wt",
      "oc-slash",
    ]);
    expect(sections[4]?.rows.map((item) => item.key)).toEqual(["thread"]);
    expect(sections[5]?.rows.map((item) => item.key)).toEqual(["grp"]);
    expect(sections[6]?.rows.map((item) => item.key)).toEqual(["no-repo"]);
  });

  it("keeps project sections ahead of the stored zone order", () => {
    const sections = groupSidebarSessionRows(
      [
        { ...row({ key: "oc" }), workContext: { name: "openclaw", path: "/repos/openclaw" } },
        row({ key: "thread" }),
      ],
      { grouping: "project", sectionOrder: ["work", "ungrouped"] },
    );
    expect(sections.map((section) => section.id)).toEqual([
      "project:/repos/openclaw",
      "work",
      "ungrouped",
    ]);
  });

  it("orders owner sections before stored zones and leaves ownerless rows in their smart zones", () => {
    const sections = groupSidebarSessionRows(
      [
        row({ key: "agent", owner: { actor: { type: "agent", id: "agent-z", label: "Zed" } } }),
        row({
          key: "owned-group",
          kind: "group",
          category: "Ignored",
          owner: { actor: { type: "human", id: "profile-b", label: "Bea" } },
        }),
        row({ key: "thread" }),
        row({ key: "group", kind: "group" }),
        row({ key: "work", workSession: true }),
        row({ key: "human-a", owner: { actor: { type: "human", id: "profile-a", label: "Ada" } } }),
        row({
          key: "self",
          owner: {
            actor: {
              type: "human",
              id: "profile-self",
              label: "Zoe",
              avatarUrl: "/avatars/self",
            },
          },
        }),
        row({ key: "agent-a", owner: { actor: { type: "agent", id: "agent-a", label: "Alpha" } } }),
        row({ key: "blank-owner", owner: { actor: { type: "human", id: "   " } } }),
        row({ key: "pinned", pinned: true, owner: { actor: { type: "human", id: "profile-a" } } }),
      ],
      {
        grouping: "person",
        selfOwnerId: "profile-self",
        knownGroups: ["Ignored"],
        catalogIds: ["catalog"],
        sectionOrder: ["work", "person:profile-b", "groups", "ungrouped", "catalog:catalog"],
      },
    );

    expect(sections.map((section) => section.id)).toEqual([
      "pinned",
      "person:profile-self",
      "person:profile-a",
      "person:profile-b",
      "person:agent-a",
      "person:agent-z",
      "work",
      "groups",
      "ungrouped",
      "catalog:catalog",
    ]);
    expect(sections[1]?.personOwner).toEqual({
      type: "human",
      id: "profile-self",
      label: "Zoe",
      avatarUrl: "/avatars/self",
    });
    expect(sections[3]?.rows.map((item) => item.key)).toEqual(["owned-group"]);
    expect(sections[6]?.rows.map((item) => item.key)).toEqual(["work"]);
    expect(sections[7]?.rows.map((item) => item.key)).toEqual(["group"]);
    expect(sections[8]?.rows.map((item) => item.key)).toEqual(["thread", "blank-owner"]);
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

  it("applies stored cross-section order after pinned rows", () => {
    const sections = groupSidebarSessionRows(
      [
        row({ key: "pin", pinned: true }),
        row({ key: "a", category: "Alpha" }),
        row({ key: "thread" }),
        row({ key: "group", kind: "group" }),
      ],
      { sectionOrder: ["work", "groups", "ungrouped", "category:Alpha"] },
    );
    expect(sections.map((section) => section.id)).toEqual([
      "pinned",
      "work",
      "groups",
      "ungrouped",
      "category:Alpha",
    ]);
  });

  it("emits catalog sections after coding by default and honors their stored positions", () => {
    const rows = [row({ key: "thread" }), row({ key: "work", workSession: true })];

    expect(
      groupSidebarSessionRows(rows, { catalogIds: ["claude", "codex"] }).map(
        (section) => section.id,
      ),
    ).toEqual(["ungrouped", "work", "catalog:claude", "catalog:codex"]);
    expect(
      groupSidebarSessionRows(rows, {
        catalogIds: ["claude", "codex"],
        sectionOrder: ["catalog:codex", "ungrouped", "work", "catalog:claude"],
      }).map((section) => section.id),
    ).toEqual(["catalog:codex", "ungrouped", "work", "catalog:claude"]);
  });

  it("appends sections missing from stored order in default relative order", () => {
    const sections = groupSidebarSessionRows(
      [row({ key: "a", category: "Alpha" }), row({ key: "thread" })],
      { sectionOrder: ["work"] },
    );
    expect(sections.map((section) => section.id)).toEqual(["category:Alpha", "work", "ungrouped"]);
  });

  it("keeps the default order for an empty stored order", () => {
    const rows = [row({ key: "a", category: "Alpha" }), row({ key: "thread" })];
    expect(groupSidebarSessionRows(rows, { sectionOrder: [] })).toEqual(
      groupSidebarSessionRows(rows),
    );
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

  it("uses the normalized section order while keeping pinned rows first", () => {
    const sections = groupSidebarSessionRows(
      [
        row({ key: "pin", pinned: true }),
        row({ key: "thread" }),
        row({ key: "group", kind: "group" }),
        row({ key: "alpha", category: "Alpha" }),
        row({ key: "work", workSession: true }),
      ],
      {
        knownGroups: ["Alpha"],
        sectionOrder: ["ungrouped", "groups", "category:Alpha", "work"],
      },
    );

    expect(sections.map((section) => section.id)).toEqual([
      "pinned",
      "ungrouped",
      "groups",
      "category:Alpha",
      "work",
    ]);
  });
});

describe("normalizeSessionSectionOrder", () => {
  it("builds the default order from an empty stored value", () => {
    expect(normalizeSessionSectionOrder([], ["Alpha", "Beta"])).toEqual([
      "category:Alpha",
      "category:Beta",
      "ungrouped",
      "groups",
      "work",
    ]);
  });

  it("honors stored positions", () => {
    expect(
      normalizeSessionSectionOrder(
        ["ungrouped", "category:Alpha", "groups", "category:Beta", "work"],
        ["Alpha", "Beta"],
      ),
    ).toEqual(["ungrouped", "category:Alpha", "groups", "category:Beta", "work"]);
  });

  it("inserts a new category before the first built-in section", () => {
    expect(
      normalizeSessionSectionOrder(
        ["category:Alpha", "ungrouped", "groups", "work"],
        ["Alpha", "Beta"],
      ),
    ).toEqual(["category:Alpha", "category:Beta", "ungrouped", "groups", "work"]);
  });

  it("drops stale category tokens", () => {
    expect(
      normalizeSessionSectionOrder(
        ["category:Stale", "category:Alpha", "ungrouped", "groups", "work"],
        ["Alpha"],
      ),
    ).toEqual(["category:Alpha", "ungrouped", "groups", "work"]);
  });

  it("appends unseen catalogs after coding and drops disappeared catalogs", () => {
    expect(
      normalizeSessionSectionOrder(
        ["catalog:codex", "ungrouped", "groups", "work", "catalog:removed"],
        [],
        ["claude", "codex"],
      ),
    ).toEqual(["catalog:codex", "ungrouped", "groups", "work", "catalog:claude"]);
  });

  it("drops invalid and duplicate tokens", () => {
    expect(
      normalizeSessionSectionOrder(
        ["category:Stale", "bogus", "category:", "ungrouped", "ungrouped", "category:Alpha"],
        ["Alpha"],
      ),
    ).toEqual(["ungrouped", "groups", "work", "category:Alpha"]);
  });

  it("reinserts a missing built-in after its default predecessor", () => {
    expect(
      normalizeSessionSectionOrder(
        ["category:Alpha", "ungrouped", "category:Beta", "work"],
        ["Alpha", "Beta"],
      ),
    ).toEqual(["category:Alpha", "ungrouped", "groups", "category:Beta", "work"]);
  });
});

describe("moveSessionSection", () => {
  const order = ["category:Alpha", "category:Beta", "ungrouped", "groups", "work"];

  it("moves a section before or after its target", () => {
    expect(moveSessionSection(order, "category:Beta", "work", "before")).toEqual([
      "category:Alpha",
      "ungrouped",
      "groups",
      "category:Beta",
      "work",
    ]);
    expect(moveSessionSection(order, "category:Alpha", "groups", "after")).toEqual([
      "category:Beta",
      "ungrouped",
      "groups",
      "category:Alpha",
      "work",
    ]);
  });

  it("leaves self and unknown moves unchanged", () => {
    expect(moveSessionSection(order, "category:Alpha", "category:Alpha", "after")).toEqual(order);
    expect(moveSessionSection(order, "category:Missing", "work", "before")).toEqual(order);
    expect(moveSessionSection(order, "category:Alpha", "missing", "before")).toEqual(order);
  });
});

describe("normalizeSidebarSessionsGrouping", () => {
  it("accepts supported modes and falls back to category grouping", () => {
    expect(normalizeSidebarSessionsGrouping("none")).toBe("none");
    expect(normalizeSidebarSessionsGrouping("person")).toBe("person");
    expect(normalizeSidebarSessionsGrouping("project")).toBe("project");
    expect(normalizeSidebarSessionsGrouping("category")).toBe("category");
    expect(normalizeSidebarSessionsGrouping(null)).toBe("category");
    expect(normalizeSidebarSessionsGrouping("bogus")).toBe("category");
  });
});

type ZoneRowExtras = {
  workSession?: boolean;
  acpSession?: boolean;
  channelSession?: boolean;
  workContext?: { name: string; path: string };
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
    expect(normalizeSessionsGroupBy("person")).toBe("person");
    expect(normalizeSessionsGroupBy("date")).toBe("date");
    expect(normalizeSessionsGroupBy("bogus")).toBe("none");
    expect(normalizeSessionsGroupBy(null)).toBe("none");
  });
});

describe("groupSessionRows", () => {
  it.each(["UTC", "America/Los_Angeles", "America/Santiago"])(
    "groups complete local calendar days in %s",
    (timeZone) => {
      // Worker-thread TZ mutations do not reliably change V8's timezone. Start a
      // process in the requested zone so real calendar/DST behavior owns the proof.
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `
          import { groupSessionRows } from ${JSON.stringify(new URL("./grouping.ts", import.meta.url).href)};
          const dates = [[2026, 0, 1], [2026, 2, 9], [2026, 10, 2], [2026, 8, 6], [2026, 8, 7]];
          const results = dates.map(([year, month, day]) => {
            const at = (daysAgo, hour = 0, minute = 0) =>
              new Date(year, month, day - daysAgo, hour, minute).getTime();
            const rows = [
              ["today", at(0)], ["yesterday", at(1)],
              ["two-days-ago", at(2, 23, 59)], ["six-days-ago", at(6)],
              ["older", at(7, 23, 59)], ["unknown", null],
            ].map(([key, updatedAt]) => ({ key, updatedAt, kind: "direct" }));
            return groupSessionRows({ mode: "date", now: at(0, 12), rows })
              .map((group) => [group.id, group.rows.map((row) => row.key)]);
          });
          process.stdout.write(JSON.stringify(results));
        `,
        ],
        {
          cwd: new URL("../../../../", import.meta.url),
          env: { ...process.env, TZ: timeZone },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      const expected = [
        ["today", ["today"]],
        ["yesterday", ["yesterday"]],
        ["week", ["two-days-ago", "six-days-ago"]],
        ["older", ["older"]],
        [UNGROUPED_ID, ["unknown"]],
      ];
      expect(JSON.parse(output)).toEqual(Array.from({ length: 5 }, () => expected));
    },
  );

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

  it("groups sessions by their durable owner identity and leaves ownerless sessions last", () => {
    const groups = groupSessionRows({
      rows: [
        row({ key: "bob", owner: { actor: { type: "human", id: "profile-b", label: "Bob" } } }),
        row({ key: "ownerless" }),
        row({ key: "ada", owner: { actor: { type: "human", id: " profile-a ", label: "Ada" } } }),
        row({ key: "blank", owner: { actor: { type: "human", id: " " } } }),
      ],
      mode: "person",
    });

    expect(groups.map((group) => group.id)).toEqual(["profile-a", "profile-b", UNGROUPED_ID]);
    expect(groups[2]?.rows.map((item) => item.key)).toEqual(["ownerless", "blank"]);
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
