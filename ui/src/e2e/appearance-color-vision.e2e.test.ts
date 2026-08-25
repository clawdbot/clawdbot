// Control UI tests cover color-vision preference scope, resets, and live semantic-color updates.
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { importCustomThemeFromUrl } from "../app/custom-theme.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
  waitForControlUiSettingsTakeover,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createTweakcnThemePayload } from "../test-helpers/custom-theme.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI color-vision preference mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const SESSION_KEY = "agent:main:color-vision";

function configResponse(prefs: Record<string, unknown>, hash: string) {
  const config = { ui: { prefs } };
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

function settingsRow(page: Page, title: string): Locator {
  return page
    .locator(".settings-row")
    .filter({ has: page.locator(".settings-row__title", { hasText: title }) })
    .first();
}

function patchedPrefs(request: MockGatewayRequest): Record<string, unknown> {
  const raw = (request.params as { raw?: unknown } | undefined)?.raw;
  expect(typeof raw).toBe("string");
  const parsed = JSON.parse(String(raw)) as { ui?: { prefs?: Record<string, unknown> } };
  expect(parsed.ui?.prefs).toBeTruthy();
  return parsed.ui?.prefs ?? {};
}

async function navigateToAppearance(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: {
        context: {
          navigate: (routeId: string, options: { pathname: string }) => void;
        };
      };
    };
    if (!app.runtime) {
      throw new Error("OpenClaw application runtime is unavailable");
    }
    app.runtime.context.navigate("appearance", { pathname: "/settings/appearance" });
  });
  await waitForControlUiSettingsTakeover(page);
}

async function waitForRequestCount(
  gateway: MockGatewayControls,
  method: string,
  count: number,
): Promise<void> {
  await expect
    .poll(async () => (await gateway.getRequests(method)).length, { timeout: 10_000 })
    .toBe(count);
}

suite.define(() => {
  it("keeps color-vision palettes dormant for arbitrary imported themes", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        const importedTheme = await importCustomThemeFromUrl(
          "color-vision-custom",
          async () =>
            new Response(JSON.stringify(createTweakcnThemePayload()), {
              status: 200,
            }),
        );
        await page.addInitScript(
          ({ customTheme, key }) => {
            localStorage.setItem(key, JSON.stringify({ customTheme, theme: "custom" }));
          },
          { customTheme: importedTheme, key: settingsKey },
        );
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(
              { colorVision: "protanopia", theme: "custom", themeMode: "dark" },
              "color-vision-custom-1",
            ),
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
        expect(response?.status()).toBe(200);
        await waitForControlUiSettingsTakeover(page);
        await gateway.waitForRequest("config.get");

        const row = settingsRow(page, "Color vision");
        const select = row.locator("select");
        await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("custom");
        await expect.poll(() => page.locator("html").getAttribute("data-color-vision")).toBeNull();
        await expect.poll(() => select.inputValue()).toBe("protanopia");
        await expect.poll(() => select.isDisabled()).toBe(true);
        await expect
          .poll(() => row.textContent())
          .toContain("Use a built-in theme to apply color-vision palettes.");
        await expect
          .poll(() =>
            page.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue("--ok").trim(),
            ),
          )
          .toBe("#22c55e");
      },
    );
  });

  it("resets an explicit Standard preference without changing palettes first", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(
              { colorVision: "standard", theme: "claw", themeMode: "dark" },
              "color-vision-reset-1",
            ),
            "config.patch": { ok: true },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
        expect(response?.status()).toBe(200);
        await waitForControlUiSettingsTakeover(page);
        await gateway.waitForRequest("config.get");

        const row = settingsRow(page, "Color vision");
        const reset = row.getByRole("button", { name: "Reset to default" });
        await expect.poll(() => row.locator("select").inputValue()).toBe("standard");
        await expect.poll(() => reset.count()).toBe(1);

        const patchCount = (await gateway.getRequests("config.patch")).length;
        const configGetCount = (await gateway.getRequests("config.get")).length;
        await gateway.setMethodResponse(
          "config.get",
          configResponse({ theme: "claw", themeMode: "dark" }, "color-vision-reset-2"),
        );
        await reset.click();
        await waitForRequestCount(gateway, "config.patch", patchCount + 1);
        const patches = await gateway.getRequests("config.patch");
        expect(patchedPrefs(patches[patchCount] as MockGatewayRequest)).toEqual({
          colorVision: null,
        });
        await waitForRequestCount(gateway, "config.get", configGetCount + 1);
        await expect.poll(() => reset.count()).toBe(0);
      },
    );
  });

  it("updates an already-rendered context warning when the palette changes", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const standardPrefs = { colorVision: "standard", theme: "claw", themeMode: "dark" };
        const gateway = await installMockGateway(page, {
          historyMessages: [],
          methodResponses: {
            "config.get": configResponse(standardPrefs, "color-vision-live-1"),
            "config.patch": { ok: true },
            "sessions.list": chatSessionListResponse([
              {
                key: SESSION_KEY,
                kind: "direct",
                label: "Color vision",
                updatedAt: 1,
                contextTokens: 200_000,
                totalTokens: 190_000,
                totalTokensFresh: true,
              },
            ]),
          },
        });

        const response = await page.goto(controlUiSessionUrl(suite.server.baseUrl, SESSION_KEY));
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("sessions.list");
        const warning = page.locator(".context-usage");
        await warning.locator(".context-ring--warning").waitFor();
        const standardColor = await warning.evaluate((element) => getComputedStyle(element).color);
        expect(standardColor).toBe("rgb(248, 113, 113)");

        await navigateToAppearance(page);
        const configGetCount = (await gateway.getRequests("config.get")).length;
        await gateway.setMethodResponse(
          "config.get",
          configResponse({ ...standardPrefs, colorVision: "protanopia" }, "color-vision-live-2"),
        );
        await settingsRow(page, "Color vision").locator("select").selectOption("protanopia");
        await waitForRequestCount(gateway, "config.get", configGetCount + 1);
        await expect
          .poll(() => page.locator("html").getAttribute("data-color-vision"))
          .toBe("protanopia");

        await navigateToControlUiSession(page, SESSION_KEY);
        await warning.locator(".context-ring--warning").waitFor();
        const protanopiaColor = await warning.evaluate(
          (element) => getComputedStyle(element).color,
        );
        expect(protanopiaColor).toBe("rgb(239, 138, 98)");
        expect(protanopiaColor).not.toBe(standardColor);
      },
    );
  });
});
