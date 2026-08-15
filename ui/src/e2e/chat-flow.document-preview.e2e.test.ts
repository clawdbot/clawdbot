import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("previews a text document from chat history with a download action", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const previewText = "A pasted note\nwith a second line for the preview.";
    const requestedUrls: string[] = [];
    await page.route("**/__openclaw__/pasted-text.txt", async (route) => {
      requestedUrls.push(route.request().url());
      await route.fulfill({ body: previewText, contentType: "text/plain" });
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
      await card.locator(".chat-assistant-attachment-card__preview-text").waitFor({
        state: "visible",
        timeout: 10_000,
      });
      expect(
        await card.locator(".chat-assistant-attachment-card__preview-text").textContent(),
      ).toBe(previewText);
      const download = card.locator(".chat-assistant-attachment-card__download");
      expect(await download.getAttribute("download")).toBe("pasted-text-1723000000000.txt");
      expect(await download.getAttribute("href")).toBe("/__openclaw__/pasted-text.txt");
      expect(requestedUrls).toHaveLength(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
