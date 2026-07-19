import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar child session cap", () => {
  it("caps visible children until requested and resets the cap after collapse", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const childKeys = Array.from(
      { length: 6 },
      (_, index) => `agent:main:subagent:child-${index + 1}`,
    );
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    harness.list.mockResolvedValue({
      ts: 100_000,
      path: "",
      count: childKeys.length,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: childKeys.map((key, index) => ({
        key,
        spawnedBy: "agent:main:parent",
        kind: "direct" as const,
        label: `Subagent: Child ${index + 1}`,
        updatedAt: index + 1,
      })),
    });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            label: "Parent task",
            updatedAt: 1,
            childSessions: childKeys,
          },
        ],
      },
    });
    await sidebar.updateComplete;

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
    const gateway = createGateway({} as GatewayBrowserClient);
    const childKeys = Array.from(
      { length: 6 },
      (_, index) => `agent:main:subagent:child-${index + 1}`,
    );
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    harness.list.mockResolvedValue({
      ts: 100_000,
      path: "",
      count: childKeys.length,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        ...childKeys.map((key, index) => ({
          key,
          spawnedBy: "agent:main:parent",
          kind: "direct" as const,
          label: `Subagent: Child ${index + 1}`,
          updatedAt: index + 1,
        })),
        // Quiet child beyond the cap with a RUNNING grandchild: the branch
        // must bypass the cap via the transitive runningChildCount.
        {
          key: "agent:main:subagent:grandchild",
          spawnedBy: "agent:main:subagent:child-6",
          kind: "direct" as const,
          label: "Subagent: Grandchild run",
          updatedAt: 10,
          status: "running" as const,
          hasActiveRun: true,
        },
      ],
    });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            label: "Parent task",
            updatedAt: 1,
            childSessions: childKeys,
          },
        ],
      },
    });
    await sidebar.updateComplete;

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
