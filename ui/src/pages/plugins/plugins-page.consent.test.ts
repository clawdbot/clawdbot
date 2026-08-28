/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import type { PluginInstallRequest } from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  clickRowAction,
  createClient,
  createContext,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  deferred,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

function createAvailablePlugin() {
  return createPlugin({
    id: "calendar-runtime",
    name: "Calendar Plus",
    origin: "official",
    installed: false,
    enabled: false,
    state: "not-installed",
    install: { source: "official", pluginId: "calendar-runtime" },
  });
}

async function mountDiscover(handler: Parameters<typeof createClient>[0]) {
  const available = createAvailablePlugin();
  const { client, request } = createClient(handler);
  const harness = createGateway(client);
  const { page } = await mountPage(
    createContext(harness.gateway),
    createPluginsRouteData(
      harness.gateway,
      createResult(available),
      createPluginsRouteLocation("/settings/plugins/discover"),
    ),
  );
  return { page, request, available };
}

describe("PluginsPage consent", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(resetPluginsPageTestState);

  it.each(["official", "search"])(
    "reviews only the staged artifact before accepting an %s install",
    async (source) => {
      const installed = createPlugin({
        ...createAvailablePlugin(),
        installed: true,
        enabled: true,
        state: "enabled",
      });
      const inspection = createInspectResult({
        plugin: {
          id: "calendar-runtime",
          name: "Calendar Plus",
          origin: "global",
          installed: false,
          enabled: false,
        },
        declared: { ...createInspectResult().declared, tools: ["calendar_review"] },
      });
      const stagedInstall = deferred<never>();
      const installRequest: PluginInstallRequest =
        source === "official"
          ? { source: "official", pluginId: "calendar-runtime" }
          : { source: "clawhub", packageName: "community-calendar" };
      const { page, request } = await mountDiscover(async (method, params) => {
        if (method === "plugins.search") {
          return {
            results: [
              {
                score: 1,
                package: {
                  name: "community-calendar",
                  displayName: "Calendar Plus",
                  family: "code-plugin",
                  channel: "community",
                  isOfficial: false,
                },
              },
            ],
          };
        }
        if (method === "plugins.inspect") {
          return inspection;
        }
        if (method === "plugins.install") {
          if (!(params as PluginInstallRequest).acknowledgeCapabilities) {
            return stagedInstall.promise;
          }
          return { ok: true, plugin: installed, restartRequired: true };
        }
        if (method === "plugins.list") {
          return createResult(installed);
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const row =
        source === "official"
          ? '[data-plugin-id="calendar-runtime"]'
          : '[data-package-name="community-calendar"]';
      if (source === "search") {
        const search = page.querySelector<HTMLInputElement>("#plugins-global-search")!;
        search.value = "calendar";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        await waitForFast(() => expect(page.querySelector(row)).not.toBeNull());
      }

      await clickRowAction(page, row, "Install");

      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("plugins.install", installRequest),
      );
      expect(page.querySelector("[data-plugin-consent]")).toBeNull();
      expect(request.mock.calls.some(([method]) => method === "plugins.inspect")).toBe(false);
      stagedInstall.reject(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Capability consent required",
          details: buildCapabilityConsentErrorDetails({
            pluginId: "calendar-runtime",
            reviewToken: inspection.reviewToken,
          }),
        }),
      );
      await waitForFast(() =>
        expect(page.querySelector('[data-plugin-consent="install"]')?.textContent).toContain(
          "calendar_review",
        ),
      );
      expect(request.mock.calls.filter(([method]) => method === "plugins.install")).toHaveLength(1);

      page
        .querySelector<HTMLButtonElement>('[data-plugin-consent="install"] .btn.primary')
        ?.click();

      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("plugins.install", {
          ...installRequest,
          acknowledgeCapabilities: { reviewToken: inspection.reviewToken },
        }),
      );
      await page.updateComplete;
      expect(page.querySelector('[data-plugin-consent="install"]')).toBeNull();
    },
  );

  it("preserves an install-policy acknowledgement through the artifact review", async () => {
    const installed = createPlugin({
      ...createAvailablePlugin(),
      installed: true,
      enabled: true,
      state: "enabled",
    });
    const { page, request } = await mountDiscover(async (method, params) => {
      if (method === "plugins.inspect") {
        return createInspectResult();
      }
      if (method === "plugins.install") {
        if (!(params as PluginInstallRequest).acknowledgeInstallPolicyWarning) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "install requires review",
            details: {
              installPolicyCode: "install_policy_warning_acknowledgement_required",
              targetName: "calendar-runtime",
              targetType: "plugin",
              requestMode: "install",
              reason: "Review this plugin.",
            },
          });
        }
        if (!(params as PluginInstallRequest).acknowledgeCapabilities) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Capability consent required",
            details: buildCapabilityConsentErrorDetails({
              pluginId: "calendar-runtime",
              reviewToken: "review-token-workboard",
            }),
          });
        }
        return { ok: true, plugin: installed, restartRequired: true };
      }
      if (method === "plugins.list") {
        return createResult(installed);
      }
      throw new Error(`Unexpected method ${method}`);
    });

    await clickRowAction(page, '[data-plugin-id="calendar-runtime"]', "Install");
    await waitForFast(() =>
      expect(page.querySelector(".plugins-policy-review")?.textContent).toContain(
        "Review this plugin.",
      ),
    );

    page.querySelector<HTMLButtonElement>(".plugins-policy-review__actions .btn.danger")?.click();
    await waitForFast(() =>
      expect(
        page.querySelector<HTMLButtonElement>('[data-plugin-consent="install"] .btn.primary')
          ?.disabled,
      ).toBe(false),
    );
    page.querySelector<HTMLButtonElement>('[data-plugin-consent="install"] .btn.primary')?.click();

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("plugins.install", {
        source: "official",
        pluginId: "calendar-runtime",
        acknowledgeCapabilities: { reviewToken: "review-token-workboard" },
        acknowledgeInstallPolicyWarning: true,
      }),
    );
    expect(request.mock.calls.filter(([method]) => method === "plugins.inspect")).toHaveLength(1);
    expect(page.querySelector('[data-plugin-consent="install"]')).toBeNull();
  });

  it.each([
    { label: "accepted external enable", origin: "global", initiallyEnabled: false },
    { label: "bundled enable", origin: "bundled", initiallyEnabled: false },
    { label: "external disable", origin: "global", initiallyEnabled: true },
  ])(
    "applies a server-approved $label without another capability review",
    async ({ origin, initiallyEnabled }) => {
      const plugin = createPlugin({
        origin,
        enabled: initiallyEnabled,
        state: initiallyEnabled ? "enabled" : "disabled",
      });
      const updated = createPlugin({
        ...plugin,
        enabled: !initiallyEnabled,
        state: !initiallyEnabled ? "enabled" : "disabled",
      });
      const { client, request } = createClient(async (method) => {
        if (method === "plugins.setEnabled") {
          return { ok: true, plugin: updated, restartRequired: true };
        }
        if (method === "plugins.list") {
          return createResult(updated);
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const harness = createGateway(client);
      const { page } = await mountPage(
        createContext(harness.gateway),
        createPluginsRouteData(harness.gateway, createResult(plugin)),
      );

      await clickRowAction(
        page,
        '[data-plugin-id="workboard"]',
        initiallyEnabled ? "Disable" : "Enable",
      );

      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
          pluginId: "workboard",
          enabled: !initiallyEnabled,
        }),
      );
      await waitForFast(() => expect(page.result?.plugins[0]?.enabled).toBe(!initiallyEnabled));
      expect(request.mock.calls.some(([method]) => method === "plugins.inspect")).toBe(false);
      expect(page.querySelector("[data-plugin-consent]")).toBeNull();
    },
  );

  it("hydrates a compact consent error through inspection and acknowledges its reviewed token", async () => {
    const plugin = createPlugin({ origin: "global", enabled: false, state: "disabled" });
    const updated = createPlugin({ ...plugin, enabled: true, state: "enabled" });
    const inspection = createInspectResult({
      plugin: {
        id: "workboard",
        name: "Authoritative Workboard",
        origin: "global",
        installed: true,
        enabled: false,
      },
      declared: { ...createInspectResult().declared, tools: ["workboard_review"] },
    });
    const details = buildCapabilityConsentErrorDetails({
      pluginId: "workboard",
      reviewToken: inspection.reviewToken,
      widened: { tools: ["workboard_review"] },
      acceptedAt: "2026-08-20T14:03:00Z",
    });
    const enableAttempt = deferred<never>();
    const { client, request } = createClient(async (method, params) => {
      if (method === "plugins.inspect") {
        return inspection;
      }
      if (method === "plugins.setEnabled") {
        if (typeof params !== "object" || !params || !("acknowledgeCapabilities" in params)) {
          return enableAttempt.promise;
        }
        return { ok: true, plugin: updated, restartRequired: true };
      }
      if (method === "plugins.list") {
        return createResult(updated);
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, createResult(plugin)),
    );

    await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
        pluginId: "workboard",
        enabled: true,
      }),
    );
    expect(request.mock.calls.some(([method]) => method === "plugins.inspect")).toBe(false);
    expect(page.querySelector("[data-plugin-consent]")).toBeNull();
    enableAttempt.reject(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Capability consent required",
        details,
      }),
    );
    await waitForFast(() => {
      const dialog = page.querySelector('[data-plugin-consent="enable"]');
      expect(dialog?.textContent).toContain("Authoritative Workboard");
      expect(dialog?.textContent).toContain("workboard_review");
    });
    expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: "workboard" });

    page.querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] .btn.primary')?.click();

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
        pluginId: "workboard",
        enabled: true,
        acknowledgeCapabilities: { reviewToken: inspection.reviewToken },
      }),
    );
    await page.updateComplete;
    expect(page.querySelector('[data-plugin-consent="enable"]')).toBeNull();
  });

  it("reopens consent with a fresh inspection when an acknowledged surface changes", async () => {
    const plugin = createPlugin({ origin: "global", enabled: false, state: "disabled" });
    const inspection = createInspectResult();
    const details = buildCapabilityConsentErrorDetails({
      pluginId: "workboard",
      reviewToken: inspection.reviewToken,
    });
    let inspectionAttempts = 0;
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.inspect") {
        inspectionAttempts += 1;
        return createInspectResult({ reviewToken: `review-token-${inspectionAttempts}` });
      }
      if (method === "plugins.setEnabled") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Capability consent remains invalid",
          details,
        });
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, createResult(plugin)),
    );

    await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");
    await waitForFast(() =>
      expect(
        page.querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] .btn.primary')
          ?.disabled,
      ).toBe(false),
    );
    page.querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] .btn.primary')?.click();

    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "plugins.setEnabled")).toHaveLength(
        2,
      ),
    );
    await waitForFast(() => expect(inspectionAttempts).toBe(2));
    expect(page.querySelector('[data-plugin-consent="enable"]')).not.toBeNull();
    expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
      pluginId: "workboard",
      enabled: true,
      acknowledgeCapabilities: { reviewToken: "review-token-1" },
    });
  });

  it("keeps hard inspection failures visible and retries before enabling the action", async () => {
    const plugin = createPlugin({ origin: "global" });
    let attempts = 0;
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.setEnabled") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Capability consent required",
          details: buildCapabilityConsentErrorDetails({
            pluginId: "workboard",
            reviewToken: "review-token-workboard",
          }),
        });
      }
      if (method === "plugins.inspect") {
        attempts += 1;
        if (attempts === 1) {
          throw new GatewayRequestError({ code: "UNAVAILABLE", message: "Inspection unavailable" });
        }
        return createInspectResult();
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, createResult(plugin)),
    );

    await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");
    await waitForFast(() =>
      expect(
        page.querySelector('[data-plugin-consent="enable"] [role="alert"]')?.textContent,
      ).toContain("Inspection unavailable"),
    );
    expect(
      page.querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] .btn.primary')
        ?.disabled,
    ).toBe(true);

    page
      .querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] [role="alert"] .btn')
      ?.click();

    await waitForFast(() =>
      expect(
        page.querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] .btn.primary')
          ?.disabled,
      ).toBe(false),
    );
    expect(request.mock.calls.filter(([method]) => method === "plugins.inspect")).toHaveLength(2);
  });

  it.each(["consent", "detail"])(
    "closes an interrupted %s inspection and allows a fresh review after reconnect",
    async (overlay) => {
      const plugin = createPlugin({ origin: "global", enabled: false, state: "disabled" });
      const pendingInspection = deferred<ReturnType<typeof createInspectResult>>();
      let inspections = 0;
      const { client, request } = createClient(async (method, params) => {
        if (method === "plugins.inspect") {
          inspections += 1;
          return inspections === 1
            ? pendingInspection.promise
            : createInspectResult({ reviewToken: "fresh-review" });
        }
        if (method === "plugins.setEnabled") {
          if (typeof params !== "object" || !params || !("acknowledgeCapabilities" in params)) {
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "Capability consent required",
              details: buildCapabilityConsentErrorDetails({
                pluginId: "workboard",
                reviewToken: "fresh-review",
              }),
            });
          }
          return {
            ok: true,
            plugin: createPlugin({ ...plugin, enabled: true, state: "enabled" }),
            restartRequired: true,
          };
        }
        if (method === "plugins.list") {
          return createResult(plugin);
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const harness = createGateway(client);
      const { page } = await mountPage(
        createContext(harness.gateway),
        createPluginsRouteData(harness.gateway, createResult(plugin)),
      );

      if (overlay === "consent") {
        await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");
      } else {
        page
          .querySelector<HTMLButtonElement>(
            '[data-plugin-id="workboard"] .plugins-item__detail-button',
          )
          ?.click();
      }
      await waitForFast(() =>
        expect(page.querySelector("openclaw-modal-dialog .plugins-consent__hint")).not.toBeNull(),
      );
      harness.emit(client, false);
      harness.emit(client, true);
      pendingInspection.resolve(createInspectResult({ reviewToken: "stale-review" }));
      await page.updateComplete;

      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(
        request.mock.calls
          .filter(([method]) => method === "plugins.setEnabled")
          .map(([, params]) => params),
      ).toEqual(overlay === "consent" ? [{ pluginId: "workboard", enabled: true }] : []);
      await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");
      await waitForFast(() =>
        expect(
          page.querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] .btn.primary')
            ?.disabled,
        ).toBe(false),
      );
      page.querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] .btn.primary')?.click();

      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
          pluginId: "workboard",
          enabled: true,
          acknowledgeCapabilities: { reviewToken: "fresh-review" },
        }),
      );
    },
  );

  it("inspects an installed plugin only when its detail overlay opens", async () => {
    const inspection = createInspectResult({
      declared: { ...createInspectResult().declared, tools: ["workboard_create"] },
    });
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.inspect") {
        return inspection;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway),
    );
    expect(request).not.toHaveBeenCalled();

    page
      .querySelector<HTMLButtonElement>('[data-plugin-id="workboard"] .plugins-item__detail-button')
      ?.click();

    await waitForFast(() =>
      expect(page.querySelector(".plugins-detail__capabilities")?.textContent).toContain(
        "workboard_create",
      ),
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: "workboard" });
  });

  it.each(["success", "failure"])(
    "keeps the current detail inspection when a closed review finishes with %s",
    async (outcome) => {
      const staleInspection = deferred<ReturnType<typeof createInspectResult>>();
      let inspections = 0;
      const { client, request } = createClient(async (method) => {
        if (method === "plugins.inspect") {
          inspections += 1;
          return inspections === 1
            ? staleInspection.promise
            : createInspectResult({
                declared: { ...createInspectResult().declared, tools: ["current_tool"] },
              });
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const harness = createGateway(client);
      const { page } = await mountPage(
        createContext(harness.gateway),
        createPluginsRouteData(harness.gateway),
      );
      const details = page.querySelector<HTMLButtonElement>(
        '[data-plugin-id="workboard"] .plugins-item__detail-button',
      );

      details?.click();
      await waitForFast(() => expect(inspections).toBe(1));
      page.querySelector<HTMLButtonElement>(".plugins-detail__close")?.click();
      await page.updateComplete;
      details?.click();
      await waitForFast(() =>
        expect(page.querySelector(".plugins-detail__capabilities")?.textContent).toContain(
          "current_tool",
        ),
      );

      if (outcome === "success") {
        staleInspection.resolve(createInspectResult());
      } else {
        staleInspection.reject(new Error("Earlier inspection failed"));
      }
      await Promise.allSettled(request.mock.results.map(({ value }) => value));
      await page.updateComplete;

      expect(page.querySelector(".plugins-detail__capabilities")?.textContent).toContain(
        "current_tool",
      );
    },
  );

  it("keeps detail inspection failures visible and retries in the same overlay", async () => {
    let attempts = 0;
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.inspect") {
        attempts += 1;
        if (attempts === 1) {
          throw new GatewayRequestError({ code: "UNAVAILABLE", message: "Inspection unavailable" });
        }
        return createInspectResult({
          declared: { ...createInspectResult().declared, tools: ["workboard_create"] },
        });
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway),
    );

    page
      .querySelector<HTMLButtonElement>('[data-plugin-id="workboard"] .plugins-item__detail-button')
      ?.click();

    await waitForFast(() =>
      expect(
        page.querySelector('.plugins-detail__capabilities [role="alert"]')?.textContent,
      ).toContain("Inspection unavailable"),
    );
    page
      .querySelector<HTMLButtonElement>('.plugins-detail__capabilities [role="alert"] button')
      ?.click();

    await waitForFast(() =>
      expect(page.querySelector(".plugins-detail__capabilities")?.textContent).toContain(
        "workboard_create",
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "plugins.inspect")).toHaveLength(2);
  });
});
