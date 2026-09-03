// CronPage task-lanes capability gate: an unconfigured install must issue zero
// taskLanes.list RPCs and render no lane panel.
import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "./cron-page.ts";
import {
  createGateway,
  createContext,
  createPage,
  createRequest,
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
});
