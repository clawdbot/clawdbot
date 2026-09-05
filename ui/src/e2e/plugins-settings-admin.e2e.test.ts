// Control UI tests cover the canonical installed-plugin administration surface.
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import type {
  PluginCatalogItem,
  PluginListResult,
  PluginsInspectResult,
} from "../lib/plugins/index.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI plugin settings administration mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("plugin-settings-admin");
  }
});

const pluginMethods = [
  "config.get",
  "config.schema",
  "config.set",
  "plugins.inspect",
  "plugins.list",
  "plugins.setEnabled",
  "plugins.uninstall",
];

const workboard = {
  id: "workboard",
  name: "Workboard",
  packageName: "@openclaw/workboard",
  description: "Plan and track agent-owned work.",
  version: "1.2.3",
  kind: ["productivity"],
  origin: "global",
  installed: true,
  enabled: true,
  state: "enabled",
  removable: true,
} satisfies PluginCatalogItem;

const calendar = {
  id: "calendar",
  name: "Calendar",
  packageName: "@openclaw/calendar",
  description: "Coordinate schedules and events.",
  kind: ["productivity"],
  origin: "bundled",
  installed: true,
  enabled: false,
  state: "needs-setup",
  removable: false,
} satisfies PluginCatalogItem;

const brokenPlugin = {
  id: "broken-plugin",
  name: "Broken plugin",
  description: "Demonstrates plugin diagnostics.",
  origin: "global",
  installed: true,
  enabled: false,
  state: "error",
  error: "Dependency check failed. Reinstall the plugin and restart OpenClaw.",
  removable: true,
} satisfies PluginCatalogItem;

const inventory = {
  plugins: [workboard, calendar],
  diagnostics: [],
  mutationAllowed: true,
} satisfies PluginListResult;

const inspection = {
  ok: true,
  reviewToken: "a".repeat(64),
  plugin: {
    id: workboard.id,
    name: workboard.name,
    origin: workboard.origin,
    installed: true,
    enabled: true,
  },
  source: { kind: "npm", packageName: workboard.packageName },
  declared: {
    channels: [],
    providers: [],
    tools: ["workboard_list"],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  },
  grants: {
    hooks: {
      allowPromptInjection: { effective: true, configured: true },
      allowConversationAccess: { effective: false, configured: false },
    },
  },
} satisfies PluginsInspectResult;

const config = {
  plugins: {
    enabled: true,
    allow: ["workboard"],
    deny: ["legacy-plugin"],
    load: { paths: ["/opt/openclaw/plugins"] },
    entries: {
      workboard: {
        enabled: true,
        config: {
          workspaceLabel: "Planning",
          refreshMinutes: 15,
        },
      },
    },
  },
};

const configMocks = {
  "config.get": {
    appliedConfigHash: "plugins-settings-e2e",
    config,
    hash: "plugins-settings-e2e",
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  },
  "config.schema": {
    generatedAt: "2026-09-01T00:00:00.000Z",
    schema: {
      type: "object",
      properties: {
        plugins: {
          type: "object",
          title: "Plugins",
          properties: {
            enabled: { type: "boolean", title: "Plugin system enabled" },
            allow: {
              type: "array",
              title: "Allowed plugin IDs",
              items: { type: "string" },
            },
            deny: {
              type: "array",
              title: "Blocked plugin IDs",
              items: { type: "string" },
            },
            load: {
              type: "object",
              title: "Plugin loading",
              properties: {
                paths: {
                  type: "array",
                  title: "Additional plugin load paths",
                  items: { type: "string" },
                },
              },
            },
            entries: {
              type: "object",
              title: "Plugin entries",
              properties: {
                workboard: {
                  type: "object",
                  title: "Workboard",
                  properties: {
                    enabled: { type: "boolean", title: "Enabled" },
                    config: {
                      type: "object",
                      title: "Configuration",
                      properties: {
                        workspaceLabel: { type: "string", title: "Workspace label" },
                        refreshMinutes: {
                          type: "integer",
                          title: "Refresh interval (minutes)",
                          minimum: 1,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    uiHints: {
      "plugins.enabled": { advanced: true },
      "plugins.allow": { advanced: true },
      "plugins.deny": { advanced: true },
      "plugins.load.paths": { advanced: true },
      "plugins.entries.workboard.config.workspaceLabel": { advanced: false },
      "plugins.entries.workboard.config.refreshMinutes": { advanced: false },
    },
    version: "e2e",
  },
};

function pluginResponses() {
  return {
    ...configMocks,
    "plugins.inspect": inspection,
    "plugins.list": inventory,
    "plugins.setEnabled": {
      ok: true,
      plugin: { ...workboard, enabled: false, state: "disabled" },
      restartRequired: false,
    },
    "plugins.uninstall": {
      ok: true,
      pluginId: workboard.id,
      removed: ["config entry", "install record"],
      restartRequired: true,
    },
  };
}

async function openWorkboard(page: Parameters<typeof waitForControlUiRoute>[0], baseUrl: string) {
  const response = await page.goto(`${baseUrl}settings/plugins`);
  expect(response?.status()).toBe(200);
  await waitForControlUiRoute(page, {
    pathname: "/settings/plugins",
    routeId: "plugin-settings",
  });

  await page.getByRole("heading", { level: 1, name: "Plugins", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Installed", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Advanced", exact: true }).waitFor();
  const search = page.getByRole("searchbox", { name: "Search installed plugins", exact: true });
  await search.waitFor();
  const inventoryGeometry = await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(".settings-page.oc-app-surface");
    const title = surface?.querySelector<HTMLElement>(".plugins-settings-title");
    const tabs = surface?.querySelector<HTMLElement>(".plugins-settings-tabs.oc-segmented");
    const searchField = surface?.querySelector<HTMLElement>(".plugins-settings-search");
    const section = surface?.querySelector<HTMLElement>(".settings-section");
    if (!surface || !title || !tabs || !searchField || !section) {
      return null;
    }
    const surfaceRect = surface.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const tabsRect = tabs.getBoundingClientRect();
    const searchRect = searchField.getBoundingClientRect();
    const sectionRect = section.getBoundingClientRect();
    return {
      titleLeft: titleRect.left,
      searchLeft: searchRect.left,
      sectionLeft: sectionRect.left,
      surfaceWidth: surfaceRect.width,
      tabsWidth: tabsRect.width,
      tabsToSearch: searchRect.top - tabsRect.bottom,
      searchToSection: sectionRect.top - searchRect.bottom,
    };
  });
  expect(inventoryGeometry).not.toBeNull();
  expect(inventoryGeometry?.tabsWidth ?? Infinity).toBeLessThan(
    (inventoryGeometry?.surfaceWidth ?? 0) / 2,
  );
  expect(
    Math.abs((inventoryGeometry?.titleLeft ?? 0) - (inventoryGeometry?.searchLeft ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs((inventoryGeometry?.searchLeft ?? 0) - (inventoryGeometry?.sectionLeft ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(inventoryGeometry?.tabsToSearch ?? 0).toBeGreaterThan(0);
  expect(inventoryGeometry?.searchToSection ?? 0).toBeGreaterThan(0);
  expect(
    Math.abs(
      (inventoryGeometry?.tabsToSearch ?? Infinity) -
        (inventoryGeometry?.searchToSection ?? -Infinity),
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    await page
      .locator("#plugin-settings-panel article[data-plugin-id]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-plugin-id"))),
  ).toEqual(["calendar", "workboard"]);
  await search.fill("calendar");
  await page.locator('[data-plugin-id="calendar"]').waitFor();
  await expect.poll(() => page.locator('[data-plugin-id="workboard"]').count()).toBe(0);
  await search.clear();

  const workboardRow = page.locator('[data-plugin-id="workboard"]');
  await workboardRow.waitFor();
  const workboardLink = workboardRow.getByRole("link", { name: /Workboard/iu });
  expect(await workboardLink.getAttribute("href")).toBe("/settings/plugins/workboard");
  expect(await workboardRow.locator(".settings-status").count()).toBe(0);
  const enabledSwitch = workboardRow.getByRole("switch");
  expect(await enabledSwitch.count()).toBe(1);
  expect(
    await enabledSwitch.evaluate(
      (element) => (element as HTMLElement & { checked: boolean }).checked,
    ),
  ).toBe(true);
  await page.locator(".settings-page.oc-app-surface").waitFor();
  if (captureUiProof) {
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: path.join(proofDir, "01-installed-inventory.png"),
    });
  }
  await workboardLink.click();
  await waitForControlUiRoute(page, {
    pathname: "/settings/plugins/workboard",
    routeId: "plugin-settings",
  });
}

suite.define(() => {
  it("drills from searchable inventory into canonical configuration, access, and lifecycle sections", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: pluginMethods,
          methodResponses: pluginResponses(),
          operatorScopes: ["operator.read", "operator.admin"],
        });

        await openWorkboard(page, suite.server.baseUrl);
        await page.getByRole("heading", { level: 1, name: "Workboard", exact: true }).waitFor();
        await page.getByRole("link", { name: "Settings", exact: true }).waitFor();
        const detailGeometry = await page.evaluate(() => {
          const breadcrumb = document.querySelector<HTMLElement>(".plugins-settings-breadcrumb");
          const parent = breadcrumb?.querySelector<HTMLElement>(
            ".plugins-settings-breadcrumb__parent",
          );
          const current = breadcrumb?.querySelector<HTMLElement>(
            ".plugins-settings-breadcrumb__current",
          );
          const hero = document.querySelector<HTMLElement>(".plugins-settings-detail-hero");
          const tile = hero?.querySelector<HTMLElement>(".plugins-tile");
          const title = hero?.querySelector<HTMLElement>("h1");
          const description = hero?.querySelector<HTMLElement>(
            ".plugins-settings-detail-description",
          );
          const toggle = hero?.querySelector<HTMLElement>("wa-switch");
          const surface = hero?.closest<HTMLElement>(".settings-page");
          const firstSection = surface?.querySelector<HTMLElement>(".settings-section");
          if (
            !breadcrumb ||
            !parent ||
            !current ||
            !hero ||
            !tile ||
            !title ||
            !description ||
            !toggle ||
            !surface ||
            !firstSection
          ) {
            return null;
          }
          const breadcrumbRect = breadcrumb.getBoundingClientRect();
          const heroRect = hero.getBoundingClientRect();
          const tileRect = tile.getBoundingClientRect();
          const toggleRect = toggle.getBoundingClientRect();
          const accentProbe = document.createElement("span");
          accentProbe.style.color = "var(--accent)";
          document.body.append(accentProbe);
          const accentColor = getComputedStyle(accentProbe).color;
          accentProbe.remove();
          return {
            breadcrumbAboveHero: breadcrumbRect.bottom <= heroRect.top,
            breadcrumbToHero: heroRect.top - breadcrumbRect.bottom,
            colorsMatch: getComputedStyle(parent).color === getComputedStyle(current).color,
            currentColor: getComputedStyle(current).color,
            accentColor,
            breadcrumbFontSize: Number.parseFloat(getComputedStyle(current).fontSize),
            titleFontSize: Number.parseFloat(getComputedStyle(title).fontSize),
            description: description.textContent,
            legacySubtitleCount: surface.querySelectorAll(".page-subtitle").length,
            heroLeft: heroRect.left,
            sectionLeft: firstSection.getBoundingClientRect().left,
            tileTop: tileRect.top,
            toggleTop: toggleRect.top,
          };
        });
        expect(detailGeometry).not.toBeNull();
        expect(detailGeometry?.breadcrumbAboveHero).toBe(true);
        expect(detailGeometry?.breadcrumbToHero ?? 0).toBeGreaterThanOrEqual(16);
        expect(detailGeometry?.colorsMatch).toBe(true);
        expect(detailGeometry?.currentColor).not.toBe(detailGeometry?.accentColor);
        expect(detailGeometry?.breadcrumbFontSize ?? Infinity).toBeLessThan(
          detailGeometry?.titleFontSize ?? 0,
        );
        expect(detailGeometry?.description).toBe("Plan and track agent-owned work.");
        expect(detailGeometry?.legacySubtitleCount).toBe(0);
        expect(
          Math.abs((detailGeometry?.heroLeft ?? 0) - (detailGeometry?.sectionLeft ?? 0)),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs((detailGeometry?.toggleTop ?? 0) - (detailGeometry?.tileTop ?? 0)),
        ).toBeLessThanOrEqual(1);
        expect(await page.getByRole("status").filter({ hasText: "Enabled" }).count()).toBe(0);
        await page.getByRole("heading", { name: "Configuration", exact: true }).waitFor();
        const refresh = page.getByRole("button", { name: "Reload", exact: true });
        await refresh.waitFor();
        expect((await refresh.textContent())?.trim()).toBe("");
        expect(await refresh.getAttribute("title")).toBeNull();
        expect(
          await refresh.evaluate((button) => {
            const header = button.closest(".settings-section__header")?.getBoundingClientRect();
            return header
              ? Math.abs(header.right - button.getBoundingClientRect().right)
              : Infinity;
          }),
        ).toBeLessThanOrEqual(1);
        await page.getByRole("heading", { name: "Access & capabilities", exact: true }).waitFor();
        await page.getByRole("heading", { name: "Lifecycle", exact: true }).waitFor();
        expect(await gateway.getRequests("plugins.inspect")).toHaveLength(1);

        await page.getByText("Add context to prompts", { exact: true }).waitFor();
        await page.getByText("Read conversation context", { exact: true }).waitFor();
        expect(await page.getByText("workboard_list", { exact: true }).isVisible()).toBe(false);
        await page.locator("summary").filter({ hasText: "Advanced" }).click();
        await page.getByText("workboard_list", { exact: true }).waitFor();
        await page.locator("code").filter({ hasText: "@openclaw/workboard" }).first().waitFor();
        await page.getByText(/1\.2\.3/u).waitFor();
        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDir, "02-plugin-detail.png"),
          });
        }
        await page.reload();
        await waitForControlUiRoute(page, {
          pathname: "/settings/plugins/workboard",
          routeId: "plugin-settings",
        });
        await page.getByRole("link", { name: "Settings", exact: true }).click();
        await waitForControlUiRoute(page, {
          pathname: "/settings/plugins",
          routeId: "plugin-settings",
        });
      },
    );
  });

  it("shows the diagnostic and next step for an errored installed plugin", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: pluginMethods,
          methodResponses: {
            ...pluginResponses(),
            "plugins.list": { ...inventory, plugins: [brokenPlugin] },
            "plugins.inspect": {
              ...inspection,
              plugin: {
                ...inspection.plugin,
                id: brokenPlugin.id,
                name: brokenPlugin.name,
                enabled: false,
              },
            },
          },
          operatorScopes: ["operator.read", "operator.admin"],
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/plugins/broken-plugin`);
        expect(response?.status()).toBe(200);
        await waitForControlUiRoute(page, {
          pathname: "/settings/plugins/broken-plugin",
          routeId: "plugin-settings",
        });

        await page.getByRole("heading", { level: 1, name: "Broken plugin", exact: true }).waitFor();
        await page.getByText("Needs attention", { exact: true }).waitFor();
        await page
          .getByRole("alert")
          .filter({
            hasText: "Dependency check failed. Reinstall the plugin and restart OpenClaw.",
          })
          .waitFor();
        expect(
          await page.getByRole("heading", { name: "Configuration", exact: true }).count(),
        ).toBe(0);
        expect(await page.getByRole("button", { name: "Reload", exact: true }).count()).toBe(0);
        expect(await page.getByText("This plugin has no configurable settings.").count()).toBe(0);
        await page.getByRole("heading", { name: "Access & capabilities", exact: true }).waitFor();
        await page.getByRole("heading", { name: "Lifecycle", exact: true }).waitFor();
      },
    );
  });

  it("saves schema-backed plugin configuration and reports lifecycle outcomes", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: pluginMethods,
          methodResponses: pluginResponses(),
          operatorScopes: ["operator.read", "operator.admin"],
        });
        await openWorkboard(page, suite.server.baseUrl);

        const toggle = page.locator("wa-switch").filter({ hasText: "Enable or disable Workboard" });
        await toggle.click();
        await gateway.waitForRequest("plugins.setEnabled");
        await page.getByRole("status").filter({ hasText: "Disabled Workboard." }).waitFor();
        expect(
          await page
            .locator(".plugins-row-message")
            .filter({ hasText: "Disabled Workboard." })
            .count(),
        ).toBe(1);

        const workspace = page.getByLabel("Workspace label", { exact: true });
        const catalogRequests = (await gateway.getRequests("plugins.list")).length;
        await workspace.fill("Release planning");
        const save = await gateway.waitForRequest("config.set");
        expect(save.params).toMatchObject({ baseHash: "plugins-settings-e2e" });
        const savedConfig = JSON.parse(
          String((save.params as { raw?: unknown }).raw),
        ) as typeof config;
        expect(savedConfig.plugins.entries.workboard.config).toMatchObject({
          refreshMinutes: 15,
          workspaceLabel: "Release planning",
        });
        await expect
          .poll(async () => (await gateway.getRequests("plugins.list")).length)
          .toBe(catalogRequests + 1);
        expect(
          await page.getByRole("button", { name: "Save configuration", exact: true }).count(),
        ).toBe(0);

        const uninstallCount = (await gateway.getRequests("plugins.uninstall")).length;
        await page.getByRole("button", { name: /(?:Remove|Uninstall) Workboard/iu }).click();
        await page.getByRole("dialog").waitFor();
        await page
          .locator(".exec-approval-actions")
          .getByRole("button", { name: "Remove", exact: true })
          .click();
        await gateway.waitForRequest("plugins.uninstall", { after: uninstallCount });
        await page
          .getByRole("status")
          .filter({ hasText: /removed|uninstalled/iu })
          .waitFor();
      },
    );
  });

  it("keeps global plugin policy in Advanced and exposes read-only details without mutations", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: pluginMethods,
          methodResponses: pluginResponses(),
          operatorScopes: ["operator.read"],
        });

        await page.goto(`${suite.server.baseUrl}settings/plugins`);
        await page.getByRole("tab", { name: "Advanced", exact: true }).click();
        const advancedTitles = page.locator(".settings-row__title");
        await advancedTitles.getByText("Plugin system enabled", { exact: true }).waitFor();
        await advancedTitles.getByText("Allowed plugin IDs", { exact: true }).waitFor();
        await advancedTitles.getByText("Blocked plugin IDs", { exact: true }).waitFor();
        await advancedTitles.getByText("Additional plugin load paths", { exact: true }).waitFor();
        await expect
          .poll(() =>
            page
              .locator("input")
              .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
          )
          .toEqual(expect.arrayContaining(["legacy-plugin", "/opt/openclaw/plugins"]));

        await page.getByRole("tab", { name: "Installed", exact: true }).click();
        await page.locator('[data-plugin-id="workboard"]').click();
        await waitForControlUiRoute(page, {
          pathname: "/settings/plugins/workboard",
          routeId: "plugin-settings",
        });
        expect(await page.locator(".callout.info").count()).toBe(0);
        expect(
          await page.getByRole("button", { name: "Save configuration", exact: true }).count(),
        ).toBe(0);
        const workspace = page.getByLabel("Workspace label", { exact: true });
        const toggle = page.locator("wa-switch").filter({ hasText: "Enable or disable Workboard" });
        const uninstall = page.getByRole("button", {
          name: /(?:Remove|Uninstall) Workboard/iu,
        });
        expect(await workspace.isDisabled()).toBe(true);
        expect(await toggle.getAttribute("aria-disabled")).toBe("true");
        expect(await uninstall.getAttribute("aria-disabled")).toBe("true");
        await toggle.dispatchEvent("click");
        await uninstall.dispatchEvent("click");
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
        expect(await gateway.getRequests("plugins.uninstall")).toHaveLength(0);
      },
    );
  });

  it("recovers catalog, configuration, and inspection failures in place", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const failure = (message: string) => ({
          __mockError: { code: "UNAVAILABLE", message },
        });
        const gateway = await installMockGateway(page, {
          featureMethods: pluginMethods,
          methodResponses: {
            ...configMocks,
            "config.get": failure("Configuration unavailable"),
            "plugins.inspect": {
              sequence: [failure("Inspection unavailable"), inspection],
            },
            "plugins.list": {
              sequence: [failure("Catalog unavailable"), inventory],
            },
          },
          operatorScopes: ["operator.read", "operator.admin"],
        });

        await page.goto(`${suite.server.baseUrl}settings/plugins`);
        await page.getByRole("alert").filter({ hasText: "Catalog unavailable" }).waitFor();
        const catalogRequests = (await gateway.getRequests("plugins.list")).length;
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        await page.locator('[data-plugin-id="workboard"]').waitFor();
        expect(await gateway.getRequests("plugins.list")).toHaveLength(catalogRequests + 1);

        await page.locator('[data-plugin-id="workboard"]').click();
        const inspectionError = page
          .getByRole("alert")
          .filter({ hasText: "Inspection unavailable" });
        await inspectionError.waitFor();
        await inspectionError.getByRole("button", { name: "Try again", exact: true }).click();
        await page.getByText("Add context to prompts", { exact: true }).waitFor();
        expect(await gateway.getRequests("plugins.inspect")).toHaveLength(2);

        await page.getByRole("alert").filter({ hasText: "Configuration unavailable" }).waitFor();
        const configRequests = (await gateway.getRequests("config.get")).length;
        await gateway.setMethodResponse("config.get", configMocks["config.get"]);
        await page.getByRole("button", { name: "Reload", exact: true }).click();
        await page.getByLabel("Workspace label", { exact: true }).waitFor();
        expect(await gateway.getRequests("config.get")).toHaveLength(configRequests + 1);
      },
    );
  });
});
