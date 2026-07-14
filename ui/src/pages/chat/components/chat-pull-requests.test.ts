/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../../src/gateway/control-ui-contract.js";
import {
  chatPullRequestId,
  createPullRequestBranch,
  dismissChatPullRequest,
  listDismissedChatPullRequests,
  renderChatPullRequests,
} from "./chat-pull-requests.ts";

function pullRequest(
  overrides: Partial<ControlUiSessionPullRequest> = {},
): ControlUiSessionPullRequest {
  return {
    number: 103469,
    owner: "openclaw",
    repo: "openclaw",
    branch: "claude/browser-tabs-tighter-header",
    title: "fix(macos): tighten the link-browser tab header",
    url: "https://github.com/openclaw/openclaw/pull/103469",
    state: "open",
    additions: 4,
    deletions: 3,
    checks: { state: "passing", passed: 5, failed: 0, skipped: 1, running: 0 },
    checksUrl: "https://github.com/openclaw/openclaw/pull/103469/checks",
    ...overrides,
  };
}

function sessionBranch(overrides: Partial<ControlUiSessionBranch> = {}): ControlUiSessionBranch {
  return {
    owner: "openclaw",
    repo: "openclaw",
    branch: "claude/cloud-workers-live-events",
    additions: 2819,
    deletions: 205,
    createUrl: "https://github.com/openclaw/openclaw/pull/new/claude/cloud-workers-live-events",
    ...overrides,
  };
}

describe("createPullRequestBranch", () => {
  it("passes the branch through when no live PR exists", () => {
    const branch = sessionBranch();
    expect(createPullRequestBranch([], branch)).toBe(branch);
    expect(createPullRequestBranch([pullRequest({ state: "merged" })], branch)).toBe(branch);
    expect(createPullRequestBranch([pullRequest({ state: "closed" })], branch)).toBe(branch);
  });

  it("hides the row while an open or draft PR exists, even a dismissed one", () => {
    expect(createPullRequestBranch([pullRequest()], sessionBranch())).toBeUndefined();
    expect(
      createPullRequestBranch([pullRequest({ state: "draft" })], sessionBranch()),
    ).toBeUndefined();
  });

  it("does not second-guess diff counts; the gateway owns branch emptiness", () => {
    expect(
      createPullRequestBranch([], sessionBranch({ additions: 0, deletions: 0 })),
    ).toBeDefined();
    expect(
      createPullRequestBranch([], sessionBranch({ additions: undefined, deletions: undefined })),
    ).toBeDefined();
    expect(createPullRequestBranch([], undefined)).toBeUndefined();
  });
});

describe("renderChatPullRequests", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders nothing without pull requests", () => {
    render(
      renderChatPullRequests({
        pullRequests: [],
        rateLimited: false,
        expanded: false,
        onExpand: () => {},
        onDismiss: () => {},
      }),
      container,
    );
    expect(container.querySelector(".chat-prs")).toBeNull();
  });

  it("renders an open PR chip with diff counts and CI state", () => {
    render(
      renderChatPullRequests({
        pullRequests: [pullRequest()],
        rateLimited: false,
        expanded: false,
        onExpand: () => {},
        onDismiss: () => {},
      }),
      container,
    );
    const chip = container.querySelector(".chat-pr");
    expect(chip?.getAttribute("data-state")).toBe("open");
    expect(chip?.querySelector(".chat-pr__number")?.textContent).toBe("#103469");
    expect(chip?.querySelector(".chat-pr__repo")?.textContent).toBe("openclaw");
    expect(chip?.querySelector(".chat-pr__branch")?.textContent).toBe(
      "claude/browser-tabs-tighter-header",
    );
    expect(chip?.querySelector(".chat-pr__additions")?.textContent).toBe("+4");
    expect(chip?.querySelector(".chat-pr__deletions")?.textContent).toBe("−3");
    const checks = chip?.querySelector<HTMLDetailsElement>(".chat-pr__checks");
    expect(checks?.getAttribute("data-checks")).toBe("passing");
    expect(chip?.querySelector(".chat-pr__link")?.getAttribute("href")).toBe(
      "https://github.com/openclaw/openclaw/pull/103469",
    );
    expect(chip?.querySelector(".chat-pr__warning")).toBeNull();
    expect(chip?.querySelector(".chat-pr__state")).toBeNull();
  });

  it("shows per-state check counts and a checks link in the CI popover", () => {
    render(
      renderChatPullRequests({
        pullRequests: [
          pullRequest({
            checks: { state: "failing", passed: 65, failed: 2, skipped: 31, running: 0 },
          }),
        ],
        rateLimited: false,
        expanded: false,
        onExpand: () => {},
        onDismiss: () => {},
      }),
      container,
    );
    const menu = container.querySelector(".chat-pr__checks-menu");
    const rowText = (modifier: string) =>
      menu?.querySelector(`.chat-pr__checks-row--${modifier}`)?.textContent?.replace(/\s+/g, " ");
    expect(rowText("passed")).toContain("Passed");
    expect(rowText("passed")).toContain("65");
    expect(rowText("failed")).toContain("2");
    expect(rowText("skipped")).toContain("31");
    // Zero-count states stay out of the popover.
    expect(menu?.querySelector(".chat-pr__checks-row--running")).toBeNull();
    expect(menu?.querySelector<HTMLAnchorElement>("a")?.href).toBe(
      "https://github.com/openclaw/openclaw/pull/103469/checks",
    );
    expect(container.querySelector(".chat-pr__checks")?.getAttribute("data-checks")).toBe(
      "failing",
    );
  });

  it("collapses to two chips preferring live PRs and expands via show more", () => {
    const onExpand = vi.fn();
    const pullRequests = [
      pullRequest({ number: 1, state: "merged", checks: undefined }),
      pullRequest({ number: 2, state: "merged", checks: undefined }),
      pullRequest({ number: 3, state: "open" }),
    ];
    render(
      renderChatPullRequests({
        pullRequests,
        rateLimited: false,
        expanded: false,
        onExpand,
        onDismiss: () => {},
      }),
      container,
    );
    const numbers = [...container.querySelectorAll(".chat-pr__number")].map(
      (node) => node.textContent,
    );
    // The open PR leads even though merged history came first from the server.
    expect(numbers).toEqual(["#3", "#1"]);
    const more = container.querySelector<HTMLButtonElement>(".chat-prs__more");
    expect(more?.textContent?.trim()).toBe("Show 1 more");
    more?.click();
    expect(onExpand).toHaveBeenCalledTimes(1);

    render(
      renderChatPullRequests({
        pullRequests,
        rateLimited: false,
        expanded: true,
        onExpand,
        onDismiss: () => {},
      }),
      container,
    );
    expect(container.querySelectorAll(".chat-pr")).toHaveLength(3);
    expect(container.querySelector(".chat-prs__more")).toBeNull();
  });

  it("renders merged PRs with a state label and without live-work signals", () => {
    render(
      renderChatPullRequests({
        pullRequests: [
          pullRequest({
            state: "merged",
            additions: undefined,
            deletions: undefined,
            checks: undefined,
            checksUrl: undefined,
          }),
        ],
        rateLimited: true,
        expanded: false,
        onExpand: () => {},
        onDismiss: () => {},
      }),
      container,
    );
    const chip = container.querySelector(".chat-pr");
    expect(chip?.getAttribute("data-state")).toBe("merged");
    expect(chip?.querySelector(".chat-pr__state")?.textContent?.trim()).toBe("Merged");
    expect(chip?.querySelector(".chat-pr__diff")).toBeNull();
    expect(chip?.querySelector(".chat-pr__checks")).toBeNull();
    // Merged is terminal, so the stale-data warning stays off merged chips.
    expect(chip?.querySelector(".chat-pr__warning")).toBeNull();
  });

  it("marks open chips stale when GitHub is rate limited", () => {
    render(
      renderChatPullRequests({
        pullRequests: [pullRequest()],
        rateLimited: true,
        expanded: false,
        onExpand: () => {},
        onDismiss: () => {},
      }),
      container,
    );
    expect(container.querySelector(".chat-pr__warning")).not.toBeNull();
  });

  it("renders a Create PR branch row with locale-formatted diff stats", () => {
    render(
      renderChatPullRequests({
        pullRequests: [],
        branch: sessionBranch(),
        rateLimited: false,
        expanded: false,
        onExpand: () => {},
        onDismiss: () => {},
      }),
      container,
    );
    const row = container.querySelector('.chat-pr[data-state="branch"]');
    expect(row?.querySelector(".chat-pr__repo")?.textContent).toBe("openclaw");
    expect(row?.querySelector(".chat-pr__branch")?.textContent).toBe(
      "claude/cloud-workers-live-events",
    );
    // Thousands separators match GitHub's diff-stat rendering.
    expect(row?.querySelector(".chat-pr__additions")?.textContent).toBe(
      `+${(2819).toLocaleString()}`,
    );
    expect(row?.querySelector(".chat-pr__deletions")?.textContent).toBe(
      `−${(205).toLocaleString()}`,
    );
    const create = row?.querySelector<HTMLAnchorElement>(".chat-pr__create");
    expect(create?.getAttribute("href")).toBe(
      "https://github.com/openclaw/openclaw/pull/new/claude/cloud-workers-live-events",
    );
    expect(create?.textContent?.trim()).toBe("Create PR");
    expect(row?.querySelector(".chat-pr__warning")).toBeNull();
    // The branch row is not dismissible; it reflects the checkout itself.
    expect(row?.querySelector(".chat-pr__dismiss")).toBeNull();
  });

  it("hides the Create PR link while the branch has no createUrl", () => {
    render(
      renderChatPullRequests({
        pullRequests: [],
        // Unpushed branch with local changed files: the gateway omits
        // createUrl because GitHub's pull/new page would 404.
        branch: sessionBranch({ createUrl: undefined, additions: 12, deletions: 3 }),
        rateLimited: false,
        expanded: false,
        onExpand: () => {},
        onDismiss: () => {},
      }),
      container,
    );
    const row = container.querySelector('.chat-pr[data-state="branch"]');
    expect(row?.querySelector(".chat-pr__branch")?.textContent).toBe(
      "claude/cloud-workers-live-events",
    );
    expect(row?.querySelector(".chat-pr__additions")?.textContent).toBe("+12");
    expect(row?.querySelector(".chat-pr__create")).toBeNull();
  });

  it("marks the branch row stale when GitHub is rate limited", () => {
    render(
      renderChatPullRequests({
        pullRequests: [],
        branch: sessionBranch(),
        rateLimited: true,
        expanded: false,
        onExpand: () => {},
        onDismiss: () => {},
      }),
      container,
    );
    const row = container.querySelector('.chat-pr[data-state="branch"]');
    // While rate limited, "no PR found" is unreliable; the warning says so.
    expect(row?.querySelector(".chat-pr__warning")).not.toBeNull();
    expect(row?.querySelector(".chat-pr__create")).not.toBeNull();
  });

  it("dismisses a chip through the X button", () => {
    const onDismiss = vi.fn();
    render(
      renderChatPullRequests({
        pullRequests: [pullRequest()],
        rateLimited: false,
        expanded: false,
        onExpand: () => {},
        onDismiss,
      }),
      container,
    );
    container.querySelector<HTMLButtonElement>(".chat-pr__dismiss")?.click();
    expect(onDismiss).toHaveBeenCalledWith(pullRequest());
  });
});

describe("dismissed pull request storage", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists dismissals per session", () => {
    const chip = pullRequest();
    expect(listDismissedChatPullRequests("agent:main:main").has(chatPullRequestId(chip))).toBe(
      false,
    );

    const ids = dismissChatPullRequest("agent:main:main", chip);

    expect(ids.has(chatPullRequestId(chip))).toBe(true);
    expect(listDismissedChatPullRequests("agent:main:main").has(chatPullRequestId(chip))).toBe(
      true,
    );
    expect(listDismissedChatPullRequests("agent:main:other").size).toBe(0);
  });

  it("drops the oldest sessions once the store limit is reached", () => {
    const chip = pullRequest();
    for (let index = 0; index < 21; index += 1) {
      dismissChatPullRequest(`agent:main:${index}`, chip);
    }
    expect(listDismissedChatPullRequests("agent:main:0").size).toBe(0);
    expect(listDismissedChatPullRequests("agent:main:20").size).toBe(1);
  });

  it("ignores malformed stored payloads", () => {
    localStorage.setItem("openclaw.chat.dismissedPullRequests", "not json");
    expect(listDismissedChatPullRequests("agent:main:main").size).toBe(0);
  });
});
