import { describe, expect, it, vi } from "vitest";
import type { ControlUiSessionPullRequest } from "../../../src/gateway/control-ui-contract.js";
import {
  fetchSessionMenuWork,
  fetchSessionPullRequestIndicatorState,
} from "./session-menu-work.ts";

function pullRequest(overrides: Partial<ControlUiSessionPullRequest>): ControlUiSessionPullRequest {
  return {
    number: 1,
    owner: "openclaw",
    repo: "openclaw",
    branch: "feature/demo",
    title: "Demo",
    url: "https://github.com/openclaw/openclaw/pull/1",
    state: "open",
    ...overrides,
  };
}

describe("session pull request indicators", () => {
  it.each([
    {
      name: "prioritizes an active PR over merged history",
      pullRequests: [
        pullRequest({ number: 1, state: "merged" }),
        pullRequest({ number: 2, state: "draft" }),
      ],
      expected: "open",
    },
    {
      name: "shows merged history",
      pullRequests: [pullRequest({ state: "merged" })],
      expected: "merged",
    },
    {
      name: "ignores closed history",
      pullRequests: [pullRequest({ state: "closed" })],
      expected: "none",
    },
  ] as const)("$name", async ({ pullRequests, expected }) => {
    const request = vi.fn(() => Promise.resolve({ pullRequests, rateLimited: false }));
    await expect(
      fetchSessionPullRequestIndicatorState({
        client: { request: request as never },
        pullRequestsAvailable: true,
        sessionKey: "agent:main:demo",
      }),
    ).resolves.toBe(expected);
  });

  it("preserves the prior indicator when the gateway is rate limited", async () => {
    const request = vi.fn(() => Promise.resolve({ pullRequests: [], rateLimited: true }));
    await expect(
      fetchSessionPullRequestIndicatorState({
        client: { request: request as never },
        pullRequestsAvailable: true,
        sessionKey: "agent:main:demo",
      }),
    ).resolves.toBeNull();
  });

  it("loads the compact indicator state through the existing PR surface", async () => {
    const request = vi.fn(() =>
      Promise.resolve({ pullRequests: [pullRequest({ state: "merged" })], rateLimited: false }),
    );

    await expect(
      fetchSessionPullRequestIndicatorState({
        client: { request: request as never },
        pullRequestsAvailable: true,
        sessionKey: "agent:main:demo",
        agentId: "main",
      }),
    ).resolves.toBe("merged");
    expect(request).toHaveBeenCalledWith("controlUi.sessionPullRequests", {
      sessionKey: "agent:main:demo",
      agentId: "main",
    });
  });
});

describe("fetchSessionMenuWork", () => {
  it("resolves the PR URL and worktree path in one pass", async () => {
    const request = vi.fn((method: string) => {
      if (method === "controlUi.sessionPullRequests") {
        return Promise.resolve({
          pullRequests: [pullRequest({ url: "https://example.test/pr" })],
          rateLimited: false,
        });
      }
      return Promise.resolve({
        worktrees: [
          {
            id: "wt-1",
            path: "/work/trees/demo",
            removedAt: undefined,
          },
          {
            id: "wt-removed",
            path: "/work/trees/stale",
            removedAt: 123,
          },
        ],
      });
    });

    await expect(
      fetchSessionMenuWork({
        client: { request: request as never },
        pullRequestsAvailable: true,
        sessionKey: "agent:main:demo",
        agentId: "main",
        worktreeId: "wt-1",
      }),
    ).resolves.toEqual({
      pullRequestUrl: "https://example.test/pr",
      worktreePath: "/work/trees/demo",
    });
    expect(request).toHaveBeenCalledWith("controlUi.sessionPullRequests", {
      sessionKey: "agent:main:demo",
      agentId: "main",
    });
  });

  it("returns nulls when the PR surface is absent, the worktree is removed, or requests fail", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("offline")));
    await expect(
      fetchSessionMenuWork({
        client: { request: failing as never },
        pullRequestsAvailable: true,
        sessionKey: "agent:main:demo",
        worktreeId: "wt-1",
      }),
    ).resolves.toEqual({ pullRequestUrl: null, worktreePath: null });

    const request = vi.fn(() =>
      Promise.resolve({ worktrees: [{ id: "wt-1", path: "/gone", removedAt: 5 }] }),
    );
    await expect(
      fetchSessionMenuWork({
        client: { request: request as never },
        pullRequestsAvailable: false,
        sessionKey: "agent:main:demo",
        worktreeId: "wt-1",
      }),
    ).resolves.toEqual({ pullRequestUrl: null, worktreePath: null });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("worktrees.list", {});
  });
});
