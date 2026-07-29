import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import { createSessionCapability } from "./index.ts";

function sessionsResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 2,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function createGatewayHarness(client: GatewayBrowserClient) {
  let snapshot = {
    client: client as GatewayBrowserClient | null,
    phase: "connected" as ApplicationGatewayPhase,
    sessionKey: "agent:main:main",
    assistantAgentId: "main",
    hello: null,
  };
  const listeners = new Set<(next: typeof snapshot) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeEvents(_listener: (event: GatewayEventFrame) => void) {
        return () => undefined;
      },
    },
    publish(connected: boolean, nextClient: GatewayBrowserClient | null = snapshot.client) {
      snapshot = {
        ...snapshot,
        client: nextClient,
        phase: connected ? "connected" : "reconnecting",
      };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

describe("session pull-request state", () => {
  it("publishes state removal for client replacement and disconnect", () => {
    const harness = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createSessionCapability(harness.gateway);
    const listener = vi.fn();
    const summary = { numbers: [111532], state: "open" as const };
    sessions.subscribe(listener);

    sessions.setPullRequestSummary("agent:main:pr-session", summary);
    expect(sessions.pullRequestSummary("agent:main:pr-session")).toEqual(summary);
    expect(listener).toHaveBeenCalledTimes(1);

    sessions.setPullRequestSummary("agent:main:pr-session", summary);
    expect(listener).toHaveBeenCalledTimes(1);

    const publicationsBeforeReplacement = listener.mock.calls.length;
    harness.publish(true, {} as GatewayBrowserClient);
    expect(sessions.pullRequestSummary("agent:main:pr-session")).toBeUndefined();
    expect(listener.mock.calls.length).toBeGreaterThan(publicationsBeforeReplacement);

    sessions.setPullRequestSummary("agent:main:pr-session", summary);
    const publicationsBeforeDisconnect = listener.mock.calls.length;
    harness.publish(false);
    expect(sessions.pullRequestSummary("agent:main:pr-session")).toBeUndefined();
    expect(listener.mock.calls.length).toBeGreaterThan(publicationsBeforeDisconnect);

    sessions.dispose();
  });

  it("rejects an older pane's pull-request result", () => {
    const sessions = createSessionCapability(
      createGatewayHarness({} as GatewayBrowserClient).gateway,
    );
    const key = "agent:main:shared-session";
    const olderEpoch = sessions.capturePullRequestEpoch(key);
    const newerEpoch = sessions.capturePullRequestEpoch(key);

    sessions.setPullRequestSummary(key, { numbers: [111532], state: "draft" }, newerEpoch);
    sessions.setPullRequestSummary(key, undefined, olderEpoch);

    expect(sessions.pullRequestSummary(key)).toEqual({ numbers: [111532], state: "draft" });
    sessions.dispose();
  });

  it("retires pull-request state when a session is deleted", async () => {
    const key = "agent:main:deleted-pr";
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        return { ok: true, deleted: true };
      }
      if (method === "sessions.list") {
        return sessionsResult([]);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessionCapability(
      createGatewayHarness({ request } as unknown as GatewayBrowserClient).gateway,
    );
    const epoch = sessions.capturePullRequestEpoch(key);
    sessions.setPullRequestSummary(key, { numbers: [111532], state: "open" }, epoch);

    await expect(sessions.delete(key)).resolves.toEqual({ deleted: true });
    expect(sessions.pullRequestSummary(key)).toBeUndefined();

    sessions.setPullRequestSummary(key, { numbers: [111532], state: "open" }, epoch);
    expect(sessions.pullRequestSummary(key)).toBeUndefined();
    sessions.dispose();
  });
});
