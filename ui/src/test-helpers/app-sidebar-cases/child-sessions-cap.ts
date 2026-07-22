import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

const parentKey = "agent:main:parent";
const childKeys = Array.from({ length: 6 }, (_, index) => `agent:main:subagent:child-${index + 1}`);

async function mountChildSessions(extraRows: GatewaySessionRow[] = []) {
  const harness = createSessionsHarness("main", [parentKey]);
  harness.list.mockResolvedValue({
    ts: 100_000,
    path: "",
    count: childKeys.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [
      ...childKeys.map((key, index) => ({
        key,
        spawnedBy: parentKey,
        kind: "direct" as const,
        label: `Subagent: Child ${index + 1}`,
        updatedAt: index + 1,
      })),
      ...extraRows,
    ],
  });
  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    harness.sessions,
  );
  harness.publishList({
    result: {
      ts: 2,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: parentKey,
          kind: "direct",
          label: "Parent task",
          updatedAt: 1,
          childSessions: childKeys,
        },
      ],
    },
  });
  await sidebar.updateComplete;
  return sidebar;
}

describe("AppSidebar child session cap", () => {
  it("caps visible children until requested and resets the cap after collapse", async () => {
    const sidebar = await mountChildSessions();

    const toggle = sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]");
    toggle?.click();
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(4),
    );
    const showMore = sidebar.querySelector<HTMLButtonElement>("[data-show-more-children]");
    expect(showMore?.textContent?.trim()).toBe("Show 2 more");
    expect(showMore?.getAttribute("aria-label")).toBe("Show 2 more");
    expect(sidebar.textContent).not.toContain("Subagent:");

    showMore?.click();
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(6),
    );
    expect(sidebar.querySelector("[data-show-more-children]")).toBeNull();

    toggle?.click();
    await sidebar.updateComplete;
    toggle?.click();
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(4),
    );
    expect(sidebar.querySelector("[data-show-more-children]")?.textContent).toContain(
      "Show 2 more",
    );
  });

  it("keeps live children visible past the cap", async () => {
    // Quiet child beyond the cap with a running grandchild must bypass it.
    const sidebar = await mountChildSessions([
      {
        key: "agent:main:subagent:grandchild",
        spawnedBy: childKeys[5],
        kind: "direct",
        label: "Subagent: Grandchild run",
        updatedAt: 10,
        status: "running",
        hasActiveRun: true,
      },
    ]);

    sidebar
      .querySelector<HTMLButtonElement>('[data-child-session-toggle="agent:main:parent"]')
      ?.click();
    await waitForFast(() =>
      expect(
        sidebar.querySelector('[data-session-key="agent:main:subagent:child-6"]'),
      ).not.toBeNull(),
    );
    expect(sidebar.querySelector('[data-session-key="agent:main:subagent:child-5"]')).toBeNull();
    expect(sidebar.querySelector("[data-show-more-children]")?.textContent?.trim()).toBe(
      "Show 1 more",
    );
  });
});
