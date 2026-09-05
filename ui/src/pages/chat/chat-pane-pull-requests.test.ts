/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  type ControlUiSessionPullRequest,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../lib/session-pull-requests.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createRenderTestChatPane,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";

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
  const partialSessions = sessions as Partial<SessionCapability>;
  const sessionCapability = {
    ...sessions,
    pullRequestSummary: partialSessions.pullRequestSummary ?? vi.fn(() => undefined),
  } as SessionCapability;
  const harness = createTestChatPane({
    client: { request } as unknown as GatewayBrowserClient,
    sessions: sessionCapability,
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
  it.each(["shared", "personal"] as const)(
    "retains an unknown %s publication across a retained-pane navigation",
    async (source) => {
      const shared = { source: "system-configured", accountId: 1, login: "system-bot" };
      const account = { accountId: 2, login: "alice-tools" };
      const generation = "bdca439a-e787-4f9f-b5f3-a878c662cc76";
      const options = {
        shared,
        personal: { state: "connected", generation, account },
        pendingPersonal: null,
      };
      const request = vi.fn(async (method: string, _params?: unknown) => {
        if (method === "sessions.github.options") {
          return options;
        }
        if (method === SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD) {
          return { subscribed: true };
        }
        if (method === "sessions.github.publish") {
          throw new Error("Response lost");
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const client = createGatewayBrowserClientFixture({ request });
      const initial = createInitializationContext();
      const context: ApplicationContext = {
        ...initial,
        gateway: {
          ...initial.gateway,
          snapshot: {
            ...initial.gateway.snapshot,
            client,
            phase: "connected",
            hello: gatewayHelloForMethods(
              ["sessions.github.publish", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
              ["operator.read", "operator.write"],
            ),
          },
        },
        sessions: createSessionCapabilityFixture({
          state: initial.sessions.state,
          think: () => undefined,
          capturePullRequestEpoch: () => ({}),
        }),
      };
      const pane = createRenderTestChatPane();
      Object.defineProperties(pane, {
        isConnected: { configurable: true, value: true },
        connectedClient: { configurable: true, value: client, writable: true },
      });
      const state = pane.initialize(context);
      onTestFinished(() => {
        pane.presented = false;
      });
      state.client = client;
      state.connected = true;
      state.sessionKey = "agent:main:publication";
      state.sessionsResult = {
        ts: 1,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          { key: state.sessionKey, sessionId: "publication", kind: "direct", updatedAt: 1 },
        ],
      };
      const settled = async () => {
        await vi.waitFor(() => {
          pane.render();
          expect(pane.chatProps?.githubPublication?.busy).toBe(false);
        });
        return pane.chatProps!.githubPublication!;
      };
      (await settled()).onSelect?.(source);
      pane.render();
      pane.chatProps!.githubPublication!.onPublish?.();
      const unknown = await settled();
      expect(unknown.locked).toBe(true);
      const first = request.mock.calls.find(([method]) => method === "sessions.github.publish");
      expect(first?.[1]).toEqual({
        sessionKey: state.sessionKey,
        idempotencyKey: expect.any(String),
        selection:
          source === "shared" ? { source, expected: shared } : { source, generation, account },
      });

      pane.presented = false;
      pane.render();
      expect(pane.chatProps?.githubPublication).toBeUndefined();
      const hiddenRequests = request.mock.calls.length;
      unknown.onPublish?.();
      unknown.onRefresh();
      expect(request).toHaveBeenCalledTimes(hiddenRequests);
      pane.presented = true;
      const returned = await settled();

      expect(returned.locked).toBe(true);
      expect(returned.selection).toEqual(unknown.selection);
      returned.onPublish?.();
      await settled();
      expect(request.mock.calls.filter(([method]) => method === "sessions.github.publish")).toEqual(
        [first, first],
      );
    },
  );

  it("does not let a previous session delta clobber the current PR state", async () => {
    const { pane, state, emitGatewayEvent } = createPullRequestPane({
      capturePullRequestEpoch: vi.fn(() => ({})),
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
    const epoch = {};
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
    const epoch = {};
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
    const epoch = {};
    const setPullRequestSummary = vi.fn();
    const { pane, emitGatewayEvent } = createPullRequestPane({
      capturePullRequestEpoch: vi.fn(() => epoch),
      setPullRequestSummary,
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
    expect(setPullRequestSummary).toHaveBeenLastCalledWith("agent:main:current", undefined, epoch);
  });

  it("preserves shared PR state for an empty rate-limited snapshot", async () => {
    const setPullRequestSummary = vi.fn();
    const { pane, emitGatewayEvent } = createPullRequestPane({
      capturePullRequestEpoch: vi.fn(() => ({})),
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
    const epoch = {};
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
