import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient, GatewayEventListener } from "../api/gateway.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { SessionPullRequestIndicatorsController } from "./app-sidebar-session-pr-indicators.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

class TestHost implements ReactiveControllerHost {
  readonly controllers: ReactiveController[] = [];
  readonly requestUpdate = vi.fn();
  readonly updateComplete = Promise.resolve(true);

  addController(controller: ReactiveController): void {
    this.controllers.push(controller);
  }

  removeController(controller: ReactiveController): void {
    this.controllers.splice(this.controllers.indexOf(controller), 1);
  }
}

function createGatewayHarness() {
  const request = vi.fn().mockResolvedValue({ subscribed: true });
  const eventListeners = new Set<GatewayEventListener>();
  const client = { request } as unknown as GatewayBrowserClient;
  const gateway = {
    snapshot: {
      client,
      phase: "connected",
      offlineStable: false,
      hello: { features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] } },
      canvasPluginSurfaceUrl: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
      lastError: null,
      lastErrorCode: null,
    },
    connection: { gatewayUrl: "ws://example.test", token: "", bootstrapToken: "", password: "" },
    eventLog: [],
    subscribe: () => () => {},
    subscribeEvents(listener: GatewayEventListener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    subscribeEventLog: () => () => {},
    connect: vi.fn(),
    setSessionKey: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as ApplicationGateway;
  return {
    gateway,
    request,
    emit(payload: unknown, event = CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT) {
      for (const listener of eventListeners) {
        listener({
          type: "event",
          event,
          payload,
          seq: 1,
        });
      }
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionPullRequestIndicatorsController", () => {
  it("does not invalidate the host when no rows are eligible", async () => {
    vi.useFakeTimers();
    const host = new TestHost();
    const harness = createGatewayHarness();
    const controller = new SessionPullRequestIndicatorsController(host, {
      getConnected: () => true,
      getRows: () => [],
      getSelectedAgentId: () => "main",
      getGateway: () => harness.gateway,
      getSessions: () => undefined,
    });

    controller.hostConnected();
    controller.hostUpdated();
    await vi.advanceTimersByTimeAsync(0);

    expect(host.requestUpdate).not.toHaveBeenCalled();
  });

  it("subscribes visible rows and keeps the last indicator through backoff", async () => {
    vi.useFakeTimers();
    const host = new TestHost();
    const harness = createGatewayHarness();
    const row = {
      key: "agent:main:demo",
      isChild: false,
      worktreeId: "wt-demo",
    } as SidebarRecentSession;
    const controller = new SessionPullRequestIndicatorsController(host, {
      getConnected: () => true,
      getRows: () => [row],
      getSelectedAgentId: () => "main",
      getGateway: () => harness.gateway,
      getSessions: () => undefined,
    });

    controller.hostConnected();
    controller.hostUpdated();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(harness.request).toHaveBeenCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: [row.key],
    });

    harness.emit({
      sessions: {
        [row.key]: {
          pullRequests: [
            {
              number: 1,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature/demo",
              title: "Demo",
              url: "https://example.test/pr/1",
              state: "open",
            },
          ],
          rateLimited: true,
          status: "rate-limited",
        },
      },
    });
    expect(controller.state(row.key, row.worktreeId ?? "")).toBe("open");

    harness.emit({
      sessions: {
        [row.key]: {
          pullRequests: [],
          rateLimited: true,
          status: "rate-limited",
        },
      },
    });
    expect(controller.state(row.key, row.worktreeId ?? "")).toBe("open");
  });

  it("clears alias indicators when the selected agent changes", async () => {
    vi.useFakeTimers();
    const host = new TestHost();
    const harness = createGatewayHarness();
    const row = { key: "global", isChild: false, worktreeId: "wt-global" } as SidebarRecentSession;
    let selectedAgentId = "main";
    const controller = new SessionPullRequestIndicatorsController(host, {
      getConnected: () => true,
      getRows: () => [row],
      getSelectedAgentId: () => selectedAgentId,
      getGateway: () => harness.gateway,
      getSessions: () => undefined,
    });
    controller.hostConnected();
    controller.hostUpdated();
    await vi.advanceTimersByTimeAsync(0);
    harness.emit({
      sessions: {
        "agent:main:global": {
          pullRequests: [
            {
              number: 1,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature/demo",
              title: "Demo",
              url: "https://example.test/pr/1",
              state: "open",
            },
          ],
          rateLimited: false,
          status: "ready",
        },
      },
    });
    expect(controller.state(row.key, row.worktreeId ?? "")).toBe("open");

    selectedAgentId = "work";
    controller.hostUpdated();
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.state(row.key, row.worktreeId ?? "")).toBe("none");
  });

  it("clears a structural session's indicator while replacement data is pending", async () => {
    vi.useFakeTimers();
    const host = new TestHost();
    const harness = createGatewayHarness();
    const row = {
      key: "agent:main:demo",
      isChild: false,
      worktreeId: "wt-demo",
    } as SidebarRecentSession;
    const epoch = {};
    const setPullRequestSummary = vi.fn();
    const controller = new SessionPullRequestIndicatorsController(host, {
      getConnected: () => true,
      getRows: () => [row],
      getSelectedAgentId: () => "main",
      getGateway: () => harness.gateway,
      getSessions: () =>
        ({
          capturePullRequestEpoch: vi.fn(() => epoch),
          setPullRequestSummary,
        }) as unknown as SessionCapability,
    });
    controller.hostConnected();
    controller.hostUpdated();
    await vi.advanceTimersByTimeAsync(0);
    harness.emit({
      sessions: {
        [row.key]: {
          pullRequests: [{ number: 1, state: "open" }],
          rateLimited: false,
          status: "ready",
        },
      },
    });
    expect(controller.state(row.key, row.worktreeId ?? "")).toBe("open");

    harness.emit({ sessionKey: row.key, agentId: "main", reason: "rewind" }, "sessions.changed");

    expect(controller.state(row.key, row.worktreeId ?? "")).toBe("none");
    expect(setPullRequestSummary).toHaveBeenCalledExactlyOnceWith(row.key, undefined, epoch);
  });
});
