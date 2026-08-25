import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("renders a text document as a compact card without fetching it", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const requestedUrls: string[] = [];
    await page.route("**/__openclaw__/pasted-text.txt", async (route) => {
      requestedUrls.push(route.request().url());
      await route.fulfill({ body: "not requested", contentType: "text/plain" });
    });
    await installMockGateway(page, {
      historyMessages: [
        {
          id: "user-pasted-text-preview",
          role: "user",
          content: [
            { type: "text", text: "Please review this pasted note." },
            {
              type: "attachment",
              attachment: {
                kind: "document",
                label: "pasted-text-1723000000000.txt",
                mimeType: "text/plain",
                sizeBytes: 48,
                url: "/__openclaw__/pasted-text.txt",
              },
            },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const card = page.locator(".chat-assistant-attachment-card--document");
      expect(await card.getAttribute("class")).toContain("chat-assistant-attachment-card--compact");
      expect(
        await card.locator(".chat-assistant-attachment-card__expand").textContent(),
      ).toBe("Open");
      expect(await card.locator(".chat-assistant-attachment-card__table").count()).toBe(0);
      expect(await card.locator("iframe").count()).toBe(0);
      const download = card.locator(".chat-assistant-attachment-card__download");
      expect(await download.getAttribute("download")).toBe("pasted-text-1723000000000.txt");
      expect(await download.getAttribute("href")).toBe("/__openclaw__/pasted-text.txt");
      expect(requestedUrls).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
