import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("clamps long user bubbles to five lines and toggles the complete prompt", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const lines = Array.from({ length: 8 }, (_, index) => `Prompt line ${index + 1}`);
    await installMockGateway(page, {
      historyMessages: [
        { role: "user", content: [{ type: "text", text: lines.join("\n") }], timestamp: 1 },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const bubble = page.locator(".chat-group.user .chat-bubble");
      await bubble.waitFor({ state: "visible", timeout: 10_000 });
      const content = bubble.locator(".chat-message-disclosure__content");
      const toggle = bubble.getByRole("button", { name: "Show more" });

      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(await content.evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe(
        "5",
      );
      expect(await content.textContent()).toContain(lines[7]);

      await toggle.click();
      const collapse = bubble.getByRole("button", { name: "Show less" });
      expect(await collapse.getAttribute("aria-expanded")).toBe("true");
      expect(await content.evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe(
        "none",
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
