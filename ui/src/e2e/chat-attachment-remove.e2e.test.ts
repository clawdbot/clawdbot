import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Attachment removal touch targets" });
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

suite.define(() => {
  it.each([
    { route: "chat", kind: "image" },
    { route: "chat", kind: "file" },
    { route: "new", kind: "image" },
    { route: "new", kind: "file" },
  ])("removes a $kind from the unclipped target in $route", async ({ route, kind }) => {
    await suite.withPage(
      { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}${route}`);
        const composer = page.locator(
          route === "chat" ? ".agent-chat__input" : ".new-session-page__composer",
        );
        await composer.waitFor();
        const file = {
          name: kind === "image" ? "demo.png" : "demo.txt",
          mimeType: kind === "image" ? "image/png" : "text/plain",
          buffer: kind === "image" ? image : Buffer.from("Synthetic attachment"),
        };
        await composer
          .locator(".agent-chat__file-input")
          .setInputFiles(kind === "image" ? [file, { ...file, name: "neighbor.png" }] : file);
        const thumbnails = composer.locator(".chat-attachment-thumb");
        const attachment =
          kind === "image"
            ? thumbnails.filter({ has: page.getByAltText("demo.png", { exact: true }) })
            : thumbnails;
        await attachment.waitFor();
        const previewUrl =
          kind === "image" ? await attachment.locator("img").getAttribute("src") : null;
        if (previewUrl) {
          expect(await page.evaluate(async (url) => (await fetch(url)).ok, previewUrl)).toBe(true);
        }
        const bounds = await attachment.boundingBox();
        if (!bounds) {
          throw new Error("Attachment must have visible bounds");
        }
        if (kind === "image") {
          await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          const dialog = page.getByRole("dialog", { name: /Image preview/u });
          await dialog.waitFor();
          expect(await attachment.count()).toBe(1);
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "detached" });
          const neighbor = thumbnails.filter({
            has: page.getByAltText("neighbor.png", { exact: true }),
          });
          const neighborBounds = await neighbor.boundingBox();
          if (!neighborBounds) {
            throw new Error("Neighbor must have visible bounds");
          }
          await page.touchscreen.tap(neighborBounds.x + 3, neighborBounds.y + 14);
          await page.getByRole("dialog", { name: "Image preview: neighbor.png" }).waitFor();
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "detached" });
        }
        // Outside the thumbnail: enlarging a clipped button cannot pass this tap.
        await page.touchscreen.tap(bounds.x + bounds.width + 4, bounds.y + 14);
        await expect.poll(() => attachment.count()).toBe(0);
        expect(await page.getByRole("dialog", { name: /Image preview/u }).count()).toBe(0);
        if (previewUrl) {
          expect(await thumbnails.count()).toBe(1);
          expect(
            await page.evaluate(
              async (url) =>
                fetch(url).then(
                  () => false,
                  () => true,
                ),
              previewUrl,
            ),
          ).toBe(true);
        }
      },
    );
  });
});
