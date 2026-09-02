import { expect, it } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Attachment file styles" });

suite.define(() => {
  it("preserves large, preview, and unavailable file visuals in both themes", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await page.route("**/style-proof.mp3", (route) =>
        route.fulfill({ contentType: "audio/mpeg", body: createPlaybackMediaFixture("mp3") }),
      );
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "attachment",
                attachment: {
                  kind: "document",
                  label: "report.pdf",
                  mimeType: "application/pdf",
                  url: new URL("report.pdf", suite.server.baseUrl).href,
                },
              },
              {
                type: "attachment",
                attachment: {
                  kind: "audio",
                  label: "style-proof.mp3",
                  mimeType: "audio/mpeg",
                  url: new URL("style-proof.mp3", suite.server.baseUrl).href,
                },
              },
              {
                type: "attachment_error",
                attachment: {
                  code: "file-not-found",
                  kind: "document",
                  label: "missing.pdf",
                },
              },
            ],
            timestamp: 1,
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const compact = page.locator('.chat-attachment-file-icon[data-mode="preview-with-favicon"]');
      await compact.waitFor({ state: "visible" });
      const documentCard = page.locator(".chat-assistant-attachment-card--compact", {
        hasText: "report.pdf",
      });
      const unavailable = page.locator(".chat-assistant-attachment-card--definitive", {
        hasText: "missing.pdf",
      });
      await unavailable.waitFor({ state: "visible" });

      for (const theme of ["dark", "light"]) {
        await page.evaluate((mode) => {
          document.documentElement.dataset.themeMode = mode;
        }, theme);
        const large = documentCard.locator(".chat-attachment-file-icon");
        const largeStyle = await large.evaluate((icon) => {
          const style = getComputedStyle(icon);
          const overlay = icon.querySelector(".chat-attachment-file-icon__overlay")!;
          const glyph = getComputedStyle(overlay);
          return {
            width: style.width,
            height: style.height,
            background: style.backgroundImage,
            glyphWidth: glyph.width,
            glyphHeight: glyph.height,
            mask: glyph.maskImage,
            webkitMask: glyph.webkitMaskImage,
          };
        });
        expect(largeStyle).toMatchObject({
          width: "44px",
          height: "44px",
          glyphWidth: "14px",
          glyphHeight: "14px",
        });
        expect(largeStyle.background).toContain(`large/shell-${theme}.svg`);
        expect(largeStyle.mask).toContain("overlays/pdf.svg");
        expect(largeStyle.webkitMask).toBe(largeStyle.mask);
        const previewStyle = await compact.evaluate((icon) => {
          const style = getComputedStyle(icon);
          return { width: style.width, height: style.height, background: style.backgroundImage };
        });
        expect(previewStyle).toMatchObject({ width: "20px", height: "20px" });
        expect(previewStyle.background).toContain(`compact/${theme}/mp3.svg`);
        expect(
          await documentCard.evaluate((card) => {
            const style = getComputedStyle(card);
            return [style.display, style.padding];
          }),
        ).toEqual(["block", "0px"]);
        const failedStyle = await unavailable.evaluate((card) => {
          const icon = card.querySelector(".chat-attachment-file-icon")!;
          const metadata = card.querySelector(".chat-assistant-attachment-card__status-meta")!;
          const title = card.querySelector(".chat-assistant-attachment-card__title")!;
          return {
            color: getComputedStyle(card).color,
            danger: getComputedStyle(card).getPropertyValue("--danger").trim(),
            iconColor: getComputedStyle(icon).color,
            statusColor: getComputedStyle(metadata).color,
            opacity: getComputedStyle(icon).opacity,
            decoration: getComputedStyle(title).textDecorationLine,
            thickness: getComputedStyle(title).textDecorationThickness,
            display: getComputedStyle(card).display,
            padding: getComputedStyle(card).padding,
          };
        });
        expect(failedStyle).toMatchObject({
          iconColor: failedStyle.color,
          statusColor: failedStyle.color,
          opacity: "0.42",
          decoration: "line-through",
          thickness: "1px",
          display: "block",
          padding: "0px",
        });
        expect(failedStyle.color).toBe(
          await page.evaluate((color) => {
            const sample = document.createElement("span");
            sample.style.color = color;
            document.body.append(sample);
            const resolved = getComputedStyle(sample).color;
            sample.remove();
            return resolved;
          }, failedStyle.danger),
        );
      }
    });
  });
});
