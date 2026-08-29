import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette first open" });

suite.define(() => {
  it.each([
    { height: 900, width: 1280 },
    { height: 844, width: 390 },
  ])("shows the palette shell while its module loads at $width px", async (viewport) => {
    await suite.withPage({ viewport }, async ({ page }) => {
      await installMockGateway(page);
      const paletteModule = await holdModuleResponse(
        page,
        /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
      );
      await page.goto(`${suite.server.baseUrl}chat`);

      try {
        // Navigation can finish before the shell installs its shortcut handler.
        await page.getByRole("button", { name: "Open command palette" }).waitFor();
        await page.keyboard.press("Control+K");

        const shell = page.locator(".cmd-palette");
        await shell.waitFor({ state: "visible" });
        await paletteModule.request;
        expect(await shell.getAttribute("aria-label")).toBe("Loading…");
        expect(await page.locator(".lazy-view-state--loading").count()).toBe(0);

        paletteModule.release();
        await page.locator(".cmd-palette__input:not([disabled])").waitFor({ state: "visible" });
      } finally {
        paletteModule.release();
      }
    });
  });
});
