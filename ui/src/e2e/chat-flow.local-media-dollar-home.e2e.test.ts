import path from "node:path";
import { expect, it } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    {
      name: "tilde local media when the preview root home contains a literal $ pattern",
      source: "~/media/report-voice.mp3",
      roots: ["/home/us$&r/media"],
    },
    {
      name: "POSIX dot-segment local media",
      source: "/workspace/project/../media/report-voice.mp3",
      roots: ["/workspace/media"],
    },
    {
      name: "Windows dot-segment local media",
      source: "C:\\workspace\\project\\..\\media\\report-voice.mp3",
      roots: ["C:\\workspace\\media"],
    },
  ])("allows $name", async ({ source, roots }) => {
    const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactDirParent
      ? createControlUiE2eArtifactDir("chat-flow.local-media-dollar-home", artifactDirParent)
      : undefined;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const requestedMediaUrls: URL[] = [];

    await page.route("**/__openclaw__/assistant-media?**", async (route) => {
      const url = new URL(route.request().url());
      requestedMediaUrls.push(url);
      if (url.searchParams.get("meta") === "1") {
        expect(route.request().headers().authorization).toBe("Bearer e2e-device-token");
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
        body: createPlaybackMediaFixture("mp3"),
      });
    });

    await installMockGateway(page, {
      localMediaPreviewRoots: roots,
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
      const attachment = page.locator("openclaw-chat-audio-player");
      await attachment.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => requestedMediaUrls.length, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(2);
      expect(requestedMediaUrls[0]?.searchParams.get("meta")).toBe("1");
      expect(requestedMediaUrls[0]?.searchParams.get("source")).toBe(source);
      expect(
        requestedMediaUrls
          .slice(1)
          .some((url) => url.searchParams.get("mediaTicket") === "ticket-dollar-home"),
      ).toBe(true);
      const downloadHref = await attachment
        .locator(".chat-assistant-attachment-card__download")
        .getAttribute("href");
      expect(downloadHref).toBeTruthy();
      const downloadUrl = new URL(downloadHref ?? "", suite.server.baseUrl);
      expect(downloadUrl.searchParams.get("mediaTicket")).toBe("ticket-dollar-home");
      expect(downloadUrl.searchParams.get("source")).toBe(source);
      await expect
        .poll(() =>
          attachment
            .locator("audio")
            .evaluate((element) => (element as HTMLMediaElement).readyState),
        )
        .toBeGreaterThanOrEqual(1);
      expect(await page.getByText("Outside allowed folders").count()).toBe(0);
      if (artifactDir) {
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
