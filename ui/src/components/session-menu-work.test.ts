import { describe, expect, it, vi } from "vitest";
import type { ControlUiSessionPullRequest } from "../../../src/gateway/control-ui-contract.js";
import {
  fetchSessionMenuWork,
  resolveSessionPullRequestIndicatorState,
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

function sessionMenuClient(request: (method: string, params: unknown) => Promise<unknown>) {
  return {
    request: request as never,
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
  ] as const)("$name", ({ pullRequests, expected }) => {
    expect(resolveSessionPullRequestIndicatorState(pullRequests)).toBe(expected);
  });
});

describe("fetchSessionMenuWork", () => {
  it("resolves the PR URL and worktree path in one pass", async () => {
    const request = vi.fn((_method: string) => {
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
        client: sessionMenuClient(request),
        pullRequestsAvailable: true,
        sessionKey: "agent:main:demo",
        agentId: "main",
        loadPullRequests: async () => ({
          pullRequests: [pullRequest({ url: "https://example.test/pr" })],
          rateLimited: false,
          status: "ready",
        }),
        worktreeId: "wt-1",
      }),
    ).resolves.toEqual({
      pullRequestUrl: "https://example.test/pr",
      worktreePath: "/work/trees/demo",
    });
    expect(request).toHaveBeenCalledWith("worktrees.list", {});
  });

  it("returns nulls when the PR surface is absent, the worktree is removed, or requests fail", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("offline")));
    await expect(
      fetchSessionMenuWork({
        client: sessionMenuClient(failing),
        pullRequestsAvailable: true,
        sessionKey: "agent:main:demo",
        loadPullRequests: async () => {
          throw new Error("offline");
        },
        worktreeId: "wt-1",
      }),
    ).resolves.toEqual({ pullRequestUrl: null, worktreePath: null });

    const request = vi.fn(() =>
      Promise.resolve({ worktrees: [{ id: "wt-1", path: "/gone", removedAt: 5 }] }),
    );
    await expect(
      fetchSessionMenuWork({
        client: sessionMenuClient(request),
        pullRequestsAvailable: false,
        sessionKey: "agent:main:demo",
        worktreeId: "wt-1",
      }),
    ).resolves.toEqual({ pullRequestUrl: null, worktreePath: null });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("worktrees.list", {});
  });
});
