// Control UI E2E proves model-aware /think completion in the rendered composer.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI thinking argument completion",
});

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

suite.define(() => {
  it.each(VIEWPORTS)(
    "opens the active model's thinking levels above the composer ($name)",
    async (viewport) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const browserErrors: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error") {
            browserErrors.push(message.text());
          }
        });
        page.on("pageerror", (error) => browserErrors.push(error.message));

        const gateway = await installMockGateway(page, {
          models: [
            {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              provider: "openai",
              thinkingLevels: [
                { id: "off", label: "off" },
                { id: "minimal", label: "minimal" },
                { id: "low", label: "low" },
                { id: "medium", label: "medium" },
                { id: "high", label: "high" },
                { id: "xhigh", label: "xhigh" },
                { id: "max", label: "max" },
                { id: "ultra", label: "ultra" },
              ],
            },
          ],
          methodResponses: {
            "sessions.list": {
              count: 1,
              defaults: {
                contextTokens: 200_000,
                model: "gpt-5.6-sol",
                modelProvider: "openai",
              },
              path: "",
              sessions: [
                {
                  key: "main",
                  kind: "direct",
                  model: "gpt-5.6-sol",
                  modelProvider: "openai",
                  updatedAt: Date.now(),
                },
              ],
              ts: Date.now(),
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await expect.poll(() => composer.isEnabled()).toBe(true);

        await composer.fill("/think");
        await composer.press("Tab");

        const picker = page.locator(".slash-menu[role='listbox']");
        await picker.waitFor({ state: "visible" });
        await expect.poll(() => composer.inputValue()).toBe("/think ");
        await expect
          .poll(() => picker.getByRole("option").locator(".slash-menu-name").allTextContents())
          .toEqual(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

        const [pickerBox, inputBox] = await Promise.all([
          picker.boundingBox(),
          page.locator(".agent-chat__input").boundingBox(),
        ]);
        expect(pickerBox).not.toBeNull();
        expect(inputBox).not.toBeNull();
        expect((pickerBox?.y ?? 0) + (pickerBox?.height ?? 0)).toBeLessThanOrEqual(
          (inputBox?.y ?? 0) + 1,
        );
        expect(pickerBox?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((pickerBox?.x ?? 0) + (pickerBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
        expect(pickerBox?.y ?? -1).toBeGreaterThanOrEqual(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        );
        expect(browserErrors).toEqual([]);

        await composer.press("ArrowUp");
        await composer.press("Tab");
        await expect.poll(() => composer.inputValue()).toBe("/think ultra");
        await composer.press("Enter");
        const patchRequest = await gateway.waitForRequest("sessions.patch");
        expect(patchRequest.params).toMatchObject({
          key: "main",
          thinkingLevel: "ultra",
        });

        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        if (artifactDir) {
          await fs.mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            path: path.join(artifactDir, `think-arguments-${viewport.name}.png`),
            fullPage: true,
          });
        }
      });
    },
  );
});
