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
  it.each([
    {
      name: "explicit lines",
      text: Array.from({ length: 8 }, (_, index) => `Prompt line ${index + 1}`).join("\n"),
      viewport: { height: 900, width: 1280 },
    },
    {
      name: "soft-wrapped text",
      text: `${"This prompt remains mounted while its narrow visual preview is clamped. ".repeat(7)}Final prompt tail.`,
      viewport: { height: 844, width: 390 },
    },
  ] as const)(
    "clamps $name to five lines and toggles the complete prompt",
    async ({ name, text, viewport }) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
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
        expect(
          await content.evaluate((element) => element.scrollHeight > element.clientHeight),
        ).toBe(true);
        const proofDir = path.join(
          process.cwd(),
          ".artifacts",
          "control-ui-e2e",
          "user-bubble-disclosure",
        );
        const proofName = name.replaceAll(" ", "-");
        if (captureUiProofEnabled) {
          await mkdir(proofDir, { recursive: true });
          await bubble.screenshot({ path: path.join(proofDir, `${proofName}-collapsed.png`) });
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
        if (captureUiProofEnabled) {
          await bubble.screenshot({ path: path.join(proofDir, `${proofName}-expanded.png`) });
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
