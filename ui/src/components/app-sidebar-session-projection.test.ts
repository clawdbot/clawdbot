import { describe, expect, it } from "vitest";
import { SidebarSessionProjection } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

type ProjectionInput = Parameters<SidebarSessionProjection["project"]>[0];

const connectionIdentity = {};
const listSource = {};

function sessionRow(
  key: string,
  overrides: Partial<SidebarRecentSession> = {},
): SidebarRecentSession {
  return {
    key,
    label: key,
    href: `/chat/${key}`,
    active: false,
    visuallyActive: false,
    hasActiveRun: false,
    modelSelectionLocked: false,
    pinned: false,
    cloudWorkerStopAction: null,
    hasAutomation: false,
    unread: false,
    attention: { kind: "none" },
    childSessionKeys: [],
    children: [],
    isChild: false,
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: 0,
    failedChildCount: 0,
    ...overrides,
  };
}

function projectionInput(
  rows: SidebarRecentSession[],
  overrides: Partial<ProjectionInput> = {},
): ProjectionInput {
  return {
    rows,
    grouping: "category",
    knownGroups: [],
    collapsedSections: new Set(),
    hideEmptyGroups: false,
    visibleSessionLimits: new Map(),
    sortMode: "created",
    statusFilter: "active",
    agentId: "main",
    connectionIdentity,
    listSource,
    subtitle: {
      sidebarLiveActivity: true,
      showPreview: true,
      narrationLines: new Map(),
      observerDigests: new Map(),
    },
    ...overrides,
  };
}

function pagedSessions(overrides: Partial<SidebarRecentSession> = {}): SidebarRecentSession[] {
  return Array.from({ length: 11 }, (_, index) =>
    sessionRow(`session-${index}`, index === 10 ? overrides : {}),
  );
}

function subtitleParams(
  session: SidebarRecentSession,
  overrides: Partial<Parameters<SidebarSessionProjection["resolveSubtitle"]>[0]> = {},
) {
  return {
    session,
    hasDisplay: false,
    displaySubtitle: undefined,
    sidebarLiveActivity: true,
    showPreview: true,
    narrationLine: undefined,
    ...overrides,
  };
}

describe("SidebarSessionProjection sticky membership", () => {
  it("keeps an active row visible after it returns to idle without displacing the natural page", () => {
    const projection = new SidebarSessionProjection();
    const runningRows = pagedSessions({ active: true });

    expect(
      projection.project(projectionInput(runningRows)).visibleRows.map((row) => row.key),
    ).toEqual([...runningRows.slice(0, 9).map((row) => row.key), "session-10"]);

    const idleRows = pagedSessions();
    const visible = projection.project(projectionInput(idleRows)).visibleRows;

    expect(visible.map((row) => row.key)).toEqual(idleRows.map((row) => row.key));
    expect(projection.project(projectionInput(idleRows)).visibleRows).toHaveLength(11);
  });

  it("retains the previous page when a newly sorted row enters ahead of it", () => {
    const projection = new SidebarSessionProjection();
    const original = pagedSessions();
    projection.project(projectionInput(original));

    const inserted = [sessionRow("newest"), ...original];

    expect(projection.project(projectionInput(inserted)).visibleRows.map((row) => row.key)).toEqual(
      ["newest", ...original.slice(0, 10).map((row) => row.key)],
    );
  });

  it.each([10, 30])(
    "bounds implicit retention while preserving the current %i-row page and active session",
    (limit) => {
      const projection = new SidebarSessionProjection();
      const quietRows = Array.from({ length: 4 * limit }, (_, index) =>
        sessionRow(`quiet-${index}`),
      );
      const active = sessionRow("current", { active: true });
      const options: Partial<ProjectionInput> = {
        sortMode: "updated",
        ...(limit === 10 ? {} : { visibleSessionLimits: new Map([["ungrouped", limit]]) }),
      };

      for (let start = 0; start < quietRows.length; start += limit) {
        const sorted = [...quietRows.slice(start), ...quietRows.slice(0, start), active];
        const { visibleRows } = projection.project(projectionInput(sorted, options));
        const visibleKeys = new Set(visibleRows.map((row) => row.key));

        expect(visibleKeys.has(active.key)).toBe(true);
        for (const row of sorted.slice(0, limit - 1)) {
          expect(visibleKeys.has(row.key)).toBe(true);
        }
        expect(visibleRows.length).toBeLessThanOrEqual(2 * limit);
      }
    },
  );

  it.each([
    // Grouping can re-emit the same section id (e.g. ungrouped) with a
    // different row population; sticky keys must not survive the switch.
    ["grouping", { grouping: "none" }],
    ["sort mode", { sortMode: "updated" }],
    ["status filter", { statusFilter: "all" }],
    ["agent", { agentId: "other" }],
    ["gateway connection", { connectionIdentity: {} }],
    ["session-list source", { listSource: {} }],
  ] satisfies [string, Partial<ProjectionInput>][])(
    "resets retained page membership when the %s changes",
    (_boundary, change) => {
      const projection = new SidebarSessionProjection();
      projection.project(projectionInput(pagedSessions({ active: true })));
      expect(projection.project(projectionInput(pagedSessions())).visibleRows).toHaveLength(11);

      expect(projection.project(projectionInput(pagedSessions(), change)).visibleRows).toHaveLength(
        10,
      );
    },
  );

  it("keeps the flat list headerless beside catalog sections when grouping is none", () => {
    const projection = new SidebarSessionProjection();
    const flat = projection.project(
      projectionInput([sessionRow("a")], { grouping: "none", catalogIds: ["claude"] }),
    );
    expect(flat.sections.map((section) => [section.id, section.renderHeader])).toEqual([
      ["ungrouped", false],
      ["work", true],
      ["catalog:claude", true],
    ]);

    const grouped = projection.project(
      projectionInput([sessionRow("a")], { catalogIds: ["claude"] }),
    );
    expect(grouped.sections.find((section) => section.id === "ungrouped")?.renderHeader).toBe(true);
  });

  it("clears a section's sticky rows when its user collapses and reopens it", () => {
    const projection = new SidebarSessionProjection();
    const categorized = (active: boolean) =>
      pagedSessions({ active, category: "Team" }).map((row) =>
        Object.assign(row, { category: "Team" }),
      );
    const options: Partial<ProjectionInput> = { knownGroups: ["Team"] };
    projection.project(projectionInput(categorized(true), options));
    expect(
      projection.project(projectionInput(categorized(false), options)).visibleRows,
    ).toHaveLength(11);

    projection.project(
      projectionInput(categorized(false), {
        ...options,
        collapsedSections: new Set(["category:Team"]),
      }),
    );

    expect(
      projection.project(projectionInput(categorized(false), options)).visibleRows,
    ).toHaveLength(10);
  });

  it("forgets a sticky key once it disappears instead of restoring it when it returns", () => {
    const projection = new SidebarSessionProjection();
    projection.project(projectionInput(pagedSessions({ active: true })));
    projection.project(projectionInput(pagedSessions()));
    projection.project(projectionInput(pagedSessions().slice(0, 10)));

    expect(
      projection.project(projectionInput(pagedSessions())).visibleRows.map((row) => row.key),
    ).toEqual(
      pagedSessions()
        .slice(0, 10)
        .map((row) => row.key),
    );
  });

  it("preserves collapsed-header counts without counting retained overflow", () => {
    const projection = new SidebarSessionProjection();
    projection.project(projectionInput(pagedSessions({ active: true })));

    const section = projection
      .project(projectionInput(pagedSessions()))
      .sections.find((entry) => entry.id === "ungrouped");

    expect(section).toMatchObject({ visibleRowCount: 11, collapsedVisibleRowCount: 10 });
  });
});

describe("SidebarSessionProjection created order", () => {
  it("retains a row's original creation-order index when it leaves and returns below the cap", () => {
    const projection = new SidebarSessionProjection();
    projection.observeRows([{ sessions: [{ key: "first" }, { key: "returning" }] }]);
    const originalOrder = projection.createdOrder.get("returning");

    projection.observeRows([{ sessions: [{ key: "first" }, { key: "newer" }] }]);
    projection.observeRows([{ sessions: [{ key: "returning" }, { key: "newer" }] }]);

    expect(projection.createdOrder.get("returning")).toBe(originalOrder);
    expect(projection.createdOrder.get("newer")).toBeGreaterThan(originalOrder ?? -1);
  });

  it("prunes only absent rows when the bounded registry exceeds its cap", () => {
    const projection = new SidebarSessionProjection();
    const original = Array.from({ length: 1_000 }, (_, index) => ({ key: `original-${index}` }));
    projection.observeRows([{ sessions: original }]);

    projection.observeRows([{ sessions: [{ key: "replacement" }, original[999]!] }]);

    expect(projection.createdOrder.size).toBe(1_000);
    expect(projection.createdOrder.has("original-0")).toBe(false);
    expect(projection.createdOrder.get("original-999")).toBe(999);
    expect(projection.createdOrder.get("replacement")).toBe(1_000);
  });

  it("promotes newly created sessions without losing the order of existing peers", () => {
    const projection = new SidebarSessionProjection();
    projection.observeRows([{ sessions: [{ key: "first" }, { key: "second" }] }]);

    expect(projection.promoteCreatedSession("newest")).toBe(true);
    expect(projection.promoteCreatedSession("newest")).toBe(false);
    expect([...projection.createdOrder]).toEqual([
      ["first", 1],
      ["second", 2],
      ["newest", 0],
    ]);
  });

  it("keeps observed creation order across sidebar scope replacements", () => {
    const projection = new SidebarSessionProjection();
    projection.observeRows([{ sessions: [{ key: "remembered" }] }]);
    projection.project(projectionInput([sessionRow("remembered")]));

    projection.project(
      projectionInput([sessionRow("replacement")], {
        agentId: "other",
        connectionIdentity: {},
        listSource: {},
      }),
    );

    expect(projection.createdOrder.get("remembered")).toBe(0);
  });
});

describe("SidebarSessionProjection child expansion", () => {
  it("latches an active descendant's expansion after that descendant returns to idle", () => {
    const projection = new SidebarSessionProjection();
    projection.project(projectionInput([sessionRow("parent", { containsActiveDescendant: true })]));

    projection.project(projectionInput([sessionRow("parent")]));

    expect(projection.isChildrenExpanded("parent")).toBe(true);
  });

  it("keeps an explicitly collapsed parent closed when a later descendant becomes active", () => {
    const projection = new SidebarSessionProjection();
    const active = sessionRow("parent", { containsActiveDescendant: true });
    projection.project(projectionInput([active]));
    expect(projection.toggleChildren(active)).toEqual({ expanded: false });

    projection.project(projectionInput([sessionRow("parent")]));
    projection.project(projectionInput([active]));

    expect(projection.isChildrenExpanded("parent")).toBe(false);
  });

  it("preserves full child visibility until an explicit collapse resets it", () => {
    const projection = new SidebarSessionProjection();
    const parent = sessionRow("parent");

    expect(projection.toggleChildren(parent)).toEqual({ expanded: true });
    projection.showMoreChildren(parent.key);
    projection.project(projectionInput([parent]));
    expect(projection.isChildrenFullyShown(parent.key)).toBe(true);

    expect(projection.toggleChildren(parent)).toEqual({ expanded: false });
    expect(projection.isChildrenFullyShown(parent.key)).toBe(false);
    expect(projection.toggleChildren(parent)).toEqual({ expanded: true });
    expect(projection.isChildrenFullyShown(parent.key)).toBe(false);
  });

  it("keeps an expanded parent when its same-agent session-list owner is replaced", () => {
    const projection = new SidebarSessionProjection();
    const parent = sessionRow("parent");
    projection.project(projectionInput([parent]));
    projection.toggleChildren(parent);

    projection.project(projectionInput([parent], { listSource: {} }));

    expect(projection.isChildrenExpanded(parent.key)).toBe(true);
  });

  it("clears expansion when the selected agent changes", () => {
    const projection = new SidebarSessionProjection();
    const parent = sessionRow("parent");
    projection.project(projectionInput([parent]));
    projection.toggleChildren(parent);

    projection.project(projectionInput([parent], { agentId: "other" }));

    expect(projection.isChildrenExpanded(parent.key)).toBe(false);
  });

  it("forgets expansion when a session disappears before returning", () => {
    const projection = new SidebarSessionProjection();
    const parent = sessionRow("parent");
    projection.project(projectionInput([parent]));
    projection.toggleChildren(parent);

    projection.project(projectionInput([]));
    projection.project(projectionInput([parent]));

    expect(projection.isChildrenExpanded(parent.key)).toBe(false);
  });
});

describe("SidebarSessionProjection running subtitle hold", () => {
  it("holds the latest narration across an empty running update without losing its remount key", () => {
    const projection = new SidebarSessionProjection();
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    projection.project(
      projectionInput([running], {
        subtitle: {
          sidebarLiveActivity: true,
          showPreview: true,
          narrationLines: new Map([[running.key, "Running checks"]]),
          observerDigests: new Map(),
        },
      }),
    );
    projection.project(projectionInput([running]));

    expect(projection.resolveSubtitle(subtitleParams(running))).toEqual({
      subtitle: "Running checks",
      narration: "Running checks",
    });
  });

  it.each(["ended", "preview-hidden"] as const)(
    "clears held running activity when its run is %s",
    (change) => {
      const projection = new SidebarSessionProjection();
      const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
      projection.project(
        projectionInput([running], {
          subtitle: {
            sidebarLiveActivity: true,
            showPreview: true,
            narrationLines: new Map([[running.key, "Old run activity"]]),
            observerDigests: new Map(),
          },
        }),
      );
      const changed = change === "ended" ? sessionRow(running.key) : running;
      const showPreview = change !== "preview-hidden";

      projection.project(
        projectionInput([changed], {
          subtitle: {
            sidebarLiveActivity: true,
            showPreview,
            narrationLines: new Map(),
            observerDigests: new Map(),
          },
        }),
      );

      expect(projection.resolveSubtitle(subtitleParams(changed, { showPreview }))).toEqual({
        subtitle: undefined,
        narration: undefined,
      });
    },
  );

  it("holds the subtitle across a run-id rotation while the session stays running", () => {
    // Live repro: queued->running rotates activeRunIds; the row must not blank.
    const projection = new SidebarSessionProjection();
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    projection.project(
      projectionInput([running], {
        subtitle: {
          sidebarLiveActivity: true,
          showPreview: true,
          narrationLines: new Map([[running.key, "Pre-rotation activity"]]),
          observerDigests: new Map(),
        },
      }),
    );
    const rotated = sessionRow(running.key, { hasActiveRun: true, activeRunIds: ["run-two"] });
    projection.project(projectionInput([rotated]));

    expect(projection.resolveSubtitle(subtitleParams(rotated)).subtitle).toBe(
      "Pre-rotation activity",
    );
  });

  it("floors ambient subtitle replacement at the minimum display time", () => {
    let clock = 0;
    const projection = new SidebarSessionProjection(() => clock);
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    const withNarration = (line: string) => ({
      sidebarLiveActivity: true,
      showPreview: true,
      narrationLines: new Map([[running.key, line]]),
      observerDigests: new Map(),
    });
    projection.project(projectionInput([running], { subtitle: withNarration("First activity") }));

    clock = 500;
    projection.project(projectionInput([running], { subtitle: withNarration("Second activity") }));
    expect(projection.resolveSubtitle(subtitleParams(running)).subtitle).toBe("First activity");

    clock = 2_500;
    projection.project(projectionInput([running], { subtitle: withNarration("Second activity") }));
    expect(projection.resolveSubtitle(subtitleParams(running)).subtitle).toBe("Second activity");
  });

  it("lets operator-critical text replace a held subtitle immediately", () => {
    let clock = 0;
    const projection = new SidebarSessionProjection(() => clock);
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    projection.project(
      projectionInput([running], {
        subtitle: {
          sidebarLiveActivity: true,
          showPreview: true,
          narrationLines: new Map([[running.key, "Ambient activity"]]),
          observerDigests: new Map(),
        },
      }),
    );

    clock = 200;
    const needsInput = sessionRow(running.key, {
      hasActiveRun: true,
      activeRunIds: ["run-one"],
      agentStatusNote: "Blocked on operator input",
    });
    projection.project(projectionInput([needsInput]));

    expect(projection.resolveSubtitle(subtitleParams(needsInput)).subtitle).toBe(
      "Blocked on operator input",
    );
  });

  it("clears held narration when the user disables live activity", () => {
    const projection = new SidebarSessionProjection();
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    projection.project(
      projectionInput([running], {
        subtitle: {
          sidebarLiveActivity: true,
          showPreview: true,
          narrationLines: new Map([[running.key, "Running checks"]]),
          observerDigests: new Map(),
        },
      }),
    );

    projection.project(
      projectionInput([running], {
        subtitle: {
          sidebarLiveActivity: false,
          showPreview: true,
          narrationLines: new Map(),
          observerDigests: new Map(),
        },
      }),
    );

    expect(
      projection.resolveSubtitle(subtitleParams(running, { sidebarLiveActivity: false })),
    ).toEqual({ subtitle: undefined, narration: undefined });
  });

  it("keeps a held non-narration subtitle when live activity is disabled", () => {
    const projection = new SidebarSessionProjection();
    const running = sessionRow("running", {
      hasActiveRun: true,
      activeRunIds: ["run-one"],
      workSession: true,
      subtitle: "~/Projects/openclaw",
    });
    projection.project(projectionInput([running]));
    const missingSubtitle = { ...running, subtitle: undefined };

    projection.project(
      projectionInput([missingSubtitle], {
        subtitle: {
          sidebarLiveActivity: false,
          showPreview: true,
          narrationLines: new Map(),
          observerDigests: new Map(),
        },
      }),
    );

    expect(
      projection.resolveSubtitle(subtitleParams(missingSubtitle, { sidebarLiveActivity: false })),
    ).toEqual({ subtitle: "~/Projects/openclaw", narration: undefined });
  });

  it("holds shared running narration across a catalog display override", () => {
    const projection = new SidebarSessionProjection();
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    projection.project(
      projectionInput([running], {
        subtitle: {
          sidebarLiveActivity: true,
          showPreview: true,
          narrationLines: new Map([[running.key, "Native sidebar activity"]]),
          observerDigests: new Map(),
        },
      }),
    );
    projection.project(projectionInput([running]));

    expect(projection.resolveSubtitle(subtitleParams(running, { hasDisplay: true }))).toEqual({
      subtitle: "Native sidebar activity",
      narration: "Native sidebar activity",
    });
  });

  it("never leaks a held backing-work subtitle into a catalog display that omits one", () => {
    const projection = new SidebarSessionProjection();
    const running = sessionRow("running", {
      hasActiveRun: true,
      activeRunIds: ["run-one"],
      workSession: true,
      subtitle: "~/Projects/openclaw",
    });
    projection.project(projectionInput([running]));

    expect(projection.resolveSubtitle(subtitleParams(running, { hasDisplay: true }))).toEqual({
      subtitle: undefined,
      narration: undefined,
    });
  });
});
