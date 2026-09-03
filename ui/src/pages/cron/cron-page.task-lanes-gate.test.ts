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
