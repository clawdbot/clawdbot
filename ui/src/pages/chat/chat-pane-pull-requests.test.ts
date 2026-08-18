/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  type ControlUiSessionPullRequest,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../lib/session-pull-requests.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

function pullRequest(
  number: number,
  state: ControlUiSessionPullRequest["state"],
): ControlUiSessionPullRequest {
  return {
    number,
    owner: "openclaw",
    repo: "openclaw",
    branch: "feature/demo",
    title: `Pull request ${number}`,
    url: `https://github.com/openclaw/openclaw/pull/${number}`,
    state,
  };
}

function createPullRequestPane(sessions: SessionCapability) {
  const request = vi.fn().mockResolvedValue({ subscribed: true });
  const harness = createTestChatPane({
    client: { request } as unknown as GatewayBrowserClient,
    sessions,
  });
  harness.pane.context.gateway.snapshot.hello = {
    features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
  } as never;
  return { ...harness, request };
}

function emitSnapshot(
  emitGatewayEvent: (event: string, payload: unknown) => void,
  sessionKey: string,
  snapshot: {
    branch?: {
      owner: string;
      repo: string;
      branch: string;
      createUrl?: string;
    };
    pullRequests: ControlUiSessionPullRequest[];
    rateLimited: boolean;
    status: "ready" | "rate-limited" | "unavailable";
  },
) {
  emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
    sessions: { [sessionKey]: snapshot },
  });
}

describe("chat pane pushed pull request state", () => {
  it("does not let a previous session delta clobber the current PR state", async () => {
    const { pane, state, emitGatewayEvent } = createPullRequestPane({
      capturePullRequestEpoch: vi.fn(() => Symbol("pr-refresh")),
      setPullRequestSummary: vi.fn(),
    } as unknown as SessionCapability);

    await pane.refreshSessionPullRequests();
    state.sessionKey = "agent:main:current-2";
    await pane.refreshSessionPullRequests();
    emitSnapshot(emitGatewayEvent, "agent:main:current", {
      pullRequests: [pullRequest(1, "open")],
      rateLimited: false,
      status: "ready",
    });
    await pane.refreshSessionPullRequests();
    emitSnapshot(emitGatewayEvent, "agent:main:current-2", {
      pullRequests: [pullRequest(2, "open")],
      rateLimited: false,
      status: "ready",
    });
    await pane.refreshSessionPullRequests();

    expect(pane.sessionPullRequests).toEqual([expect.objectContaining({ number: 2 })]);
  });

  it("subscribes and publishes pushed live PR state", async () => {
    const epoch = Symbol("pr-refresh");
    const setPullRequestSummary = vi.fn();
    const { pane, request, emitGatewayEvent } = createPullRequestPane({
      capturePullRequestEpoch: vi.fn(() => epoch),
      setPullRequestSummary,
    } as unknown as SessionCapability);

    await pane.refreshSessionPullRequests({ refresh: true });
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: ["agent:main:current"],
      refreshSessionKeys: ["agent:main:current"],
    });
    emitSnapshot(emitGatewayEvent, "agent:main:current", {
      pullRequests: [pullRequest(111772, "draft"), pullRequest(111751, "closed")],
      rateLimited: false,
      status: "ready",
    });
    await pane.refreshSessionPullRequests();

    expect(setPullRequestSummary).toHaveBeenCalledWith(
      "agent:main:current",
      { numbers: [111751, 111772], state: "draft" },
      epoch,
    );
  });

  it("retains the current PR when a pushed summary is truncated", async () => {
    const current = pullRequest(999, "draft");
    const older = Array.from({ length: 20 }, (_value, index) => pullRequest(index + 1, "closed"));
    const epoch = Symbol("pr-refresh");
    const setPullRequestSummary = vi.fn();
    const { pane, emitGatewayEvent } = createPullRequestPane({
      capturePullRequestEpoch: vi.fn(() => epoch),
      setPullRequestSummary,
    } as unknown as SessionCapability);
    await pane.refreshSessionPullRequests();
    emitSnapshot(emitGatewayEvent, "agent:main:current", {
      pullRequests: [current, ...older],
      rateLimited: false,
      status: "ready",
    });
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
    const { pane } = createPullRequestPane({} as SessionCapability);
    pane.sessionPullRequests = [pullRequest(111532, "open")];

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      phase: "reconnecting" as const,
    });

    expect(pane.sessionPullRequests).toEqual([]);
  });

  it("clears the pane snapshot while a structural replacement is pending", async () => {
    const { pane, emitGatewayEvent } = createPullRequestPane({
      capturePullRequestEpoch: vi.fn(() => Symbol("pr-refresh")),
      setPullRequestSummary: vi.fn(),
    } as unknown as SessionCapability);
    await pane.refreshSessionPullRequests();
    emitSnapshot(emitGatewayEvent, "agent:main:current", {
      branch: {
        owner: "openclaw",
        repo: "openclaw",
        branch: "feature/demo",
        createUrl: "https://github.com/openclaw/openclaw/pull/new/feature/demo",
      },
      pullRequests: [pullRequest(111532, "open")],
      rateLimited: false,
      status: "ready",
    });
    await pane.refreshSessionPullRequests();
    expect(pane.sessionPullRequests).toHaveLength(1);

    emitGatewayEvent("sessions.changed", {
      sessionKey: "agent:main:current",
      agentId: "main",
      reason: "branch-switch",
    });
    await pane.refreshSessionPullRequests();

    expect(pane.sessionPullRequests).toEqual([]);
    expect(pane.sessionPullRequestsBranch).toBeUndefined();
  });

  it("preserves shared PR state for an empty rate-limited snapshot", async () => {
    const setPullRequestSummary = vi.fn();
    const { pane, emitGatewayEvent } = createPullRequestPane({
      capturePullRequestEpoch: vi.fn(() => Symbol("pr-refresh")),
      setPullRequestSummary,
    } as unknown as SessionCapability);
    await pane.refreshSessionPullRequests();
    emitSnapshot(emitGatewayEvent, "agent:main:current", {
      pullRequests: [],
      rateLimited: true,
      status: "rate-limited",
    });
    await pane.refreshSessionPullRequests();

    expect(setPullRequestSummary).not.toHaveBeenCalled();
  });

  it("publishes merged PR state after the PR settles", async () => {
    const epoch = Symbol("pr-refresh");
    const setPullRequestSummary = vi.fn();
    const { pane, emitGatewayEvent } = createPullRequestPane({
      capturePullRequestEpoch: vi.fn(() => epoch),
      setPullRequestSummary,
    } as unknown as SessionCapability);
    await pane.refreshSessionPullRequests();
    emitSnapshot(emitGatewayEvent, "agent:main:current", {
      pullRequests: [pullRequest(111532, "merged")],
      rateLimited: false,
      status: "ready",
    });
    await pane.refreshSessionPullRequests();

    expect(setPullRequestSummary).toHaveBeenCalledWith(
      "agent:main:current",
      { numbers: [111532], state: "merged" },
      epoch,
    );
  });
});
