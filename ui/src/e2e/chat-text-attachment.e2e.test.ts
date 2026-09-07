import path from "node:path";
import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const text =
  "Release checklist\n\nRead the attached notes without leaving the conversation.\n\n  Keep indentation and line breaks.\n  Unicode text: café 🦞\n\n<script>Displayed as text, never executed.</script>\n";

suite.define(() => {
  it.each([1280, 390])(
    "reads a pasted text file in the side panel at %ipx and keeps download available",
    async (width) => {
      const context = await suite.newBrowserContext({
        ...createControlUiE2eContextOptions(),
        viewport: { width, height: 900 },
      });
      const page = await context.newPage();
      const mediaUrl = "/__openclaw__/assistant-media?source=notes.txt&mediaTicket=text-preview";
      let reads = 0;
      let downloads = 0;
      page.on("download", () => {
        downloads += 1;
      });
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        reads += 1;
        expect(route.request().headers().authorization).toBeUndefined();
        await route.fulfill({
          contentType: "text/plain; charset=utf-8",
          headers: { "Content-Disposition": 'attachment; filename="pasted-notes.txt"' },
          body: text,
        });
      });
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Please review these notes." },
              {
                type: "attachment",
                attachment: {
                  kind: "document",
                  label: "pasted-notes.txt",
                  mimeType: "text/plain",
                  url: mediaUrl,
                },
              },
            ],
            timestamp: Date.now(),
          },
        ],
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const card = page
          .locator(".chat-assistant-attachment-card--compact")
          .filter({ hasText: "pasted-notes.txt" });
        await card
          .getByRole("button", { name: "Open pasted-notes.txt in the side panel", exact: true })
          .click();
        const panel = page.locator("openclaw-chat-detail-panel:visible");
        await panel.locator("a[download]").waitFor();
        await page.screenshot({ path: path.join(suite.artifactDir, `text-preview-${width}.png`) });
        await panel.locator("pre").waitFor();
        expect(await panel.locator("pre").textContent()).toBe(text);
        expect(await panel.locator("script, iframe").count()).toBe(0);
        expect(downloads).toBe(0);
        expect(reads).toBe(1);
        expect(
          await panel
            .locator("pre")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: path.join(suite.artifactDir, `text-preview-${width}-readable.png`),
        });
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          panel.locator("a[download]").click(),
        ]);
        expect(download.suggestedFilename()).toBe("pasted-notes.txt");
        expect(await download.failure()).toBeNull();
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
