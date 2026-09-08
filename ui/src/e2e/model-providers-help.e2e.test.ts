// Control UI tests cover the Models settings help affordances against a mocked Gateway.
import path from "node:path";
import { chromium, type Browser, type Locator } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const NOW = Date.now();
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
let utilityHelpArtifactDir: string;
beforeEach(() => {
  if (recordVisuals) {
    utilityHelpArtifactDir = path.join(
      createControlUiE2eArtifactDir("model-providers"),
      "utility-model-help",
    );
  }
});
const redactedConfigValue = "[redacted]";

let browser: Browser;
let server: ControlUiE2eServer;

function providerConfig(value: string): { apiKey: string } {
  return Object.fromEntries([["apiKey", value]]) as { apiKey: string };
}

function modelPickerValue(locator: Locator) {
  return locator.evaluate((element) => String((element as HTMLElement & { value?: string }).value));
}

describeControlUiE2e("Control UI Models help mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("explains the utility model with accessible pointer, keyboard, and narrow-layout behavior", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        colorScheme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const config = {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        models: { providers: { openai: providerConfig(redactedConfigValue) } },
      };
      await installMockGateway(page, {
        models: [
          { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
          {
            id: "gpt-5.6-luna",
            name: "GPT-5.6 Luna",
            provider: "openai",
            available: true,
          },
        ],
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            hash: `utility-help-${colorScheme}`,
            issues: [],
            raw: JSON.stringify(config),
            valid: true,
          },
          "models.authStatus": { ts: NOW, providers: [] },
          "usage.status": { updatedAt: NOW, providers: [] },
          "sessions.usage": { aggregates: { byProvider: [] } },
        },
      });

      try {
        await page.goto(`${server.baseUrl}settings/model-providers`);
        await page.locator(".page-title", { hasText: "Models" }).first().waitFor();
        const defaults = page.locator(".model-providers__defaults");
        const utilityField = defaults
          .locator(".settings-row")
          .filter({ has: page.locator("#model-providers-utility-help") });
        const utilityLabel = utilityField.locator(".model-providers__label-with-help");
        await utilityField.waitFor();
        expect(await utilityLabel.evaluate((node) => getComputedStyle(node).columnGap)).toBe("8px");
        await expect
          .poll(() => modelPickerValue(utilityField.locator("wa-select")))
          .toBe("__openclaw_automatic_utility__");
        await expect
          .poll(() =>
            utilityField
              .locator('wa-option[value="__openclaw_automatic_utility__"]')
              .textContent()
              .then((value) => value?.trim()),
          )
          .toBe("Auto");

        if (recordVisuals) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(utilityHelpArtifactDir, `${colorScheme}-default-full.png`),
          });
          await utilityField.screenshot({
            animations: "disabled",
            path: path.join(utilityHelpArtifactDir, `${colorScheme}-default-crop.png`),
          });
        }

        const helpButton = defaults.getByRole("button", { name: "About the utility model" });
        await expect.poll(() => helpButton.count()).toBe(1);
        await expect.poll(() => helpButton.locator("svg").count()).toBe(1);
        expect(await helpButton.evaluate((node) => getComputedStyle(node).borderTopWidth)).toBe(
          "0px",
        );
        const tooltip = helpButton.locator("..");
        const tooltipPopup = tooltip.locator("wa-tooltip");
        const tooltipBody = tooltip.locator(".tooltip-rich-content");
        const tooltipIsOpen = () =>
          tooltipPopup.evaluate((node) => Boolean(Reflect.get(node, "open")));

        const defaultColor = await helpButton.evaluate((node) => getComputedStyle(node).color);
        await helpButton.hover();
        await expect
          .poll(() => helpButton.evaluate((node) => getComputedStyle(node).color))
          .not.toBe(defaultColor);
        const helpHoverColor = await helpButton.evaluate((node) => getComputedStyle(node).color);
        await expect.poll(tooltipIsOpen).toBe(true);
        await expect.poll(() => tooltip.textContent()).toContain("short background tasks");
        const helpButtonBox = await helpButton.boundingBox();
        expect(helpButtonBox).not.toBeNull();
        expect(helpButtonBox?.width).toBeLessThanOrEqual(16);
        expect(helpButtonBox?.height).toBeLessThanOrEqual(16);
        if (recordVisuals) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(utilityHelpArtifactDir, `${colorScheme}-hover-tooltip-full.png`),
          });
        }

        await helpButton.click();
        await expect.poll(tooltipIsOpen).toBe(true);
        await expect.poll(() => tooltip.textContent()).toContain("short background tasks");
        await expect.poll(() => tooltip.textContent()).toContain("primary model provider");
        if (recordVisuals) {
          const labelBox = await utilityLabel.boundingBox();
          const tooltipBox = await tooltipBody.boundingBox();
          if (!labelBox || !tooltipBox) {
            throw new Error("expected utility label and tooltip bounds");
          }
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(utilityHelpArtifactDir, `${colorScheme}-open-full.png`),
          });
          const x = Math.min(labelBox.x, tooltipBox.x);
          const y = Math.max(0, tooltipBox.y);
          const right = Math.max(labelBox.x + labelBox.width, tooltipBox.x + tooltipBox.width);
          const bottom = Math.max(labelBox.y + labelBox.height, tooltipBox.y + tooltipBox.height);
          await page.screenshot({
            animations: "disabled",
            clip: {
              x,
              y,
              width: right - x,
              height: bottom - y,
            },
            path: path.join(utilityHelpArtifactDir, `${colorScheme}-open-crop.png`),
          });
        }

        await page.locator(".page-title", { hasText: "Models" }).first().click();
        await expect.poll(tooltipIsOpen).toBe(false);

        await helpButton.focus();
        await expect
          .poll(() => helpButton.evaluate((node) => node === document.activeElement))
          .toBe(true);
        await page.keyboard.press("Enter");
        await expect.poll(tooltipIsOpen).toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(tooltipIsOpen).toBe(false);
        expect(new URL(page.url()).pathname).toBe("/settings/model-providers");
        await expect
          .poll(() => helpButton.evaluate((node) => node === document.activeElement))
          .toBe(true);

        for (const help of [
          {
            button: "About thinking defaults",
            text: "closest option supported by the selected model",
          },
          {
            button: "About fast mode defaults",
            text: "Auto starts in fast mode",
          },
        ]) {
          const behaviorButton = defaults.getByRole("button", { name: help.button });
          const behaviorTooltip = behaviorButton.locator("..");
          await behaviorButton.hover();
          await expect
            .poll(() =>
              behaviorTooltip
                .locator("wa-tooltip")
                .evaluate((node) => Boolean(Reflect.get(node, "open"))),
            )
            .toBe(true);
          await expect.poll(() => behaviorTooltip.textContent()).toContain(help.text);
          await page.locator(".page-title", { hasText: "Models" }).first().click();
        }

        for (const behavior of ["Thinking", "Fast Mode"]) {
          const behaviorRow = defaults
            .locator(".settings-row")
            .filter({ has: page.locator(".settings-row__title", { hasText: behavior }) });
          const group = behaviorRow.locator("wa-radio-group");
          const defaultHelpButton = group
            .locator('wa-radio[value=""]')
            .locator(".model-providers__segment-info");
          const defaultTooltip = defaultHelpButton.locator("..");
          await defaultHelpButton.hover();
          expect(await defaultHelpButton.evaluate((node) => getComputedStyle(node).color)).toBe(
            helpHoverColor,
          );
          await expect
            .poll(() =>
              defaultTooltip
                .locator("wa-tooltip")
                .evaluate((node) => Boolean(Reflect.get(node, "open"))),
            )
            .toBe(true);
          await defaultHelpButton.click();
          await expect.poll(() => group.evaluate((node) => Reflect.get(node, "value"))).toBe("");
          await expect
            .poll(() => defaultTooltip.locator("wa-tooltip").textContent())
            .toContain("selected model's");
          await page.locator(".page-title", { hasText: "Models" }).first().click();
        }

        await page.setViewportSize({ height: 844, width: 390 });
        await utilityField.scrollIntoViewIfNeeded();
        await helpButton.click();
        await expect.poll(tooltipIsOpen).toBe(true);
        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          )
          .toBe(true);
        const mobileTooltipBox = await tooltipBody.boundingBox();
        if (!mobileTooltipBox) {
          throw new Error("expected utility help tooltip bounds on mobile");
        }
        expect(mobileTooltipBox.x).toBeGreaterThanOrEqual(0);
        expect(mobileTooltipBox.x + mobileTooltipBox.width).toBeLessThanOrEqual(390);

        if (recordVisuals) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(utilityHelpArtifactDir, `${colorScheme}-mobile-open.png`),
          });
        }
      } finally {
        await context.close();
      }
    }
  });
});
