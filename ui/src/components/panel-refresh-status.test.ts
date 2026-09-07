/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import {
  beginPanelRefresh,
  completePanelRefresh,
  createPanelRefreshStatus,
  failPanelRefresh,
  renderPanelRefreshStatus,
} from "./panel-refresh-status.ts";

const connected: ApplicationGatewaySnapshot = {
  phase: "connected",
  client: null,
  offlineStable: false,
  hello: null,
  canvasPluginSurfaceUrl: null,
  assistantAgentId: null,
  sessionKey: "agent:main:main",
  lastError: null,
  lastErrorCode: null,
};

describe("panel refresh failures", () => {
  it.each(["gateway-suspending", "gateway-restarting", "startup-sidecars"])(
    "keeps stale data without a callout for %s until refreshed",
    (reason) => {
      const error = new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Temporarily unavailable",
        retryable: true,
        details: { reason },
      });
      const status = failPanelRefresh(completePanelRefresh(), error, connected);
      const container = document.createElement("div");
      render(
        renderPanelRefreshStatus({ status, errorMessage: "Could not load details" }),
        container,
      );
      expect(container.textContent).toBe("");
      expect(status).toMatchObject({
        error: null,
        hasLoaded: true,
        stale: true,
        awaitingGateway: true,
      });
      expect(beginPanelRefresh(status).awaitingGateway).toBe(true);
      expect(completePanelRefresh().awaitingGateway).toBe(false);
    },
  );

  it.each([
    { phase: "reconnecting" as const },
    { restartPending: true },
    { suspensionPhase: "preparing" as const },
    { suspensionPhase: "draining" as const },
    { suspensionPhase: "prepared" as const },
  ])("parks plain transport errors while unavailable: %j", (state) => {
    const status = failPanelRefresh(completePanelRefresh(), new Error("Transport failed"), {
      ...connected,
      ...state,
    });
    const container = document.createElement("div");
    render(renderPanelRefreshStatus({ status }), container);
    expect(container.textContent).toBe("");
    expect(status).toMatchObject({ error: null, stale: true, awaitingGateway: true });
  });

  it.each([
    {
      state: {},
      code: "UNAVAILABLE",
      message: "Catalog service failed",
    },
    {
      state: { suspensionPhase: "accepting" as const },
      code: "UNAVAILABLE",
      message: "Catalog service failed",
    },
    {
      state: { suspensionPhase: "draining" as const },
      code: "INVALID_REQUEST",
      message: 'unknown agent id "main"',
    },
    {
      state: { restartPending: true },
      code: "INVALID_REQUEST",
      message: 'unknown agent id "main"',
    },
  ])(
    "shows hard failures and retained-data status without a Retry button ($state)",
    ({ state, code, message }) => {
      const error = new GatewayRequestError({ code, message });
      const status = failPanelRefresh(completePanelRefresh(), error, {
        ...connected,
        ...state,
      });
      const container = document.createElement("div");
      render(renderPanelRefreshStatus({ status }), container);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
      expect(container.textContent).toContain("Showing stale data");
      expect(container.querySelector("button")).toBeNull();
      expect(status.awaitingGateway).toBe(false);
    },
  );

  it("does not classify lifecycle words in an ordinary error message", () => {
    const status = failPanelRefresh(
      createPanelRefreshStatus(),
      new Error("gateway-suspending"),
      connected,
    );
    expect(status).toMatchObject({
      error: "gateway-suspending",
      stale: false,
      awaitingGateway: false,
    });
  });

  it("shows a stale-only warning without an alert or a button", () => {
    const container = document.createElement("div");
    render(
      renderPanelRefreshStatus({ status: { ...completePanelRefresh(), stale: true } }),
      container,
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Showing stale data");
    expect(container.querySelector('[role="alert"], button')).toBeNull();
  });
});
