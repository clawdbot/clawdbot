import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { workProjectSectionId } from "../../lib/sessions/catalog-project-grouping.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

async function mountWithRows(rows: GatewaySessionRow[]) {
  const harness = createSessionsHarness("main", ["agent:main:main"]);
  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    harness.sessions,
  );
  harness.publishList({
    result: {
      ts: 2,
      path: "",
      count: rows.length,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: rows,
    } satisfies SessionsListResult,
  });
  await sidebar.updateComplete;
  return sidebar;
}

function projectLabels(sidebar: Element): string[] {
  return [...sidebar.querySelectorAll("[data-session-work-project]")].map(
    (project) =>
      project.querySelector(".sidebar-session-catalog-project__label")?.textContent?.trim() ?? "",
  );
}

function subtitleOf(sidebar: Element, key: string): Element | null {
  return sidebar.querySelector(`[data-session-key="${key}"] .sidebar-recent-session__subtitle`);
}

describe("AppSidebar coding project hierarchy", () => {
  it("groups coding sessions by their real project and leaves factless work flat", async () => {
    const sidebar = await mountWithRows([
      {
        key: "agent:main:openclaw",
        kind: "direct",
        label: "Sidebar rework",
        updatedAt: 5,
        worktree: { id: "wt-1", branch: "feature/sidebar", repoRoot: "/Users/ada/code/openclaw" },
      },
      {
        key: "agent:main:clawhub",
        kind: "direct",
        label: "Publish flow",
        updatedAt: 4,
        worktree: { id: "wt-2", branch: "main", repoRoot: "/Users/ada/code/clawhub" },
      },
      {
        key: "agent:main:cwd-only",
        kind: "direct",
        label: "Scratch",
        updatedAt: 3,
        execNode: "node-a",
        execCwd: "/Users/ada/code/clawhub",
      },
      {
        key: "agent:main:factless",
        kind: "direct",
        label: "Remote work",
        updatedAt: 2,
        execNode: "node-b",
      },
    ]);

    // Two distinct projects, never one project heading twice.
    expect(projectLabels(sidebar)).toEqual(["openclaw", "clawhub"]);
    const clawhub = sidebar.querySelector('[data-session-work-project="/Users/ada/code/clawhub"]');
    expect(clawhub?.querySelectorAll("[data-session-key]")).toHaveLength(2);
    expect(
      sidebar
        .querySelector('[data-session-key="agent:main:factless"]')
        ?.closest("[data-session-work-project]"),
    ).toBeNull();
  });

  it("stops treating a folded project's rows as visible sessions", async () => {
    const sidebar = await mountWithRows([
      {
        key: "agent:main:openclaw",
        kind: "direct",
        label: "Sidebar rework",
        updatedAt: 5,
        worktree: { id: "wt-1", branch: "feature/sidebar", repoRoot: "/Users/ada/code/openclaw" },
      },
      {
        key: "agent:main:clawhub",
        kind: "direct",
        label: "Publish flow",
        updatedAt: 4,
        worktree: { id: "wt-2", branch: "main", repoRoot: "/Users/ada/code/clawhub" },
      },
    ]);
    sidebar.selectedSessionKeys = new Set(["agent:main:openclaw", "agent:main:clawhub"]);
    await sidebar.updateComplete;
    expect(sidebar.selectedVisibleSessions().map((row) => row.key)).toEqual([
      "agent:main:openclaw",
      "agent:main:clawhub",
    ]);

    sidebar.toggleSection(workProjectSectionId("/Users/ada/code/openclaw"));
    await sidebar.updateComplete;

    // Folding a project hides its rows; batch archive and delete read this
    // projection, so a hidden session must not still be one of their targets.
    expect(sidebar.querySelector('[data-session-key="agent:main:openclaw"]')).toBeNull();
    expect(sidebar.selectedVisibleSessions().map((row) => row.key)).toEqual(["agent:main:clawhub"]);
  });

  it("gives a project heading no row count", async () => {
    const sidebar = await mountWithRows([
      {
        key: "agent:main:openclaw",
        kind: "direct",
        label: "Sidebar rework",
        updatedAt: 5,
        worktree: { id: "wt-1", branch: "feature/sidebar", repoRoot: "/Users/ada/code/openclaw" },
      },
    ]);

    expect(
      sidebar.querySelector("[data-session-work-project] .sidebar-session-group-count"),
    ).toBeNull();
  });

  it("names a project by its workspace mark and hangs its sessions off the label", async () => {
    const sidebar = await mountWithRows([
      {
        key: "agent:main:openclaw",
        kind: "direct",
        label: "Sidebar rework",
        updatedAt: 5,
        worktree: { id: "wt-1", branch: "feature/sidebar", repoRoot: "/Users/ada/code/openclaw" },
      },
    ]);

    const project = sidebar.querySelector('[data-session-work-project="/Users/ada/code/openclaw"]');
    // The mark is the workspace's own asset route; the element itself decides
    // when to fall back to the folder glyph, so the header must not pre-empt it.
    expect(
      project?.querySelector(".sidebar-session-group-toggle__lead openclaw-workspace-icon"),
    ).not.toBeNull();
    // Rows sit on the project's text axis: without this they share the header's
    // left edge and the group reads as a flat list with a label on top.
    const sessions = project?.querySelector(".sidebar-session-catalog-project__sessions");
    expect(sessions?.querySelector('[data-session-key="agent:main:openclaw"]')).not.toBeNull();
  });

  it("marks a branch as a branch and leaves prose unmarked", async () => {
    const sidebar = await mountWithRows([
      {
        key: "agent:main:git",
        kind: "direct",
        label: "Sidebar rework",
        updatedAt: 5,
        worktree: { id: "wt-1", branch: "feature/sidebar", repoRoot: "/Users/ada/code/openclaw" },
      },
      {
        key: "agent:main:chat",
        kind: "direct",
        label: "Plain chat",
        updatedAt: 4,
        lastMessagePreview: "Shipped the release notes",
      },
    ]);

    const git = subtitleOf(sidebar, "agent:main:git");
    expect(git?.querySelector(".session-row-git-glyph")).not.toBeNull();
    // Inside the openclaw group the row does not repeat "openclaw".
    expect(git?.querySelector(".sidebar-recent-session__subtitle-text")?.textContent).toBe(
      "feature/sidebar",
    );

    const chat = subtitleOf(sidebar, "agent:main:chat");
    expect(chat?.textContent?.trim()).toBe("Shipped the release notes");
    expect(chat?.querySelector(".session-row-git-glyph")).toBeNull();
  });

  it("keeps a trailing worktree marker on a session with its own checkout", async () => {
    const sidebar = await mountWithRows([
      {
        key: "agent:main:worktree",
        kind: "direct",
        label: "Isolated work",
        updatedAt: 5,
        worktree: {
          id: "wt-1",
          branch: "openclaw/sidebar-cards",
          repoRoot: "/Users/ada/code/openclaw",
        },
      },
      {
        key: "agent:main:shared",
        kind: "direct",
        label: "Shared checkout",
        updatedAt: 4,
        worktree: { id: "wt-2", branch: "main", repoRoot: "/Users/ada/code/openclaw" },
      },
    ]);

    const worktree = subtitleOf(sidebar, "agent:main:worktree");
    expect(worktree?.querySelector(".session-row-worktree-glyph")).not.toBeNull();
    // The branch reads without the worktree prefix the marker already reports.
    expect(worktree?.querySelector(".sidebar-recent-session__subtitle-text")?.textContent).toBe(
      "sidebar-cards",
    );
    expect(
      subtitleOf(sidebar, "agent:main:shared")?.querySelector(".session-row-worktree-glyph"),
    ).toBeNull();
  });
});
