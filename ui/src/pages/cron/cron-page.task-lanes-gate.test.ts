// CronPage task-lanes capability gate: an unconfigured install must issue zero
// taskLanes.list RPCs and render no lane panel.
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "./cron-page.ts";
import {
  createGateway,
  createContext,
  createPage,
  createRequest,
  cronListResponse,
  waitForCronPage,
} from "./cron-page.test-support.ts";

describe("CronPage task-lanes capability gate", () => {
  it("never requests taskLanes.list when the gateway reports no configured providers", async () => {
    const request = createRequest({
      enabled: true,
      jobs: 0,
      triggersEnabled: true,
      taskLanesConfigured: false,
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    await waitForCronPage(() =>
      expect(page.cron.cronStatus).toMatchObject({ taskLanesConfigured: false }),
    );
    // Status resolved; give any late load a chance to (wrongly) fire.
    await page.updateComplete;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(request.mock.calls.filter(([method]) => method === "taskLanes.list")).toHaveLength(0);
    expect(page.cron.taskLanes).toBeNull();
  });

  it("fails closed when the capability signal is absent from cron.status", async () => {
    // No taskLanesConfigured field at all (legacy or unresolved capability):
    // an absent signal is not permission, so zero lane requests may fire.
    const request = createRequest();
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    await waitForCronPage(() => expect(page.cron.cronStatus).toMatchObject({ enabled: true }));
    await page.updateComplete;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(request.mock.calls.filter(([method]) => method === "taskLanes.list")).toHaveLength(0);
    expect(page.cron.taskLanes).toBeNull();
  });

  it("requests task lanes once providers are configured", async () => {
    const request = createRequest({
      enabled: true,
      jobs: 0,
      triggersEnabled: true,
      taskLanesConfigured: true,
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    await waitForCronPage(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "taskLanes.list").length,
      ).toBeGreaterThan(0),
    );
    expect(page.cron.taskLanes).toMatchObject({ lanes: [], diagnostics: [] });
  });

  it("does not race a slow cron.status when the operator refreshes", async () => {
    let taskLanesCalls = 0;
    let statusCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "cron.status") {
        statusCalls += 1;
        // Hold the capability answer beyond the 150 ms reload debounce: by the
        // time the unconfigured "false" lands, no lane request may be in
        // flight and none may follow.
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
        return { enabled: true, jobs: 0, triggersEnabled: true, taskLanesConfigured: false };
      }
      if (method === "taskLanes.list") {
        taskLanesCalls += 1;
        return { lanes: [], diagnostics: [] };
      }
      if (method === "cron.list") {
        return cronListResponse([]);
      }
      return {};
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    await waitForCronPage(() => expect(statusCalls).toBeGreaterThan(0));

    // cron.status is still pending; the operator refreshes anyway.
    const refresh = page.querySelector<HTMLButtonElement>(".cron-refresh");
    expect(refresh).not.toBeNull();
    refresh!.click();
    await page.updateComplete;
    await new Promise((resolve) => {
      setTimeout(resolve, 220);
    });
    // The debounce window elapsed while cron.status was unresolved: the gate
    // must not have issued a lane request, and the resolved "false" must keep
    // it that way.
    expect(taskLanesCalls).toBe(0);
    await waitForCronPage(() =>
      expect(page.cron.cronStatus).toMatchObject({ taskLanesConfigured: false }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    expect(taskLanesCalls).toBe(0);
  });

  it("reloads externally edited lanes when the operator refreshes", async () => {
    const changedBoard = {
      lanes: [
        {
          id: "review",
          label: "Review",
          items: [{ id: "item-1", title: "Freshly added", state: "pending" }],
        },
      ],
      diagnostics: [],
    };
    let taskLanesCalls = 0;
    const fallbackRequest = createRequest({
      enabled: true,
      jobs: 0,
      triggersEnabled: true,
      taskLanesConfigured: true,
    });
    const request = vi.fn(async (method: string) => {
      if (method === "taskLanes.list") {
        taskLanesCalls += 1;
        return taskLanesCalls === 1 ? { lanes: [], diagnostics: [] } : changedBoard;
      }
      if (method === "cron.list") {
        return cronListResponse([]);
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    await waitForCronPage(() => expect(taskLanesCalls).toBe(1));

    const refresh = page.querySelector<HTMLButtonElement>(".cron-refresh");
    expect(refresh).not.toBeNull();
    refresh!.click();
    // The refresh-driven reload is debounced; the changed board must land.
    await waitForCronPage(() => {
      expect(taskLanesCalls).toBeGreaterThan(1);
      expect(page.cron.taskLanes).toMatchObject({
        lanes: [{ id: "review", items: [{ id: "item-1", title: "Freshly added" }] }],
      });
    });
  });
});
