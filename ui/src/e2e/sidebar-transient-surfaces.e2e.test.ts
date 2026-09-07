import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiSettingsTakeover } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { createSidebarCustomizationSuite } from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite(
  "Control UI transient surface tokens mocked Gateway E2E",
);
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const themes = [
  { colorScheme: "light", resolvedTheme: "light", theme: "claw" },
  { colorScheme: "dark", resolvedTheme: "dark", theme: "claw" },
  { colorScheme: "light", resolvedTheme: "openknot-light", theme: "knot" },
  { colorScheme: "dark", resolvedTheme: "openknot", theme: "knot" },
  { colorScheme: "light", resolvedTheme: "dash-light", theme: "dash" },
  { colorScheme: "dark", resolvedTheme: "dash", theme: "dash" },
] as const;

function configResponse(theme: "claw" | "knot" | "dash", colorScheme: "light" | "dark") {
  const config = { ui: { prefs: { locale: "en", theme, themeMode: colorScheme } } };
  const hash = `transient-surfaces-${theme}-${colorScheme}`;
  return {
    appliedConfigHash: hash,
    config,
    configRevisionHash: hash,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

async function surfaceTokens(surface: Locator) {
  return surface.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
}

suite.define(() => {
  it.each(themes)(
    "uses one transient surface contract in $theme $colorScheme",
    async ({ colorScheme, resolvedTheme, theme }) => {
      const context = await suite.newBrowserContext({
        colorScheme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      });
      const page = await context.newPage();
      const sessionKey = "agent:main:release-notes";
      await installMockGateway(page, {
        featureMethods: ["sessions.patch"],
        methodResponses: {
          "config.get": configResponse(theme, colorScheme),
          "sessions.list": sessionsListResponse([
            sessionRow(sessionKey, "Release notes", Date.parse("2026-08-14T15:59:00.000Z")),
          ]),
        },
        sessionKey,
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const root = page.locator("html");
        await expect.poll(() => root.getAttribute("data-theme")).toBe(resolvedTheme);

        const session = page.locator(`openclaw-app-sidebar [data-session-key="${sessionKey}"]`);
        await session.waitFor();
        await session.hover();
        await session.locator("[data-session-menu]").click();
        const menuSurface = page.getByRole("menu", {
          name: "Actions for Release notes",
          exact: true,
        });
        await menuSurface.waitFor({ state: "visible" });
        const menuTokens = await surfaceTokens(menuSurface);
        if (captureProof && theme === "claw") {
          await mkdir(path.join(suite.artifactDir, "transient-surfaces"), { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              path.join(suite.artifactDir, "transient-surfaces"),
              `session-menu-${colorScheme}.png`,
            ),
          });
        }

        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await waitForControlUiSettingsTakeover(page);
        const languageSelect = page.locator("#settings-language wa-select");
        await languageSelect.click();
        const listbox = languageSelect.locator('[part="listbox"]');
        await listbox.waitFor({ state: "visible" });
        if (captureProof && theme === "claw") {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              path.join(suite.artifactDir, "transient-surfaces"),
              `settings-listbox-${colorScheme}.png`,
            ),
          });
        }

        expect(await surfaceTokens(listbox)).toEqual(menuTokens);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
