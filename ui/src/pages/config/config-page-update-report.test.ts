/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createUpdateRunFixture } from "../../test-helpers/update-run.ts";
import { ConfigPage } from "./config-page.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ConfigPage update failure reporting", () => {
  it.each([
    {
      label: "owner administrator",
      profileId: "gateway-owner",
      scope: "operator.admin",
      connected: true,
      allowed: true,
    },
    {
      label: "non-owner administrator",
      profileId: "other-operator",
      scope: "operator.admin",
      connected: true,
      allowed: false,
    },
    {
      label: "unidentified administrator",
      profileId: null,
      scope: "operator.admin",
      connected: true,
      allowed: false,
    },
    {
      label: "owner without administrator scope",
      profileId: "gateway-owner",
      scope: "operator.write",
      connected: true,
      allowed: false,
    },
    {
      label: "disconnected owner",
      profileId: "gateway-owner",
      scope: "operator.admin",
      connected: false,
      allowed: false,
    },
  ])(
    "gates report clicks for $label with a stale method catalog",
    ({ profileId, scope, connected, allowed }) => {
      const page = new ConfigPage();
      const state = page as unknown as { context: ApplicationContext };
      const reportUpdateFailure = vi.fn(async () => undefined);
      const run = createUpdateRunFixture({
        phase: "finished",
        status: "failed",
        reason: "build-failed",
        finishedAtMs: 500,
      });
      page.pageId = "updates";
      state.context = {
        config: {
          current: { assistantIdentity: { name: "OpenClaw" }, serverVersion: "2026.8.1" },
        },
        runtimeConfig: {
          canSet: true,
          state: {
            connected: true,
            configLoading: false,
            configSaving: false,
            configApplying: false,
            configForm: { update: { channel: "stable", auto: { enabled: false } } },
            configSnapshot: null,
          },
          patchForm: vi.fn(),
        },
        gateway: {
          snapshot: {
            client: {},
            phase: connected ? "connected" : "reconnecting",
            selfUser: profileId ? { id: profileId } : null,
            hello: {
              auth: { role: "operator", scopes: [scope] },
              features: { methods: ["update.status"] },
            },
          },
          subscribe: () => () => undefined,
        },
        overlays: {
          snapshot: {
            updateAvailable: null,
            updateSchedule: null,
            updateRunning: false,
            updateReconciliationPending: false,
            updateStatusBanner: { tone: "danger", text: "Update failed" },
            updateRun: run,
            reportableUpdateFailureId: run.runId,
            updateFailureReportBusy: false,
            updateFailureReportNotice: null,
            heldUpdateCampaignId: null,
          },
          subscribe: () => () => undefined,
          reportUpdateFailure,
          refreshUpdateStatus: vi.fn(async () => undefined),
          runUpdate: vi.fn(),
        },
      } as unknown as ApplicationContext;
      const container = document.createElement("div");
      render(page.render(), container);

      const report = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Report update failure",
      );
      expect(report).toBeDefined();
      expect(report?.disabled).toBe(!allowed);
      report?.click();
      expect(reportUpdateFailure).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed) {
        expect(reportUpdateFailure).toHaveBeenCalledWith(run.runId);
      }
    },
  );
});
