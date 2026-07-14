import { describe, expect, it, vi } from "vitest";
import type { ControlUiSessionPullRequest } from "../../../src/gateway/control-ui-contract.js";
import { fetchSessionMenuWork } from "./session-menu-work.ts";

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
