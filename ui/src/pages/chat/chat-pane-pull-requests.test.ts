/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  type ControlUiSessionPullRequest,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../lib/session-pull-requests.ts";
import { createSessionCapability, type SessionCapability } from "../../lib/sessions/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createRenderTestChatPane,
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

function createPublicationPane(scope?: "global" | "per-sender") {
  const agentId = scope ? "research" : "main";
  const sessionKey = scope ? "global" : "agent:main:publication";
  const shared = { source: "system-configured", accountId: 1, login: "system-bot" };
  const account = { accountId: 2, login: "alice-tools" };
  const generation = "bdca439a-e787-4f9f-b5f3-a878c662cc76";
  const options = {
    shared,
    personal: { state: "connected", generation, account },
    pendingPersonal: null,
  };
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
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
  const hello = gatewayHelloForMethods(
    ["sessions.github.publish", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
    ["operator.read", "operator.write"],
  );
  if (scope) {
    hello.snapshot = {
      sessionDefaults: {
        defaultAgentId: "ops",
        mainKey: "main",
        mainSessionKey: scope === "global" ? "global" : "agent:ops:main",
      },
    };
  }
  const gateway: ApplicationContext["gateway"] = {
    ...initial.gateway,
    snapshot: {
      ...initial.gateway.snapshot,
      client,
      phase: "connected",
      hello,
      assistantAgentId: agentId,
      sessionKey,
      selfUser: {
        id: "publication-person",
        identity: { type: "profile", id: "publication-person" },
      },
    },
  };
  const selection = {
    ...initial.agentSelection,
    state: { selectedId: agentId, scopeId: agentId },
    subscribe: () => () => {},
  };
  const context: ApplicationContext = {
    ...initial,
    gateway,
    agentSelection: selection,
    sessions: createSessionCapability(gateway, selection),
  };
  const pane = createRenderTestChatPane();
  Object.defineProperties(pane, {
    isConnected: { configurable: true, value: true },
    connectedClient: { configurable: true, value: client, writable: true },
  });
  const state = pane.initialize(context);
  onTestFinished(() => {
    pane.presented = false;
    context.sessions.dispose();
  });
  state.client = client;
  state.connected = true;
  state.sessionKey = sessionKey;
  state.assistantAgentId = agentId;
  state.sessionsResultAgentId = agentId;
  state.sessionsResult = {
    ts: 1,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    // Scoped lists may carry the owner only at the result/route level.
    sessions: [
      {
        key: sessionKey,
        sessionId: "publication",
        kind: scope ? "global" : "direct",
        updatedAt: 1,
      },
    ],
  };
  const settled = async () => {
    await vi.waitFor(() => {
      pane.render();
      expect(pane.chatProps?.githubPublication?.busy).toBe(false);
    });
    return pane.chatProps!.githubPublication!;
  };
  return { pane, state, context, request, options, shared, account, generation, settled };
}

describe("chat pane pushed pull request state", () => {
  it.each(["global", "per-sender"] as const)(
    "preserves the selected raw-global owner through publication RPCs in %s scope",
    async (scope) => {
      const { pane, request, options, account, generation, settled } = createPublicationPane(scope);
      const requestId = "bdca439a-e787-4f9f-b5f3-a878c662cc77";
      const result = {
        requestId,
        publisher: { source: "personal", ...account },
        status: "needs_confirmation",
      };
      const confirmation = {
        account,
        generation,
        requestDigest: "a".repeat(64),
        repository: "team/demo",
        pushRepository: "alice-tools/demo",
        branch: "feature/research",
        baseBranch: "main",
        sourceHeadCommit: "1".repeat(40),
        sourceIndexTree: "2".repeat(40),
        workspaceTree: "3".repeat(40),
      };
      request.mockImplementation(async (method) => {
        switch (method) {
          case "sessions.github.options":
            return options;
          case "sessions.github.publish":
            return result;
          case "sessions.github.status":
            return { result, confirmation };
          case "sessions.github.confirm":
            return { ...result, status: "published" };
          case SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD:
            return { subscribed: true };
          default:
            throw new Error(`Unexpected request: ${method}`);
        }
      });
      (await settled()).onSelect?.("personal");
      pane.render();
      pane.chatProps!.githubPublication!.onPublish?.();
      (await settled()).onConfirm?.();
      await settled();
      expect(
        request.mock.calls
          .map(([method]) => method)
          .filter((method) => method.startsWith("sessions.github.")),
      ).toEqual([
        "sessions.github.options",
        "sessions.github.publish",
        "sessions.github.status",
        "sessions.github.confirm",
      ]);
      for (const method of ["options", "publish", "status", "confirm"]) {
        expect
          .soft(request)
          .toHaveBeenCalledWith(
            `sessions.github.${method}`,
            expect.objectContaining({ sessionKey: "global", agentId: "research" }),
          );
      }
    },
  );

  it.each(["shared", "personal"] as const)(
    "retains an unknown %s publication across a retained-pane navigation",
    async (source) => {
      const { pane, state, request, shared, account, generation, settled } =
        createPublicationPane();
      (await settled()).onSelect?.(source);
      pane.render();
      pane.chatProps!.githubPublication!.onPublish?.();
      const unknown = await settled();
      expect(unknown.locked).toBe(true);
      const first = request.mock.calls.find(([method]) => method === "sessions.github.publish");
      expect(first?.[1]).toEqual({
        sessionKey: state.sessionKey,
        agentId: "main",
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
      const knownRoster = state.sessionsResult;
      if (!knownRoster) {
        throw new Error("Expected the publication roster to remain available");
      }
      state.sessionsResult = { ...knownRoster, count: 0, sessions: [] };
      const beforeMissingRow = request.mock.calls.length;
      returned.onPublish?.();
      returned.onRefresh();
      expect(request).toHaveBeenCalledTimes(beforeMissingRow);
      pane.render();
      expect(pane.chatProps?.githubPublication).toBeUndefined();
      state.sessionsResult = knownRoster;
      const restored = await settled();
      expect(restored.locked).toBe(true);
      expect(restored.selection).toEqual(unknown.selection);
      restored.onPublish?.();
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

it.each(["incarnation", "sharing", "archive-projection"] as const)(
  "rejects a stale idle publication before render: %s",
  async (change) => {
    const { pane, state, context, request, settled } = createPublicationPane();
    const idle = await settled();
    const current = state.sessionsResult!.sessions[0]!;
    const row = { ...current, updatedAt: 2 };
    if (change === "incarnation") {
      row.sessionId = "replacement";
    }
    if (change === "sharing") {
      row.visibility = "draft";
      row.sharingRole = "viewer";
    }
    if (change === "archive-projection") {
      state.selectedChatSessionArchived = true;
    }
    state.sessionsResult = { ...state.sessionsResult!, sessions: [row] };
    context.sessions.reconcile(row);
    // Canonical state changed, but Lit has not committed a replacement button yet.
    idle.onPublish?.();
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
    ).toHaveLength(0);
    pane.render();
  },
);
