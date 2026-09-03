import { html, LitElement, type ReactiveController, type ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS,
} from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient, GatewayEventListener } from "../api/gateway.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../lib/session-pull-requests.ts";
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

type IndicatorOptions = ConstructorParameters<typeof SessionPullRequestIndicatorsController>[1];
const LIFECYCLE_HOST_TAG = "test-session-pr-indicators";

class LifecycleTestHost extends LitElement {
  rows: readonly SidebarRecentSession[] = [];
  readRows: IndicatorOptions["getRows"] = () => [];
  controller!: SessionPullRequestIndicatorsController;

  protected override willUpdate(): void {
    // The sidebar prepares row summaries before controller hooks run.
    this.rows = this.readRows();
  }

  protected override render() {
    return this.rows.map(
      (row) => html`<span data-session-key=${row.key}>
        ${this.controller
          .summary(row.key, row.worktreeId ?? "", row.pullRequest)
          ?.numbers.join(",")}
      </span>`,
    );
  }
}

if (!customElements.get(LIFECYCLE_HOST_TAG)) {
  customElements.define(LIFECYCLE_HOST_TAG, LifecycleTestHost);
}

function mountLifecycleHost(
  gateway: ApplicationGateway,
  readRows: IndicatorOptions["getRows"],
  getSessions: IndicatorOptions["getSessions"] = () => undefined,
): LifecycleTestHost {
  const host = document.createElement(LIFECYCLE_HOST_TAG) as LifecycleTestHost;
  host.readRows = readRows;
  host.controller = new SessionPullRequestIndicatorsController(host, {
    getConnected: () => true,
    getRows: () => host.rows,
    getSelectedAgentId: () => "main",
    getGateway: () => gateway,
    getSessions,
  });
  document.body.append(host);
  return host;
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
  document.querySelectorAll(LIFECYCLE_HOST_TAG).forEach((host) => host.remove());
  vi.useRealTimers();
});

describe("SessionPullRequestIndicatorsController", () => {
  it("does not invalidate the host when no rows are eligible", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    const getRows = vi.fn(() => []);
    const host = mountLifecycleHost(harness.gateway, getRows);
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    getRows.mockClear();
    const requestUpdate = vi.spyOn(host, "requestUpdate");

    host.requestUpdate();
    host.requestUpdate();
    expect(await host.updateComplete).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(getRows).toHaveBeenCalledOnce();
    expect(requestUpdate).toHaveBeenCalledTimes(2);
  });

  it.each(["open", "draft", "merged", "closed"] as const)(
    "subscribes visible rows and keeps the %s summary through backoff",
    async (state) => {
      vi.useFakeTimers();
      const host = new TestHost();
      const harness = createGatewayHarness();
      const row = {
        key: "agent:main:demo",
        isChild: false,
        worktreeId: "wt-demo",
      } as SidebarRecentSession;
      const getRows = vi.fn(() => [row]);
      const controller = new SessionPullRequestIndicatorsController(host, {
        getConnected: () => true,
        getRows,
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
      expect(getRows).toHaveBeenCalledOnce();

      harness.emit({
        sessions: {
          [row.key]: {
            pullRequests: [
              { number: 2, state: state === "closed" ? "closed" : "merged" },
              {
                number: 1,
                owner: "openclaw",
                repo: "openclaw",
                branch: "feature/demo",
                title: "Demo",
                url: "https://example.test/pr/1",
                state,
              },
            ],
            rateLimited: true,
            status: "rate-limited",
          },
        },
      });
      expect(getRows).toHaveBeenCalledTimes(2);
      expect(controller.summary(row.key, row.worktreeId ?? "")).toEqual({
        numbers: [1, 2],
        state,
      });

      harness.emit({
        sessions: {
          [row.key]: {
            pullRequests: [],
            rateLimited: true,
            status: "rate-limited",
          },
        },
      });
      expect(controller.summary(row.key, row.worktreeId ?? "")).toEqual({
        numbers: [1, 2],
        state,
      });

      harness.emit({
        sessions: {
          [row.key]: { pullRequests: [], rateLimited: false, status: "ready" },
        },
      });
      expect(
        controller.summary(row.key, row.worktreeId ?? "", { numbers: [99], state }),
      ).toBeUndefined();
      controller.hostDisconnected();
    },
  );

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
    expect(controller.summary(row.key, row.worktreeId ?? "")).toEqual({
      numbers: [1],
      state: "open",
    });

    selectedAgentId = "work";
    controller.hostUpdated();
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.summary(row.key, row.worktreeId ?? "")).toBeUndefined();
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
    expect(controller.summary(row.key, row.worktreeId ?? "")).toEqual({
      numbers: [1],
      state: "open",
    });

    harness.emit({ sessionKey: row.key, agentId: "main", reason: "rewind" }, "sessions.changed");

    expect(controller.summary(row.key, row.worktreeId ?? "")).toBeUndefined();
    expect(setPullRequestSummary).toHaveBeenCalledExactlyOnceWith(row.key, undefined, epoch);
  });
});

describe("SessionPullRequestIndicatorsController Lit lifecycle", () => {
  it("synchronizes visible subscriptions by updateComplete without advancing timers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createGatewayHarness();
    const row = {
      key: "agent:main:demo",
      isChild: false,
      worktreeId: "wt-demo",
    } as SidebarRecentSession;
    const host = mountLifecycleHost(harness.gateway, () => [row]);

    await host.updateComplete;
    await Promise.resolve();

    expect(harness.request).toHaveBeenCalledExactlyOnceWith(
      SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      { sessionKeys: [row.key] },
    );
  });

  it("clears a rendered fallback after the visible snapshot leaves the bounded watch union", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createGatewayHarness();
    const key = "agent:main:demo";
    let fallback: SidebarRecentSession["pullRequest"] = { numbers: [7], state: "open" };
    const epoch = {};
    const setPullRequestSummary = vi.fn(
      (_key: string, summary: SidebarRecentSession["pullRequest"]) => {
        fallback = summary;
      },
    );
    const host = mountLifecycleHost(
      harness.gateway,
      () => [
        {
          key,
          isChild: false,
          worktreeId: "wt-demo",
          pullRequest: fallback,
        } as SidebarRecentSession,
      ],
      () =>
        ({
          capturePullRequestEpoch: () => epoch,
          setPullRequestSummary,
        }) as unknown as SessionCapability,
    );
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    harness.emit({
      sessions: {
        [key]: {
          pullRequests: [{ number: 7, state: "open" }],
          rateLimited: false,
          status: "ready",
        },
      },
    });
    await host.updateComplete;
    expect(host.shadowRoot?.textContent?.trim()).toBe("7");

    const store = sessionPullRequestsForGateway(harness.gateway);
    const foregroundOwner = {};
    try {
      store.watch(
        foregroundOwner,
        Array.from(
          { length: CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS },
          (_, index) => `agent:main:foreground-${index}`,
        ),
        { foreground: true },
      );
      expect(store.get(key)).toBeUndefined();
      host.requestUpdate();
      await host.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await host.updateComplete;

      expect(setPullRequestSummary).toHaveBeenCalledExactlyOnceWith(key, undefined, epoch);
      expect(fallback).toBeUndefined();
      expect(host.shadowRoot?.textContent?.trim()).toBe("");
    } finally {
      store.unwatch(foregroundOwner);
    }
  });

  it("does not restore a watch from an update pending at disconnect and resumes on reconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createGatewayHarness();
    const row = {
      key: "agent:main:demo",
      isChild: false,
      worktreeId: "wt-demo",
    } as SidebarRecentSession;
    const host = mountLifecycleHost(harness.gateway, () => [row]);
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: [row.key],
    });

    host.requestUpdate();
    host.remove();
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.request).toHaveBeenLastCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: [],
    });

    document.body.append(host);
    host.requestUpdate();
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.request).toHaveBeenLastCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: [row.key],
    });
  });
});
