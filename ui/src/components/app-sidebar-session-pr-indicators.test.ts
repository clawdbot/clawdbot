import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
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

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionPullRequestIndicatorsController", () => {
  it("refreshes visible PR state and keeps the last value while rate limited", async () => {
    vi.useFakeTimers();
    const host = new TestHost();
    const row = {
      key: "agent:main:demo",
      isChild: false,
      worktreeId: "wt-demo",
    } as SidebarRecentSession;
    let state: "open" | "merged" = "open";
    let rateLimited = false;
    const request = vi.fn(() =>
      Promise.resolve({
        pullRequests: rateLimited
          ? []
          : [
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
        rateLimited,
      }),
    );
    const snapshot = {
      client: { request } as unknown as GatewayBrowserClient,
      hello: { features: { methods: ["controlUi.sessionPullRequests"] } },
    } as ApplicationGatewaySnapshot;
    const controller = new SessionPullRequestIndicatorsController(host, {
      getConnected: () => true,
      getRows: () => [row],
      getSelectedAgentId: () => "main",
      getSnapshot: () => snapshot,
    });

    controller.hostConnected();
    controller.hostUpdated();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.state(row.key, row.worktreeId ?? "")).toBe("open");

    state = "merged";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.state(row.key, row.worktreeId ?? "")).toBe("merged");

    rateLimited = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.state(row.key, row.worktreeId ?? "")).toBe("merged");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
