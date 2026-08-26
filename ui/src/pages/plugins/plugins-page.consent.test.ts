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

  it("inspects an installable plugin and waits for operator consent before installing it", async () => {
    const installed = createPlugin({
      ...createAvailablePlugin(),
      installed: true,
      enabled: true,
      state: "enabled",
    });
    const { page, request } = await mountDiscover(async (method) => {
      if (method === "plugins.inspect") {
        return createInspectResult({
          plugin: {
            id: "calendar-runtime",
            name: "Calendar Plus",
            origin: "official",
            installed: false,
            enabled: false,
          },
        });
      }
      if (method === "plugins.install") {
        return { ok: true, plugin: installed, restartRequired: true };
      }
      if (method === "plugins.list") {
        return createResult(installed);
      }
      throw new Error(`Unexpected method ${method}`);
    });

    await clickRowAction(page, '[data-plugin-id="calendar-runtime"]', "Install");

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: "calendar-runtime" }),
    );
    expect(page.querySelector('[data-plugin-consent="install"]')?.textContent).toContain(
      "Calendar Plus",
    );
    expect(request.mock.calls.some(([method]) => method === "plugins.install")).toBe(false);

    page.querySelector<HTMLButtonElement>('[data-plugin-consent="install"] .btn.primary')?.click();

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("plugins.install", {
        source: "official",
        pluginId: "calendar-runtime",
        acknowledgeCapabilities: true,
      }),
    );
    await page.updateComplete;
    expect(page.querySelector('[data-plugin-consent="install"]')).toBeNull();
  });

  it("does not reopen consent when an install-policy warning has already been acknowledged", async () => {
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
        return { ok: true, plugin: installed, restartRequired: true };
      }
      if (method === "plugins.list") {
        return createResult(installed);
      }
      throw new Error(`Unexpected method ${method}`);
    });

    await clickRowAction(page, '[data-plugin-id="calendar-runtime"]', "Install");
    await waitForFast(() =>
      expect(
        page.querySelector<HTMLButtonElement>('[data-plugin-consent="install"] .btn.primary')
          ?.disabled,
      ).toBe(false),
    );
    page.querySelector<HTMLButtonElement>('[data-plugin-consent="install"] .btn.primary')?.click();
    await waitForFast(() =>
      expect(page.querySelector(".plugins-policy-review")?.textContent).toContain(
        "Review this plugin.",
      ),
    );

    page.querySelector<HTMLButtonElement>(".plugins-policy-review__actions .btn.danger")?.click();

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("plugins.install", {
        source: "official",
        pluginId: "calendar-runtime",
        acknowledgeCapabilities: true,
        acknowledgeInstallPolicyWarning: true,
      }),
    );
    expect(request.mock.calls.filter(([method]) => method === "plugins.inspect")).toHaveLength(1);
    expect(page.querySelector('[data-plugin-consent="install"]')).toBeNull();
  });

  it.each([
    { origin: "global", initiallyEnabled: false, expectsConsent: true },
    { origin: "bundled", initiallyEnabled: false, expectsConsent: false },
    { origin: "global", initiallyEnabled: true, expectsConsent: false },
  ])(
    "requires consent only when enabling external plugins ($origin, enabled=$initiallyEnabled)",
    async ({ origin, initiallyEnabled, expectsConsent }) => {
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
        if (method === "plugins.inspect") {
          return createInspectResult();
        }
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

      if (expectsConsent) {
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: "workboard" }),
        );
        expect(page.querySelector('[data-plugin-consent="enable"]')).not.toBeNull();
        expect(request.mock.calls.some(([method]) => method === "plugins.setEnabled")).toBe(false);
        page
          .querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] .btn.primary')
          ?.click();
      }

      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
          pluginId: "workboard",
          enabled: !initiallyEnabled,
          ...(expectsConsent ? { acknowledgeCapabilities: true } : {}),
        }),
      );
      expect(request.mock.calls.filter(([method]) => method === "plugins.inspect")).toHaveLength(
        expectsConsent ? 1 : 0,
      );
    },
  );

  it("keeps installation available when a plugin is not yet inspectable", async () => {
    const installed = createPlugin({
      ...createAvailablePlugin(),
      installed: true,
      enabled: true,
      state: "enabled",
    });
    const { page, request } = await mountDiscover(async (method) => {
      if (method === "plugins.inspect") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "plugin not found: calendar-runtime",
        });
      }
      if (method === "plugins.install") {
        return { ok: true, plugin: installed, restartRequired: true };
      }
      if (method === "plugins.list") {
        return createResult(installed);
      }
      throw new Error(`Unexpected method ${method}`);
    });

    await clickRowAction(page, '[data-plugin-id="calendar-runtime"]', "Install");
    await waitForFast(() =>
      expect(page.querySelector('[data-plugin-consent="install"]')?.textContent).toContain(
        "Capability declarations are verified during install.",
      ),
    );
    const confirm = page.querySelector<HTMLButtonElement>(
      '[data-plugin-consent="install"] .btn.primary',
    );
    expect(confirm?.disabled).toBe(false);

    confirm?.click();

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("plugins.install", {
        source: "official",
        pluginId: "calendar-runtime",
        acknowledgeCapabilities: true,
      }),
    );
  });

  it("uses authoritative consent details without inspecting again and acknowledges its retry", async () => {
    const plugin = createPlugin({ origin: "bundled", enabled: false, state: "disabled" });
    const updated = createPlugin({ ...plugin, enabled: true, state: "enabled" });
    const inspection = createInspectResult();
    const details = buildCapabilityConsentErrorDetails({
      pluginId: "workboard",
      name: "Authoritative Workboard",
      declared: { ...inspection.declared, tools: ["workboard_review"] },
      grants: inspection.grants,
      source: { kind: "npm", packageName: "@openclaw/workboard" },
      widened: { tools: ["workboard_review"] },
      acceptedAt: "2026-08-20T14:03:00Z",
    });
    const { client, request } = createClient(async (method, params) => {
      if (method === "plugins.setEnabled") {
        if (typeof params !== "object" || !params || !("acknowledgeCapabilities" in params)) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Capability consent required",
            details,
          });
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
    await waitForFast(() => {
      const dialog = page.querySelector('[data-plugin-consent="enable"]');
      expect(dialog?.textContent).toContain("Authoritative Workboard");
      expect(dialog?.textContent).toContain("workboard_review");
    });
    expect(request.mock.calls.some(([method]) => method === "plugins.inspect")).toBe(false);

    page.querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] .btn.primary')?.click();

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
        pluginId: "workboard",
        enabled: true,
        acknowledgeCapabilities: true,
      }),
    );
    await page.updateComplete;
    expect(page.querySelector('[data-plugin-consent="enable"]')).toBeNull();
  });

  it("does not reopen consent when an acknowledged enable retry remains rejected", async () => {
    const plugin = createPlugin({ origin: "bundled", enabled: false, state: "disabled" });
    const inspection = createInspectResult();
    const details = buildCapabilityConsentErrorDetails({
      pluginId: "workboard",
      name: "Workboard",
      declared: inspection.declared,
      grants: inspection.grants,
    });
    const { client, request } = createClient(async (method) => {
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
      expect(page.querySelector('[data-plugin-consent="enable"]')).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] .btn.primary')?.click();

    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "plugins.setEnabled")).toHaveLength(
        2,
      ),
    );
    await waitForFast(() =>
      expect(page.textContent).toContain("Capability consent remains invalid"),
    );
    expect(page.querySelector('[data-plugin-consent="enable"]')).toBeNull();
  });

  it("keeps hard inspection failures visible and retries before enabling the action", async () => {
    const plugin = createPlugin({ origin: "global" });
    let attempts = 0;
    const { client, request } = createClient(async (method) => {
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
});
