import { describe, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  refreshPullRequestsForFinalReply,
  refreshPullRequestsForStreamedLinks,
  retirePullRequestRefreshes,
} from "./chat-pull-request-refresh.ts";

type Host = Parameters<typeof refreshPullRequestsForFinalReply>[0];

function createHost() {
  const refresh = vi.fn(() => true);
  const state: Host = {
    client: createTestGatewayClient(() => ({})),
    connectionEpoch: 1,
    sessionKey: "agent:main:demo",
    refreshSessionPullRequests: refresh,
  };
  return { state, refresh };
}

const text = "Opened https://github.com/openclaw/openclaw/pull/111532";
const message = { role: "assistant", content: [{ type: "text", text }] };

describe("PR refresh emission receipts", () => {
  it.each(["stream", "final"] as const)("records only admitted %s refreshes", (phase) => {
    const { state, refresh } = createHost();
    const emit = () =>
      phase === "stream"
        ? refreshPullRequestsForStreamedLinks(state, "run-1", text)
        : refreshPullRequestsForFinalReply(state, "run-1", message);
    refresh.mockReturnValueOnce(false);
    emit();
    emit();
    emit();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith({ refresh: true });
  });

  it("does not consume a final before its refresh callback is installed", () => {
    const { state, refresh } = createHost();
    state.refreshSessionPullRequests = undefined;
    refreshPullRequestsForFinalReply(state, "run-1", message);
    state.refreshSessionPullRequests = refresh;
    refreshPullRequestsForFinalReply(state, "run-1", message);
    refreshPullRequestsForFinalReply(state, "run-1", message);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "legacy text normalization", first: { text }, second: message, expected: 1 },
    {
      name: "distinct native IDs",
      first: { ...message, __openclaw: { id: "first" } },
      second: { ...message, __openclaw: { id: "second" } },
      expected: 2,
    },
    {
      name: "import identity before native IDs",
      first: {
        ...message,
        __openclaw: {
          id: "first",
          importedFrom: "fixture",
          cliSessionId: "source",
          externalId: "same",
        },
      },
      second: {
        ...message,
        __openclaw: {
          id: "second",
          importedFrom: "fixture",
          cliSessionId: "source",
          externalId: "same",
        },
      },
      expected: 1,
    },
    {
      name: "distinct sequence identities",
      first: { ...message, __openclaw: { seq: 1 } },
      second: { ...message, __openclaw: { seq: 2 } },
      expected: 2,
    },
  ])("reuses canonical final identity for $name", ({ first, second, expected }) => {
    const { state, refresh } = createHost();
    refreshPullRequestsForFinalReply(state, "run-1", first);
    refreshPullRequestsForFinalReply(state, "run-1", second);
    expect(refresh).toHaveBeenCalledTimes(expected);
  });

  it.each(["connection epoch", "client", "conversation", "explicit reset"])(
    "retires receipts with their %s owner",
    (change) => {
      const { state, refresh } = createHost();
      refreshPullRequestsForFinalReply(state, "run-1", message);
      if (change === "connection epoch") {
        state.connectionEpoch += 1;
      }
      if (change === "client") {
        state.client = createTestGatewayClient(() => ({}));
      }
      if (change === "conversation") {
        state.sessionKey = "agent:main:other";
      }
      if (change === "explicit reset") {
        retirePullRequestRefreshes(state);
      }
      refreshPullRequestsForFinalReply(state, "run-1", message);
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );

  it("retains receipts across equivalent main-session spellings", () => {
    const { state, refresh } = createHost();
    state.hello = {
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "main",
          mainKey: "main",
          mainSessionKey: "agent:main:main",
        },
      },
    };
    state.sessionKey = "main";
    refreshPullRequestsForFinalReply(state, "run-1", message);
    state.sessionKey = "agent:main:main";
    refreshPullRequestsForFinalReply(state, "run-1", message);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not merge the same final across different runs", () => {
    const { state, refresh } = createHost();
    refreshPullRequestsForFinalReply(state, "first-run", message);
    refreshPullRequestsForFinalReply(state, "later-run", message);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps unidentified runs eligible for freshness", () => {
    const { state, refresh } = createHost();
    refreshPullRequestsForFinalReply(state, undefined, message);
    refreshPullRequestsForFinalReply(state, undefined, message);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("evicts old receipts while retaining recently emitted finals", () => {
    const { state, refresh } = createHost();
    for (let index = 0; index < 1_000; index += 1) {
      refreshPullRequestsForFinalReply(state, `run-${index}`, message);
    }
    refreshPullRequestsForFinalReply(state, "run-999", message);
    expect(refresh).toHaveBeenCalledTimes(1_000);
    refreshPullRequestsForFinalReply(state, "run-0", message);
    expect(refresh).toHaveBeenCalledTimes(1_001);
  });

  it("does not retain or truncate large content identities", () => {
    const { state, refresh } = createHost();
    const largeText = text + "x".repeat(50_000);
    const large = {
      role: "assistant",
      content: [{ type: "text", text: largeText }],
    };
    refreshPullRequestsForFinalReply(state, "run-1", large);
    refreshPullRequestsForFinalReply(state, "run-1", large);
    refreshPullRequestsForFinalReply(state, "run-1", {
      ...large,
      content: [{ type: "text", text: largeText + "different" }],
    });
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
