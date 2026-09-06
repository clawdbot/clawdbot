import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI composer accessory focus",
});

suite.define(() => {
  it("routes focus by composer accessory purpose", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        models: [{ id: "gpt-5.6", name: "GPT-5.6", provider: "openai" }],
        methodResponses: {
          "sessions.list": {
            count: 1,
            defaults: {
              contextTokens: 200_000,
              model: "gpt-5.6",
              modelProvider: "openai",
              thinkingDefault: "medium",
              thinkingLevels: [
                { id: "off", label: "off" },
                { id: "low", label: "low" },
                { id: "medium", label: "medium" },
                { id: "high", label: "high" },
              ],
            },
            path: "",
            sessions: [
              {
                contextTokens: 200_000,
                key: "main",
                kind: "direct",
                model: "gpt-5.6",
                modelProvider: "openai",
                status: "done",
                totalTokens: 42_000,
                totalTokensFresh: true,
                updatedAt: Date.now(),
              },
            ],
            ts: Date.now(),
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__input");
      const textarea = composer.locator("textarea");
      await composer.waitFor({ state: "visible" });
      await page.evaluate(() => {
        const outside = document.createElement("button");
        outside.id = "composer-accessory-focus-sentinel";
        outside.textContent = "Outside focus sentinel";
        document.body.prepend(outside);
      });
      const outside = page.locator("#composer-accessory-focus-sentinel");

      for (const triggerSelector of [
        ".context-usage > details > summary",
        ".chat-controls__effort-picker > summary",
      ]) {
        const trigger = composer.locator(triggerSelector);
        await trigger.waitFor({ state: "visible" });

        await outside.focus();
        await trigger.click();
        expect(await outside.evaluate((element) => document.activeElement === element)).toBe(true);
        const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        const artifactDir = artifactRoot
          ? createControlUiE2eArtifactDir("chat-composer-accessory-focus", artifactRoot)
          : undefined;
        if (artifactDir && triggerSelector.startsWith(".context-usage")) {
          const composerBox = await composer.boundingBox();
          const popoverBox = await composer.locator(".context-usage__popover").boundingBox();
          if (!composerBox || !popoverBox) {
            throw new Error("expected composer and context popover bounds for focus proof");
          }
          const y = Math.max(0, popoverBox.y - 16);
          const clip = {
            x: Math.max(0, composerBox.x - 16),
            y,
            width: composerBox.width + 32,
            height: composerBox.y + composerBox.height + 16 - y,
          };
          await page.screenshot({
            path: path.join(artifactDir, "after-context-click-no-focus.png"),
            clip,
          });
          await trigger.focus();
          await page.screenshot({
            path: path.join(artifactDir, "before-context-trigger-focused.png"),
            clip,
          });
          await outside.focus();
        }
        await trigger.click();

        await textarea.focus();
        await trigger.click();
        expect(await textarea.evaluate((element) => document.activeElement === element)).toBe(true);
        await trigger.click();

        await trigger.focus();
        await trigger.press("Enter");
        expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);
        expect(
          await trigger.evaluate(
            (element) => element.closest<HTMLDetailsElement>("details")?.open ?? false,
          ),
        ).toBe(true);
        await trigger.press("Enter");
      }

      const modelTrigger = composer.locator(".chat-controls__model-picker > summary");
      await outside.focus();
      await modelTrigger.click();
      expect(await modelTrigger.evaluate((element) => document.activeElement === element)).toBe(
        true,
      );
      expect(
        await page
          .locator(".chat-controls__model-search")
          .evaluate((element) => document.activeElement === element),
      ).toBe(false);
      await page.keyboard.press("Escape");

      await outside.focus();
      const attachTrigger = composer.locator(".agent-chat__input-btn--attach");
      await attachTrigger.click();
      await expect
        .poll(() => attachTrigger.evaluate((element) => document.activeElement === element))
        .toBe(true);
      expect(
        await page
          .locator(".agent-chat__attach-menu-option")
          .first()
          .evaluate((element) => document.activeElement === element),
      ).toBe(false);
      await page.keyboard.press("Escape");
    });
  });
});
