import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const controlUiBasePath = "/rosita";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "managed-image-actions");

suite.define(() => {
  it("previews, downloads, copies, and opens a ticketed generated image", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const attachmentId = crypto.randomUUID();
    const artifactId = `artifact_managed_image_${attachmentId}`;
    const imageUrl = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const ticketedUrl = `${imageUrl}?mediaTicket=ticket-e2e`;
    const imageBytes = await readFile(
      path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"),
    );
    const requestedVariants: string[] = [];
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "copiedImage", { configurable: true, writable: true });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          write: async (items: ClipboardItem[]) => {
            const blob = await items[0]?.getType("image/png");
            Object.defineProperty(globalThis, "copiedImage", {
              configurable: true,
              value: blob ? { size: blob.size, type: blob.type } : null,
              writable: true,
            });
          },
        },
      });
    });
    await page.route(`**${controlUiBasePath}/api/chat/media/outgoing/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      expect(url.pathname).toMatch(/^\/rosita\/api\/chat\/media\/outgoing\//u);
      expect(url.searchParams.get("mediaTicket")).toBe("ticket-e2e");
      expect(request.headers().authorization).toBeUndefined();
      expect(request.headers()["x-openclaw-requester-session-key"]).toBeUndefined();
      requestedVariants.push(url.pathname.split("/").at(-1) ?? "");
      await route.fulfill({ body: imageBytes, contentType: "image/png" });
    });
    const gateway = await installMockGateway(page, {
      basePath: controlUiBasePath,
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "image",
              artifactId,
              url: imageUrl,
              alt: "Ticketed generated image",
              mimeType: "image/png",
              width: 1280,
              height: 358,
            },
          ],
          timestamp: Date.now(),
        },
      ],
      methodResponses: {
        "artifacts.download": {
          artifact: {
            id: artifactId,
            type: "image",
            title: "Ticketed generated image",
            mimeType: "image/png",
            download: { mode: "url" },
          },
          url: ticketedUrl,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}${controlUiBasePath.slice(1)}/chat`);
      const image = page.getByAltText("Ticketed generated image");
      await image.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() =>
          image.evaluate((element) =>
            element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
          ),
        )
        .toBe(1280);
      expect(requestedVariants).toEqual(["thumbnail"]);
      if (captureUiProofEnabled) {
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({
          fullPage: true,
          path: path.join(proofDir, "ticketed-generated-image-subpath.png"),
        });
      }

      await page.locator(".chat-assistant-attachment-card--image").hover();
      const downloadButton = page.locator(".chat-assistant-attachment-card__download");
      await expect
        .poll(() =>
          downloadButton.evaluate((button) => {
            const rect = button.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            );
            return {
              hit: hit instanceof Node && button.contains(hit),
              target:
                hit instanceof Element
                  ? `${hit.tagName.toLowerCase()}.${Array.from(hit.classList).join(".")}`
                  : null,
              pointerEvents: getComputedStyle(button).pointerEvents,
            };
          }),
        )
        .toMatchObject({ hit: true, pointerEvents: "auto" });
      const download = page.waitForEvent("download");
      await downloadButton.click();
      expect((await download).suggestedFilename()).toBe("Ticketed generated image.png");

      await page.locator(".chat-assistant-attachment-card__copy").click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (globalThis as { copiedImage?: { size: number; type: string } }).copiedImage ?? null,
          ),
        )
        .toEqual({ size: imageBytes.byteLength, type: "image/png" });

      await page.locator(".chat-assistant-attachment-card__expand").click();
      await page
        .getByRole("dialog", { name: "Image preview: Ticketed generated image" })
        .waitFor({ state: "visible" });
      expect(requestedVariants).toEqual(["thumbnail", "full"]);
      expect(await gateway.getRequests("artifacts.download")).toHaveLength(2);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
