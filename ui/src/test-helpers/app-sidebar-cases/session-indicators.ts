import { describe, expect, it, vi } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../lib/session-pull-requests.ts";
import { createGatewayHarness, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";

function expectNoLead(row: Element | null) {
  expect(row?.querySelector(".sidebar-session-indicator")).toBeNull();
}

describe("AppSidebar session indicators", () => {
  it("preserves child PR indicators and gives a pinned child no extra state", async () => {
    const parentKey = "agent:main:parent";
    const pinnedKey = "agent:main:pinned-child";
    const runningKey = "agent:main:running-child";
    const openPullRequestKey = "agent:main:open-pr-child";
    const mergedPullRequestKey = "agent:main:merged-pr-child";
    const sessions = createSessionsHarness("main", [parentKey]);
    sessions.list.mockResolvedValue({
      ts: 2,
      path: "",
      count: 4,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: pinnedKey,
          spawnedBy: parentKey,
          kind: "direct",
          label: "Pinned child",
          updatedAt: 2,
          pinned: true,
          hasActiveRun: true,
          status: "running",
          unread: true,
          worktree: { id: "wt-pinned", branch: "feature/pinned", repoRoot: "/repo" },
        },
        {
          key: runningKey,
          spawnedBy: parentKey,
          kind: "direct",
          label: "Running child",
          updatedAt: 2,
          hasActiveRun: true,
          status: "running",
          unread: true,
          worktree: { id: "wt-running", branch: "feature/running", repoRoot: "/repo" },
        },
        {
          key: openPullRequestKey,
          spawnedBy: parentKey,
          kind: "direct",
          label: "Open PR child",
          updatedAt: 2,
          worktree: { id: "wt-open", branch: "feature/open", repoRoot: "/repo" },
        },
        {
          key: mergedPullRequestKey,
          spawnedBy: parentKey,
          kind: "direct",
          label: "Merged PR child",
          updatedAt: 2,
          worktree: { id: "wt-merged", branch: "feature/merged", repoRoot: "/repo" },
        },
      ],
    });
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, sessions.sessions);
    sessions.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: parentKey,
            kind: "direct",
            label: "Parent",
            updatedAt: 1,
            childSessions: [pinnedKey, runningKey, openPullRequestKey, mergedPullRequestKey],
          },
        ],
      },
    });
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(4),
    );
    Object.assign(sidebar, {
      sessionPullRequestIndicatorState: (key: string) =>
        key === mergedPullRequestKey ? "merged" : "open",
    });
    sidebar.requestUpdate();
    await sidebar.updateComplete;

    await waitForFast(() => {
      expect(
        sidebar.querySelector(
          `[data-session-key="${openPullRequestKey}"] [data-session-pr-state="open"]`,
        ),
      ).not.toBeNull();
      expect(
        sidebar.querySelector(
          `[data-session-key="${mergedPullRequestKey}"] [data-session-pr-state="merged"]`,
        ),
      ).not.toBeNull();
    });
    // Pinning is not a status: a pinned child in the same run/unread state has
    // to produce byte-identical trailing state to an unpinned one.
    const pinnedRow = sidebar.querySelector(`[data-session-key="${pinnedKey}"]`);
    const runningRow = sidebar.querySelector(`[data-session-key="${runningKey}"]`);
    expectNoLead(pinnedRow);
    expectNoLead(runningRow);
    const endcapShape = (row: Element | null | undefined) =>
      row?.querySelector(".session-row-aside")?.innerHTML.replace(/ id="[^"]*"/g, "");
    expect(endcapShape(pinnedRow)).toBe(endcapShape(runningRow));
  });

  it("leaves a failure the reader has already seen dismissed", async () => {
    const seen = "agent:main:seen-failure";
    const pending = "agent:main:pending-failure";
    const sessions = createSessionsHarness("main", [seen, pending]);
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    for (const row of result.sessions) {
      row.status = "failed";
      row.endedAt = 10;
      row.lastRunError = "Provider credits exhausted";
      row.lastReadAt = row.key === seen ? 20 : undefined;
    }
    const { sidebar } = await mountSidebar(
      createGatewayHarness({} as unknown as GatewayBrowserClient).gateway,
      sessions.sessions,
    );
    await sidebar.updateComplete;

    // Opening the session cleared its attention; reading the raw status again
    // would hand the row back a danger dot the reader already dealt with.
    expect(
      sidebar.querySelector(`[data-session-key="${seen}"] .session-state-dot--blocked`),
    ).toBeNull();
    expect(
      sidebar.querySelector(`[data-session-key="${pending}"] .session-state-dot--blocked`),
    ).not.toBeNull();
  });

  it("reports every session's operational state through the trailing endcap", async () => {
    const keys = {
      plain: "agent:main:plain",
      forked: "agent:main:forked",
      unread: "agent:main:unread",
      runningUnread: "agent:main:status-running-unread",
      openPullRequest: "agent:main:open-pr",
      mergedPullRequest: "agent:main:merged-pr",
    };
    const sessions = createSessionsHarness("main", Object.values(keys));
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    for (const row of result.sessions) {
      if (row.key === keys.forked) {
        row.forkSource = { sessionKey: "agent:main:main", sessionId: "source-session" };
      } else if (row.key === keys.unread) {
        row.unread = true;
      } else if (row.key === keys.runningUnread) {
        row.status = "running";
        row.unread = true;
      } else if (row.key === keys.openPullRequest || row.key === keys.mergedPullRequest) {
        row.worktree = {
          id: `wt-${row.key}`,
          branch: row.key.endsWith("open-pr") ? "feature/open" : "feature/merged",
          repoRoot: "/repo",
        };
      }
    }
    const request = vi.fn(() => Promise.resolve({ subscribed: true }));
    const gatewayHarness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    gatewayHarness.publish({
      hello: {
        features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, sessions.sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;
    await waitForFast(() => {
      expect(request).toHaveBeenCalledWith(
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        expect.objectContaining({
          sessionKeys: expect.arrayContaining([keys.openPullRequest, keys.mergedPullRequest]),
        }),
      );
    });
    gatewayHarness.publishEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: Object.fromEntries(
        [keys.openPullRequest, keys.mergedPullRequest].map((key) => [
          key,
          {
            pullRequests: [
              {
                number: 1,
                owner: "openclaw",
                repo: "openclaw",
                branch: "feature/test",
                title: "Test",
                url: "https://example.test/pr/1",
                state: key.endsWith("open-pr") ? "open" : "merged",
              },
            ],
            rateLimited: false,
            status: "ready",
          },
        ]),
      ),
    });

    await waitForFast(() => {
      expect(sidebar.querySelector('[data-session-pr-state="open"]')).not.toBeNull();
      expect(sidebar.querySelector('[data-session-pr-state="merged"]')).not.toBeNull();
    });
    const plain = sidebar.querySelector(`[data-session-key="${keys.plain}"]`);
    expectNoLead(plain);
    expect(plain?.querySelector(".session-row-state")).toBeNull();

    // A fork is provenance, not operational state, so it earns no row glyph.
    const forked = sidebar.querySelector(`[data-session-key="${keys.forked}"]`);
    expectNoLead(forked);
    expect(forked?.querySelector(".session-row-fork-indicator")).toBeNull();
    expect(forked?.querySelector(".session-row-state")).toBeNull();

    const unread = sidebar.querySelector(`[data-session-key="${keys.unread}"]`);
    expectNoLead(unread);
    expect(
      unread?.querySelector(".session-row-aside > .session-row-state .session-state-dot--unread"),
    ).not.toBeNull();

    const runningUnread = sidebar.querySelector(`[data-session-key="${keys.runningUnread}"]`);
    expect(runningUnread?.classList.contains("session-row-host--running")).toBe(true);
    expectNoLead(runningUnread);
    expect(
      runningUnread?.querySelector(".session-row-aside > .session-row-state .session-run-spinner"),
    ).not.toBeNull();
    expect(runningUnread?.querySelector(".session-state-dot--unread")).toBeNull();

    for (const key of [keys.unread, keys.runningUnread]) {
      const link = sidebar.querySelector(`[data-session-key="${key}"] a`);
      const descriptionId = link?.getAttribute("aria-describedby");
      expect(descriptionId).toBe(`sidebar-session-state-${encodeURIComponent(key)}`);
      expect(sidebar.querySelector(`[id="${descriptionId}"]`)).not.toBeNull();
    }
    expect(forked?.querySelector("a")?.getAttribute("aria-describedby")).toBeNull();
    expect(unread?.querySelector("a")?.getAttribute("title")).toContain("Unread");
    expect(runningUnread?.querySelector("a")?.getAttribute("title")).toContain("Active run");
    // A live run supersedes unread, in the title as well as in the endcap.
    expect(runningUnread?.querySelector("a")?.getAttribute("title")).not.toContain("Unread");
    expect(runningUnread?.querySelector(".session-row-state")?.getAttribute("aria-label")).toBe(
      "Active run",
    );

    for (const key of [keys.openPullRequest, keys.mergedPullRequest]) {
      const row = sidebar.querySelector(`[data-session-key="${key}"]`);
      expectNoLead(row);
      expect(row?.querySelector(".session-row-aside [data-session-pr-state]")).not.toBeNull();
      expect(row?.querySelector("a")?.getAttribute("title")).toContain(
        key === keys.openPullRequest ? "Open PR" : "Merged",
      );
      expect(row?.querySelector("[data-session-pr-state]")?.hasAttribute("title")).toBe(false);
    }

    const openPullRequestRow = result.sessions.find((row) => row.key === keys.openPullRequest);
    if (!openPullRequestRow) {
      throw new Error("expected open PR session");
    }
    openPullRequestRow.worktree = undefined;
    sessions.publishList({ result });
    await waitForFast(() => {
      expect(sidebar.querySelector('[data-session-pr-state="open"]')).toBeNull();
      expectNoLead(sidebar.querySelector(`[data-session-key="${keys.openPullRequest}"]`));
    });
  });
});
