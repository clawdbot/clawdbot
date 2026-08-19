import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar categorized child sessions", () => {
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
