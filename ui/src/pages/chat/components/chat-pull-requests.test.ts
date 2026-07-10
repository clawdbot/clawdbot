/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import {
  chatPullRequestId,
  dismissChatPullRequest,
  listDismissedChatPullRequests,
  renderChatPullRequests,
} from "./chat-pull-requests.ts";

const localStorageValues = vi.hoisted(() => new Map<string, string>());

vi.mock("../../../local-storage.ts", () => ({
  getSafeLocalStorage: () => ({
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    removeItem: (key: string) => localStorageValues.delete(key),
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
  }),
}));

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
    checks: "passing",
    checksUrl: "https://github.com/openclaw/openclaw/pull/103469/checks",
    ...overrides,
  };
}

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
      renderChatPullRequests({ pullRequests: [], rateLimited: false, onDismiss: () => {} }),
      container,
    );
    expect(container.querySelector(".chat-prs")).toBeNull();
  });

  it("renders an open PR chip with diff counts and CI state", () => {
    render(
      renderChatPullRequests({
        pullRequests: [pullRequest()],
        rateLimited: false,
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
    const checks = chip?.querySelector<HTMLAnchorElement>(".chat-pr__checks");
    expect(checks?.getAttribute("data-checks")).toBe("passing");
    expect(checks?.href).toBe("https://github.com/openclaw/openclaw/pull/103469/checks");
    expect(chip?.querySelector(".chat-pr__link")?.getAttribute("href")).toBe(
      "https://github.com/openclaw/openclaw/pull/103469",
    );
    expect(chip?.querySelector(".chat-pr__warning")).toBeNull();
    expect(chip?.querySelector(".chat-pr__state")).toBeNull();
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
        onDismiss: () => {},
      }),
      container,
    );
    expect(container.querySelector(".chat-pr__warning")).not.toBeNull();
  });

  it("dismisses a chip through the X button", () => {
    const onDismiss = vi.fn();
    render(
      renderChatPullRequests({ pullRequests: [pullRequest()], rateLimited: false, onDismiss }),
      container,
    );
    container.querySelector<HTMLButtonElement>(".chat-pr__dismiss")?.click();
    expect(onDismiss).toHaveBeenCalledWith(pullRequest());
  });
});

describe("dismissed pull request storage", () => {
  beforeEach(() => {
    localStorageValues.clear();
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
    localStorageValues.set("openclaw.chat.dismissedPullRequests", "not json");
    expect(listDismissedChatPullRequests("agent:main:main").size).toBe(0);
  });
});
