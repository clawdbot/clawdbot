import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiSessionPullRequest } from "../../../src/gateway/control-ui-contract.js";
import { isLoopbackHostname } from "../lib/gateway-locality.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../test-helpers/native-gateways.ts";
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

function sessionMenuClient(request: (method: string, params: unknown) => Promise<unknown>) {
  return { request: request as never };
}

beforeEach(() => {
  setNativeGatewayTestState("local");
});

afterEach(() => {
  clearNativeGatewayTestState();
  vi.restoreAllMocks();
});

describe("isLoopbackHostname", () => {
  it.each([
    ["127.0.0.5", true],
    ["[::1]", true],
    ["127.0.0.1.evil.com", false],
  ])("classifies %s as loopback: %s", (hostname, expected) => {
    expect(isLoopbackHostname(hostname)).toBe(expected);
  });
});

describe("fetchSessionMenuWork", () => {
  it.each([
    { name: "plain browser", nativeGateway: null, expectedPath: null },
    { name: "native local gateway", nativeGateway: "local", expectedPath: "/work/trees/demo" },
    { name: "native remote gateway", nativeGateway: "remote", expectedPath: null },
    {
      name: "remote execution node",
      nativeGateway: "local",
      execNode: "build-mac",
      expectedPath: null,
    },
  ] as const)("exposes editor paths only for native-local files: $name", async (testCase) => {
    setNativeGatewayTestState(testCase.nativeGateway);
    const request = vi.fn(async () => ({
      worktrees: [{ id: "wt-1", path: "/work/trees/demo" }],
    }));

    await expect(
      fetchSessionMenuWork({
        client: sessionMenuClient(request),
        loadPullRequests: async () => ({
          pullRequests: [pullRequest({ url: "https://example.test/pr" })],
          rateLimited: false,
          status: "ready",
        }),
        worktreeId: "wt-1",
        execNode: "execNode" in testCase ? testCase.execNode : undefined,
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
