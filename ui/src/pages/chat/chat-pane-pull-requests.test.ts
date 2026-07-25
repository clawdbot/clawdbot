/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat pane pull request refresh", () => {
  it("forwards an explicit refresh and publishes live PR state", async () => {
    const request = vi.fn().mockResolvedValue({
      pullRequests: [
        {
          number: 111772,
          owner: "openclaw",
          repo: "openclaw",
          branch: "claude/pr-detection",
          title: "Detect pull requests",
          url: "https://github.com/openclaw/openclaw/pull/111772",
          state: "draft",
        },
        {
          number: 111751,
          owner: "openclaw",
          repo: "openclaw",
          branch: "claude/pr-detection",
          title: "Earlier pull request",
          url: "https://github.com/openclaw/openclaw/pull/111751",
          state: "closed",
        },
      ],
      rateLimited: false,
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const epoch = Symbol("pr-refresh");
    const setPullRequestSummary = vi.fn();
    const sessions = {
      capturePullRequestEpoch: vi.fn(() => epoch),
      setPullRequestSummary,
    } as unknown as SessionCapability;
    const { pane } = createTestChatPane({ client, sessions });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["controlUi.sessionPullRequests"] },
    } as never;

    await pane.refreshSessionPullRequests({ refresh: true });

    expect(request).toHaveBeenCalledWith(
      "controlUi.sessionPullRequests",
      expect.objectContaining({ sessionKey: "agent:main:current", refresh: true }),
    );
    expect(setPullRequestSummary).toHaveBeenCalledWith(
      "agent:main:current",
      { numbers: [111751, 111772], state: "draft" },
      epoch,
    );
  });

  it("retains the current PR when a live summary is truncated", async () => {
    const current = {
      number: 999,
      owner: "openclaw",
      repo: "openclaw",
      branch: "claude/pr-detection",
      title: "Current pull request",
      url: "https://github.com/openclaw/openclaw/pull/999",
      state: "draft" as const,
    };
    const older = Array.from({ length: 20 }, (_value, index) => ({
      ...current,
      number: index + 1,
      title: `Earlier pull request ${index + 1}`,
      url: `https://github.com/openclaw/openclaw/pull/${index + 1}`,
      state: "closed" as const,
    }));
    const request = vi.fn().mockResolvedValue({
      pullRequests: [current, ...older],
      rateLimited: false,
    });
    const epoch = Symbol("pr-refresh");
    const setPullRequestSummary = vi.fn();
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {
        capturePullRequestEpoch: vi.fn(() => epoch),
        setPullRequestSummary,
      } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["controlUi.sessionPullRequests"] },
    } as never;

    await pane.refreshSessionPullRequests();

    expect(setPullRequestSummary).toHaveBeenCalledWith(
      "agent:main:current",
      {
        numbers: [...Array.from({ length: 19 }, (_value, index) => index + 1), 999],
        state: "draft",
      },
      epoch,
    );
  });

  it("clears the pane snapshot when the Gateway source disconnects", () => {
    const client = {} as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    pane.sessionPullRequests = [
      {
        number: 111532,
        owner: "openclaw",
        repo: "openclaw",
        branch: "claude/pr-detection",
        title: "Detect pull requests",
        url: "https://github.com/openclaw/openclaw/pull/111532",
        state: "open",
      },
    ];

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      phase: "reconnecting" as const,
    });

    expect(pane.sessionPullRequests).toEqual([]);
  });

  it("preserves shared PR state for an empty rate-limited snapshot", async () => {
    const request = vi.fn().mockResolvedValue({ pullRequests: [], rateLimited: true });
    const setPullRequestSummary = vi.fn();
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {
        capturePullRequestEpoch: vi.fn(() => Symbol("pr-refresh")),
        setPullRequestSummary,
      } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["controlUi.sessionPullRequests"] },
    } as never;

    await pane.refreshSessionPullRequests();

    expect(setPullRequestSummary).not.toHaveBeenCalled();
  });

  it("publishes merged PR state after the PR settles", async () => {
    const request = vi.fn().mockResolvedValue({
      pullRequests: [
        {
          number: 111532,
          owner: "openclaw",
          repo: "openclaw",
          branch: "claude/pr-detection",
          title: "Detect pull requests",
          url: "https://github.com/openclaw/openclaw/pull/111532",
          state: "merged",
        },
      ],
      rateLimited: false,
    });
    const epoch = Symbol("pr-refresh");
    const setPullRequestSummary = vi.fn();
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {
        capturePullRequestEpoch: vi.fn(() => epoch),
        setPullRequestSummary,
      } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["controlUi.sessionPullRequests"] },
    } as never;

    await pane.refreshSessionPullRequests();

    expect(setPullRequestSummary).toHaveBeenCalledWith(
      "agent:main:current",
      { numbers: [111532], state: "merged" },
      epoch,
    );
  });
});
