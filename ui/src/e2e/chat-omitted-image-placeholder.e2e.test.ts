import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Omitted history image placeholder" });

suite.define(() => {
  it("keeps sanitized historical images visible without fake recovery actions", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: [{ type: "image", omitted: true, bytes: 12 * 1024 }],
            timestamp: 1,
          },
        ],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const placeholder = page.locator(".chat-assistant-attachment-card", {
        hasText: "Omitted from history",
      });
      await placeholder.waitFor({ state: "visible" });

      expect(await placeholder.textContent()).toContain("Image");
      expect(await placeholder.textContent()).toContain("History");
      expect(await placeholder.textContent()).toContain("12 KB");
      expect(await placeholder.locator("a, button, img, audio, video").count()).toBe(0);
    });
  });
});
