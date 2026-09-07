import path from "node:path";
import { expect, it } from "vitest";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  createNativeEmbedLayoutMethodResponses,
  installExistingNativeDeviceSettings,
} from "./native-embed-fixtures.test-support.ts";
import { installNativeEmbed, installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI native embed settings E2E" });
const routes = [
  "custodian",
  "profile",
  "appearance",
  "notifications",
  "device",
  "device-permissions",
  "connection",
  "channels",
  "communications",
  "talk",
  "devices",
  "cloud-workers",
  "agents",
  "labs",
  "model-providers",
  "mcp",
  "memory",
  "automation",
  "security",
  "secrets",
  "approvals",
  "infrastructure",
  "advanced",
  "debug",
  "logs",
  "updates",
  "about",
  "skills",
  "cron",
] as const satisfies readonly RouteId[];
const viewports = [
  { width: 375, height: 812, formFactor: "phone" },
  { width: 390, height: 844, formFactor: "phone" },
  { width: 1024, height: 1366, formFactor: "pad" },
] as const;

suite.define(() => {
  for (const destination of [
    { from: "memory", route: "memory-import", title: "Import Memory", tab: "Settings" },
    { from: "skills", route: "plugins", title: "Plugins", tab: "Installed" },
    { from: "skills", route: "skill-workshop", title: "Skill Workshop", tab: "Workshop" },
  ] as const) {
    it(`returns from embedded ${destination.route} through its page link and direct entry`, async () => {
      await suite.withPage(
        { viewport: { width: 375, height: 812 }, hasTouch: true, serviceWorkers: "block" },
        async ({ page }) => {
          await installNativeEmbed(page, { platform: "ios", formFactor: "phone" });
          await installMockGateway(page, {
            operatorScopes: ["operator.admin", "operator.read", "operator.write"],
            methodResponses: {
              "doctor.memory.status": {
                agentId: "main",
                provider: "none",
                embedding: { ok: false, checked: false },
              },
              "migrations.memory.plan": {
                agentId: "main",
                workspace: "/tmp/synthetic-workspace",
                providers: [],
              },
            },
          });
          await page.goto(new URL(pathForRoute(destination.from), suite.server.baseUrl).toString());
          await waitForControlUiRoute(page, { routeId: destination.from });
          if (destination.from === "memory") {
            await page.getByRole("tab", { name: destination.tab, exact: true }).click();
            await page.locator('a[href="/memory-import"]').click();
          } else {
            await page.getByRole("tab", { name: destination.tab, exact: true }).click();
          }
          await waitForControlUiRoute(page, { routeId: destination.route });
          const header = page.locator(".native-embed-header");
          await header.getByRole("heading", { name: destination.title, exact: true }).waitFor();
          expect(await page.locator(".shell-nav, openclaw-app-topbar").count()).toBe(0);
          await header.getByRole("button", { name: "Back", exact: true }).click();
          // Memory's document link uses the parent fallback; hub tabs use app history.
          await waitForControlUiRoute(page, {
            routeId: destination.from,
            pathname: pathForRoute(destination.from),
          });

          await page.goto(
            new URL(pathForRoute(destination.route), suite.server.baseUrl).toString(),
          );
          await waitForControlUiRoute(page, { routeId: destination.route });
          await header.getByRole("heading", { name: destination.title, exact: true }).waitFor();
          await header.getByRole("button", { name: "Back", exact: true }).click();
          const parent = destination.from === "memory" ? "memory" : "settings";
          await waitForControlUiRoute(page, { routeId: parent, pathname: pathForRoute(parent) });
          if (parent === "memory") {
            await header.getByRole("button", { name: "Back", exact: true }).click();
            await waitForControlUiRoute(page, { routeId: "settings", pathname: "/settings" });
          }
        },
      );
    });
  }

  it("keeps embedded Back and settings navigation usable while offline", async () => {
    await suite.withPage(
      { viewport: { width: 375, height: 812 }, hasTouch: true, serviceWorkers: "block" },
      async ({ page }) => {
        await installNativeEmbed(page, { platform: "ios", formFactor: "phone" });
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.admin", "operator.read"],
        });
        await page.goto(new URL("settings/talk", suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, { routeId: "talk" });
        await page.locator(".native-embed-header__back").waitFor();
        await gateway.setOnline(false);
        await page.locator("openclaw-router-outlet[inert]").waitFor({ state: "attached" });
        await page.locator(".native-embed-header__back").click();
        await waitForControlUiRoute(page, { routeId: "settings", pathname: "/settings" });
        await page
          .locator(".native-embed-header")
          .getByRole("button", { name: /offline.*retry/i })
          .waitFor();
        await page.locator('.settings-embed-list a[href="/settings/appearance"]').click();
        await waitForControlUiRoute(page, { routeId: "appearance" });
        await page.locator(".native-embed-header__back").click();
        await waitForControlUiRoute(page, { routeId: "settings" });
      },
    );
  });

  it("keeps native device capability visibility and overrides native web chrome", async () => {
    await suite.withPage(
      { viewport: { width: 375, height: 812 }, hasTouch: true, serviceWorkers: "block" },
      async ({ page }) => {
        await installNativeWebChrome(page);
        await installNativeEmbed(page, { platform: "macos", formFactor: "phone" });
        await installExistingNativeDeviceSettings(page);
        await installMockGateway(page, { operatorScopes: ["operator.read"] });
        await page.goto(new URL("settings", suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, { routeId: "settings" });
        const list = page.locator(".settings-embed-list");
        await list.locator('a[href="/settings/device"]').waitFor();
        expect(await list.locator('a[href="/settings/security"]').count()).toBe(0);
        for (const route of ["device", "device-permissions", "talk", "updates"] as const) {
          await list.locator(`a[href="${pathForRoute(route)}"]`).click();
          await waitForControlUiRoute(page, { routeId: route });
          expect(
            await page
              .locator(".shell-nav, openclaw-app-topbar, openclaw-macos-titlebar-controls")
              .count(),
          ).toBe(0);
          expect(
            await page
              .locator("main.content")
              .evaluate((main) => main.scrollWidth <= main.clientWidth),
          ).toBe(true);
          expect(
            await page
              .locator(
                'input:not([type="hidden"], [type="checkbox"], [type="radio"]), select, textarea',
              )
              .evaluateAll((fields) =>
                fields
                  .filter((field) => field.getBoundingClientRect().width > 0)
                  .every((field) => Number.parseFloat(getComputedStyle(field).fontSize) >= 16),
              ),
          ).toBe(true);
          await page.locator(".native-embed-header__back").click();
          await waitForControlUiRoute(page, { routeId: "settings" });
        }
      },
    );
  });
  it("preserves normal desktop chrome for absent and malformed embed flags", async () => {
    for (const flag of [undefined, { platform: "ios", formFactor: "watch" }]) {
      await suite.withPage(
        { viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          await page.addInitScript(
            (host) => Object.assign(window, { __OPENCLAW_NATIVE_EMBED__: host }),
            flag,
          );
          await installMockGateway(page, { operatorScopes: ["operator.admin", "operator.read"] });
          await page.goto(new URL("settings/appearance", suite.server.baseUrl).toString());
          await waitForControlUiRoute(page, { routeId: "appearance" });
          await page.locator(".shell--settings .settings-sidebar").waitFor();
          expect(await page.locator(".shell-nav").isVisible()).toBe(true);
          expect(await page.locator("openclaw-app-topbar").count()).toBe(1);
          expect(
            await page
              .locator(".shell--embed, .native-embed-header, html.openclaw-native-embed")
              .count(),
          ).toBe(0);
        },
      );
    }
  });
  for (const viewport of viewports) {
    for (const colorScheme of ["light", "dark"] as const) {
      it(`renders settings at ${viewport.width}px in ${colorScheme}`, async () => {
        const artifactDir = createControlUiE2eArtifactDir("native-embed-settings");
        await suite.withPage(
          { viewport, colorScheme, hasTouch: true, locale: "en-US", serviceWorkers: "block" },
          async ({ page }) => {
            await installNativeEmbed(page, { platform: "ios", formFactor: viewport.formFactor });
            await installExistingNativeDeviceSettings(page);
            const methodResponses = createNativeEmbedLayoutMethodResponses();
            await installMockGateway(page, {
              methodResponses,
              featureMethods: [
                ...defaultControlUiFeatureMethods,
                ...Object.keys(methodResponses),
                "secrets.store.set",
                "secrets.store.delete",
              ],
              operatorScopes: [
                "operator.admin",
                "operator.read",
                "operator.write",
                "operator.approvals",
                "operator.pairing",
              ],
            });
            for (const route of ["settings", ...routes] as const) {
              const pathname =
                route === "settings"
                  ? "/settings"
                  : route === "cron"
                    ? "/cron"
                    : pathForRoute(route);
              expect(
                (await page.goto(new URL(pathname, suite.server.baseUrl).toString()))?.status(),
              ).toBe(200);
              await waitForControlUiRoute(page, { routeId: route });
              await page.locator("html.openclaw-native-embed .shell--embed").waitFor();
              await page
                .locator(".native-embed-header openclaw-settings-save-indicator")
                .waitFor({ state: "attached" });
              expect(
                await page
                  .locator(
                    ".shell-nav, openclaw-app-topbar, .shell-chrome-controls, resizable-divider, .settings-sidebar__footer, openclaw-macos-titlebar-controls, openclaw-keyboard-shortcuts-dialog",
                  )
                  .count(),
              ).toBe(0);
              if (route === "settings") {
                const list = page.locator(".settings-embed-list");
                await list.locator("a").first().waitFor();
                expect(
                  await list
                    .locator("a")
                    .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
                ).toEqual(
                  routes
                    .filter((id) => id !== "skills" && id !== "cron")
                    .map((id) => pathForRoute(id)),
                );
                expect(
                  await list
                    .locator("a")
                    .evaluateAll((links) =>
                      links.every((link) => link.getBoundingClientRect().height >= 44),
                    ),
                ).toBe(true);
              } else {
                await page.locator(".native-embed-header .page-title").waitFor();
                await page.locator("openclaw-router-outlet > *").first().waitFor();
              }
              if (route === "devices") {
                await page.locator(".device-entry__details summary").first().click();
                await page.locator(".device-token-table tbody td").first().waitFor();
              }
              if (["devices", "secrets", "approvals", "debug"].includes(route)) {
                await page
                  .locator(".settings-table--stacked tbody td[data-label]")
                  .first()
                  .waitFor();
                if (viewport.width <= 400) {
                  expect(
                    await page
                      .locator(".settings-table--stacked")
                      .evaluateAll((tables) =>
                        tables.every((table) => table.scrollWidth <= table.clientWidth),
                      ),
                    route,
                  ).toBe(true);
                }
              }
              if (route === "cron") {
                await page.getByText("Healthy automation", { exact: true }).first().waitFor();
              }
              expect(
                await page.evaluate(
                  () => document.documentElement.scrollWidth <= window.innerWidth,
                ),
                route,
              ).toBe(true);
              expect(
                await page
                  .locator("main.content")
                  .evaluate((main) => main.scrollWidth <= main.clientWidth),
                route,
              ).toBe(true);
              if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
                await page.screenshot({
                  animations: "disabled",
                  fullPage: true,
                  path: path.join(
                    artifactDir,
                    `${route}-${viewport.width}x${viewport.height}-${colorScheme}.png`,
                  ),
                });
              }
              if (route !== "settings") {
                await page.locator(".native-embed-header__back").click();
                await waitForControlUiRoute(page, { routeId: "settings", pathname: "/settings" });
                if (route === "appearance") {
                  await page.locator('.settings-embed-list a[href="/settings/appearance"]').click();
                  await waitForControlUiRoute(page, { routeId: "appearance" });
                  await page.locator(".native-embed-header__back").click();
                  await waitForControlUiRoute(page, { routeId: "settings", pathname: "/settings" });
                }
              }
            }
          },
        );
      }, 180_000);
    }
  }
});
