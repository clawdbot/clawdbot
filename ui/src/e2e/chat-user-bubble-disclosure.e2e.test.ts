import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps seven short lines fully visible", async () => {
    const text = [
      "please re-review these:",
      "#127818",
      "#127826",
      "#127844",
      "#127881",
      "",
      "rerun the same session we had for these",
    ].join("\n");
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const bubble = page.locator(".chat-group.user .chat-bubble");
      await bubble.waitFor({ state: "visible", timeout: 10_000 });
      const proofDir = path.join(
        process.cwd(),
        ".artifacts",
        "control-ui-e2e",
        "user-bubble-clamp",
      );
      if (captureUiProofEnabled) {
        await mkdir(proofDir, { recursive: true });
        await bubble.screenshot({ path: path.join(proofDir, "short-message.png") });
      }

      expect(await bubble.getByRole("button", { name: "Show more" }).count()).toBe(0);
      expect(await bubble.locator(".chat-message-disclosure").count()).toBe(0);
      const bubbleText = await bubble.textContent();
      for (const line of text.split("\n").filter(Boolean)) {
        expect(bubbleText).toContain(line);
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("clamps a 1300-character prompt to five lines and toggles the complete prompt", async () => {
    const text =
      `${"This long prompt stays mounted while its preview is clamped. ".repeat(22)}Final prompt tail.`.slice(
        0,
        1_300,
      );
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
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
      expect(await content.textContent()).toContain(text.slice(-18));
      const collapsedHeight = await content.evaluate((element) => element.clientHeight);
      expect(await content.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
        true,
      );
      const proofDir = path.join(
        process.cwd(),
        ".artifacts",
        "control-ui-e2e",
        "user-bubble-clamp",
      );
      if (captureUiProofEnabled) {
        await mkdir(proofDir, { recursive: true });
        await bubble.screenshot({ path: path.join(proofDir, "long-message-collapsed.png") });
      }

      await toggle.click();
      const collapse = bubble.getByRole("button", { name: "Show less" });
      expect(await collapse.getAttribute("aria-expanded")).toBe("true");
      expect(await content.evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe(
        "none",
      );
      expect(await content.evaluate((element) => element.clientHeight)).toBeGreaterThan(
        collapsedHeight,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
