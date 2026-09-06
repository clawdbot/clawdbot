import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar categorized child sessions", () => {
  it("promotes a categorized child loaded through the expanded-parent cache", async () => {
    const parentKey = "agent:main:parent";
    const categorizedKey = "agent:main:cached-categorized-child";
    const ordinaryKey = "agent:main:cached-ordinary-child";
    const archivedKey = "agent:main:cached-archived-child";
    const harness = createSessionsHarness("main", [parentKey]);
    const parent = harness.sessions.state.result?.sessions[0];
    Object.assign(parent ?? {}, {
      childSessions: [categorizedKey, ordinaryKey, archivedKey],
      label: "Parent task",
    });
    harness.list.mockResolvedValue({
      count: 3,
      defaults: { contextTokens: null, model: null, modelProvider: null },
      path: "",
      sessions: [
        {
          category: "Research",
          key: categorizedKey,
          kind: "direct",
          label: "Cached categorized child",
          spawnedBy: parentKey,
          updatedAt: 3,
        },
        {
          key: ordinaryKey,
          kind: "direct",
          label: "Cached ordinary child",
          spawnedBy: parentKey,
          updatedAt: 2,
        },
        {
          archived: true,
          category: "Research",
          key: archivedKey,
          kind: "direct",
          label: "Cached archived child",
          spawnedBy: parentKey,
          updatedAt: 1,
        },
      ],
      ts: 1,
    });
    harness.publish({ groups: ["Research"] });

    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await waitForFast(() => expect(harness.list).toHaveBeenCalledOnce());

    const research = sidebar.querySelector('[data-session-section="category:Research"]');
    await waitForFast(() =>
      expect(research?.querySelectorAll(`[data-session-key="${categorizedKey}"]`)).toHaveLength(1),
    );
    expect(
      sidebar.querySelector(
        `[data-session-tree="${parentKey}"] [data-session-key="${ordinaryKey}"]`,
      ),
    ).not.toBeNull();
    expect(sidebar.querySelector(`[data-session-key="${archivedKey}"]`)).toBeNull();

    harness.publishList({
      result: {
        ...harness.sessions.state.result!,
        count: 2,
        sessions: [
          parent!,
          {
            key: categorizedKey,
            kind: "direct",
            label: "Current ordinary child",
            spawnedBy: parentKey,
            updatedAt: 4,
          },
        ],
      },
    });
    await waitForFast(() => {
      const rows = sidebar.querySelectorAll(`[data-session-key="${categorizedKey}"]`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toContain("Current ordinary child");
      expect(rows[0]?.closest(`[data-session-tree="${parentKey}"]`)).not.toBeNull();
    });
    expect(sidebar.textContent).not.toContain("Cached categorized child");
    expect(
      sidebar.querySelector(
        `[data-session-section="category:Research"] [data-session-key="${categorizedKey}"]`,
      ),
    ).toBeNull();
    expect(
      sidebar.querySelector(
        `[data-session-tree="${parentKey}"] [data-session-key="${ordinaryKey}"]`,
      ),
    ).not.toBeNull();
    expect(sidebar.querySelector(`[data-session-key="${archivedKey}"]`)).toBeNull();
  });

  it("places a categorized child in its section while keeping ordinary siblings nested", async () => {
    const harness = createSessionsHarness("main", [
      "agent:main:parent",
      "agent:main:categorized-child",
      "agent:main:ordinary-child",
      "agent:main:archived-child",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected child session fixtures");
    }
    const rowsByKey = new Map(result.sessions.map((row) => [row.key, row]));
    Object.assign(rowsByKey.get("agent:main:parent") ?? {}, {
      label: "Parent task",
      childSessions: [
        "agent:main:categorized-child",
        "agent:main:ordinary-child",
        "agent:main:archived-child",
      ],
    });
    Object.assign(rowsByKey.get("agent:main:categorized-child") ?? {}, {
      spawnedBy: "agent:main:parent",
      label: "Categorized child",
      category: "Research",
    });
    Object.assign(rowsByKey.get("agent:main:ordinary-child") ?? {}, {
      spawnedBy: "agent:main:parent",
      label: "Ordinary child",
    });
    Object.assign(rowsByKey.get("agent:main:archived-child") ?? {}, {
      spawnedBy: "agent:main:parent",
      label: "Archived child",
      category: "Research",
      archived: true,
    });
    harness.publish({ groups: ["Research"] });

    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);

    const research = sidebar.querySelector('[data-session-section="category:Research"]');
    expect(
      research?.querySelectorAll('[data-session-key="agent:main:categorized-child"]'),
    ).toHaveLength(1);
    expect(
      research?.querySelector('[data-session-key="agent:main:categorized-child"]')?.classList,
    ).not.toContain("sidebar-recent-session--child");
    expect(sidebar.querySelector('[data-session-key="agent:main:archived-child"]')).toBeNull();

    const parentTree = sidebar.querySelector('[data-session-tree="agent:main:parent"]');
    parentTree?.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await sidebar.updateComplete;

    expect(
      parentTree?.querySelectorAll('[data-session-key="agent:main:ordinary-child"]'),
    ).toHaveLength(1);
    expect(
      parentTree?.querySelector('[data-session-key="agent:main:categorized-child"]'),
    ).toBeNull();
  });
});
