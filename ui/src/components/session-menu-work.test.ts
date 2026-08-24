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

function sessionMenuClient(
  request: (method: string, params: unknown) => Promise<unknown>,
  gatewayUrl = "ws://localhost:18789",
) {
  return {
    gatewayUrl,
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
  it.each([
    { name: "localhost", gatewayUrl: "ws://localhost:18789", expectedPath: "/work/trees/demo" },
    { name: "same-origin relative URL", gatewayUrl: "/gateway", expectedPath: "/work/trees/demo" },
    {
      name: "IPv4 loopback block",
      gatewayUrl: "ws://127.0.0.5:18789",
      expectedPath: "/work/trees/demo",
    },
    { name: "IPv6 loopback", gatewayUrl: "ws://[::1]:18789", expectedPath: "/work/trees/demo" },
    { name: "remote gateway", gatewayUrl: "wss://gateway.example.test", expectedPath: null },
    { name: "gateway LAN address", gatewayUrl: "ws://192.168.1.5:18789", expectedPath: null },
    {
      name: "deceptive loopback hostname",
      gatewayUrl: "wss://127.0.0.1.evil.com",
      expectedPath: null,
    },
    {
      name: "remote execution node",
      gatewayUrl: "ws://localhost:18789",
      execNode: "build-mac",
      expectedPath: null,
    },
  ])("exposes editor paths only for viewer-local files: $name", async (testCase) => {
    const request = vi.fn(async () => ({
      worktrees: [{ id: "wt-1", path: "/work/trees/demo" }],
    }));

    await expect(
      fetchSessionMenuWork({
        client: sessionMenuClient(request, testCase.gatewayUrl),
        loadPullRequests: async () => ({
          pullRequests: [pullRequest({ url: "https://example.test/pr" })],
          rateLimited: false,
          status: "ready",
        }),
        worktreeId: "wt-1",
        execNode: testCase.execNode,
      }),
    ).resolves.toEqual({
      pullRequestUrl: "https://example.test/pr",
      worktreePath: testCase.expectedPath,
    });
    expect(request).toHaveBeenCalledTimes(testCase.expectedPath ? 1 : 0);
  });

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
        worktreeId: "wt-1",
      }),
    ).resolves.toEqual({ pullRequestUrl: null, worktreePath: null });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("worktrees.list", {});
  });
});
