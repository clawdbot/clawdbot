import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("allows tilde local media previews when the preview root home contains a literal $ pattern", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const source = "~/media/report-voice.mp3";
    const requestedMediaUrls: URL[] = [];

    await page.route("**/__openclaw__/assistant-media?**", async (route) => {
      const url = new URL(route.request().url());
      requestedMediaUrls.push(url);
      if (url.searchParams.get("meta") === "1") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            mediaTicket: "ticket-dollar-home",
            mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: "audio/mpeg",
        body: Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000"),
      });
    });

    await installMockGateway(page, {
      localMediaPreviewRoots: ["/home/us$&r/media"],
      historyMessages: [
        {
          id: "assistant-dollar-home-audio",
          role: "assistant",
          content: [
            { type: "text", text: "Your recording" },
            {
              type: "attachment",
              attachment: {
                kind: "audio",
                label: "report-voice.mp3",
                mimeType: "audio/mpeg",
                url: source,
              },
            },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const audio = page.locator(".chat-assistant-attachment-card audio");
      await audio.waitFor({ state: "attached", timeout: 10_000 });
      await expect.poll(() => requestedMediaUrls.length, { timeout: 10_000 }).toBe(2);
      expect(requestedMediaUrls[0]?.searchParams.get("meta")).toBe("1");
      expect(requestedMediaUrls[0]?.searchParams.get("source")).toBe(source);
      expect(requestedMediaUrls[1]?.searchParams.get("mediaTicket")).toBe("ticket-dollar-home");
      expect(requestedMediaUrls[1]?.searchParams.get("source")).toBe(source);
      expect(await page.getByText("Outside allowed folders").count()).toBe(0);
      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "local-media-dollar-home-allowed.png"),
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
