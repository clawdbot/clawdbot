/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  deferred,
  setPageGateway,
  snapshot,
  type TestAgentsPage,
} from "./agents-page.test-support.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import type { AgentsRouteData } from "./route.ts";
import { renderAgents } from "./view.ts";
import "./agents-page.ts";

describe("agent model catalog recovery", () => {
  it("shows a model-catalog failure without a manual retry button", () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          modelCatalogStatus: {
            error: "model catalog unavailable",
            hasLoaded: true,
            stale: true,
            awaitingGateway: false,
          },
        }),
      ),
      container,
    );

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("model catalog unavailable");
    expect(alert?.textContent).toContain(t("common.staleData"));
    expect(alert?.querySelector("button")).toBeNull();
  });

  it.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ])(
    "recovers a cached model catalog once after same-socket suspension (lifecycle error: %s, late failure: %s)",
    async (lifecycle, lateFailure) => {
      const oldModels = [{ id: "old", name: "Old model", provider: "openai" }];
      const nextModels = [{ id: "new", name: "Recovered model", provider: "openai" }];
      const pending = deferred<{ models: ModelCatalogEntry[] }>();
      const error = new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Model catalog unavailable",
        retryable: true,
        ...(lifecycle ? { details: { reason: "gateway-suspending", phase: "draining" } } : {}),
      });
      const request = vi
        .fn()
        .mockResolvedValueOnce({ models: oldModels })
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue({ models: nextModels });
      const client = { request } as unknown as GatewayBrowserClient;
      const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
      page.routeData = { panel: "overview" } as AgentsRouteData;
      setPageGateway(page, client);
      page.agentsSelectedId = "main";
      page.loadActivePanelData();
      await waitForFast(() => expect(page.chatModelCatalog).toEqual(oldModels));
      page.ensureModelCatalog({ refresh: true });
      if (!lateFailure) {
        pending.reject(error);
        await waitForFast(() =>
          expect(page.chatModelCatalogStatus).toMatchObject({
            awaitingGateway: lifecycle,
            error: lifecycle ? null : "Model catalog unavailable",
            stale: true,
          }),
        );
      }
      expect(page.chatModelCatalog).toEqual(oldModels);

      for (const suspensionPhase of ["draining", "accepting", "accepting"] as const) {
        page.gateway.applySnapshot(
          { ...snapshot(client), suspensionPhase },
          { initial: false, sourceChanged: false },
        );
      }
      if (lateFailure) {
        expect(request).toHaveBeenCalledTimes(2);
        pending.reject(error);
      }
      await waitForFast(() => expect(page.chatModelCatalog).toEqual(nextModels));
      expect(page.chatModelCatalogStatus).toMatchObject({ error: null, awaitingGateway: false });
      expect(request).toHaveBeenCalledTimes(3);
    },
  );
});
