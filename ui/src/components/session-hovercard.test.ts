/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiSessionPullRequestSnapshot } from "../../../src/gateway/control-ui-contract.js";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { renderSessionHovercard } from "./session-hovercard.ts";

function row(overrides: Partial<SidebarRecentSession> = {}): SidebarRecentSession {
  return {
    key: "agent:main:work",
    label: "Ship the release",
    startedAt: Date.now() - 2 * 60 * 60_000,
    updatedAt: Date.now() - 5 * 60_000,
    owner: { actor: { type: "human", id: "alice", label: "Alice Baker" } },
    children: [],
    ...overrides,
  } as SidebarRecentSession;
}

function snapshot(
  overrides: Partial<ControlUiSessionPullRequestSnapshot> = {},
): ControlUiSessionPullRequestSnapshot {
  return { status: "ready", pullRequests: [], rateLimited: false, ...overrides };
}

function progressCard(): ProgressCard {
  return {
    sessionKey: "agent:main:work",
    revision: 1,
    updatedAt: Date.now(),
    markdown: "**Release** is ready.",
    steps: [{ step: "Verify", status: "in_progress" }],
  };
}

describe("renderSessionHovercard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders synchronous row metadata without inventing a progress section", () => {
    const container = document.createElement("div");
    render(renderSessionHovercard({ row: row() }), container);

    expect(container.querySelector(".session-hovercard__title")?.textContent).toBe(
      "Ship the release",
    );
    expect(container.querySelector(".session-hovercard__avatar")?.textContent).toBe("AB");
    const metadata = container.querySelector(".session-hovercard__meta")?.textContent ?? "";
    expect(metadata).toContain("Alice Baker");
    expect(metadata).toContain("created");
    expect(metadata).toContain("updated");
    expect(container.querySelector(".session-progress-card")).toBeNull();
    expect(container.querySelector(".session-hovercard__excerpt")).toBeNull();
    expect(container.querySelector(".session-hovercard__divider")).toBeNull();
  });

  it("renders bounded linked PR chips with state, CI, and diff facts", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        pullRequests: snapshot({
          pullRequests: [
            {
              number: 101,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature",
              title: "First",
              url: "https://github.com/openclaw/openclaw/pull/101",
              state: "open",
              changedFiles: 2,
              additions: 7,
              deletions: 3,
              checks: { state: "passing", passed: 2, failed: 0, skipped: 0, running: 0 },
            },
            {
              number: 102,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature",
              title: "Second",
              url: "https://github.com/openclaw/openclaw/pull/102",
              state: "draft",
            },
            {
              number: 103,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature",
              title: "Third",
              url: "https://github.com/openclaw/openclaw/pull/103",
              state: "merged",
            },
            {
              number: 104,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature",
              title: "Fourth",
              url: "https://github.com/openclaw/openclaw/pull/104",
              state: "closed",
            },
          ],
        }),
      }),
      container,
    );

    const links = [...container.querySelectorAll<HTMLAnchorElement>(".session-hovercard__pr-chip")];
    expect(links).toHaveLength(3);
    expect(links[0]?.href).toBe("https://github.com/openclaw/openclaw/pull/101");
    expect(links[0]?.target).toBe("_blank");
    expect(links[0]?.rel).toContain("noopener");
    expect(links[0]?.querySelector(".session-hovercard__pr-number")?.textContent).toBe("#101");
    expect(links[0]?.querySelector(".session-hovercard__pr-state")?.textContent).toBe("Open");
    expect(links[0]?.querySelector("[data-checks='passing']")?.textContent).toBe("✓");
    expect(links[0]?.querySelector(".session-hovercard__files")?.textContent).toBe("2 files");
    expect(links[0]?.querySelector(".session-hovercard__additions")?.textContent).toBe("+7");
    expect(links[0]?.querySelector(".session-hovercard__deletions")?.textContent).toBe("−3");
    expect(container.querySelector(".session-hovercard__more")?.textContent).toBe("+1 more");
  });

  it("falls back to branch and diff chips with a create-PR link", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        row: row({ workSession: true, subtitle: "openclaw/openclaw · feature" }),
        pullRequests: snapshot({
          branch: {
            owner: "openclaw",
            repo: "openclaw",
            branch: "feature",
            changedFiles: 3,
            additions: 12,
            deletions: 4,
            createUrl: "https://github.com/openclaw/openclaw/pull/new/feature",
          },
        }),
      }),
      container,
    );

    expect(container.querySelector(".session-hovercard__branch-chip")?.textContent).toBe(
      "openclaw/openclaw · feature",
    );
    expect(container.querySelector(".session-hovercard__files")?.textContent).toBe("3 files");
    expect(container.querySelector(".session-hovercard__additions")?.textContent).toBe("+12");
    expect(container.querySelector(".session-hovercard__deletions")?.textContent).toBe("−4");
    const createLink = container.querySelector<HTMLAnchorElement>(".session-hovercard__no-pr a");
    expect(createLink?.textContent).toBe("No PR yet");
    expect(createLink?.href).toBe("https://github.com/openclaw/openclaw/pull/new/feature");
  });

  it("renders the latest turn as plain text when progress is absent", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        row: row({ lastMessagePreview: "  Finished <strong>without markup</strong>.  " }),
      }),
      container,
    );

    expect(container.querySelector(".session-hovercard__excerpt")?.textContent).toBe(
      "Finished <strong>without markup</strong>.",
    );
    expect(container.querySelector(".session-hovercard__excerpt strong")).toBeNull();
    expect(container.querySelector(".session-progress-card")).toBeNull();
  });

  it("renders progress instead of the latest-turn excerpt", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        row: row({ lastMessagePreview: "This must not appear." }),
        progressCard: progressCard(),
      }),
      container,
    );

    expect(container.querySelector(".session-progress-card")?.textContent).toContain("Release");
    expect(container.querySelector(".session-hovercard__excerpt")).toBeNull();
    expect(container.textContent).not.toContain("This must not appear.");
  });

  it("renders nothing when no session facts are known", () => {
    const container = document.createElement("div");
    render(renderSessionHovercard({}), container);

    expect(container.childElementCount).toBe(0);
  });
});
