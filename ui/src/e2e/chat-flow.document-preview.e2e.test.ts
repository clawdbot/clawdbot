import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("blocks hostile HTML preview network requests in the transcript and Files", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const leakedRequests: string[] = [];
    const previewRequests: string[] = [];
    const hostileHtml =
      '<!-- <head><img src="https://preview-leak.test/comment.png"></head> -->' +
      '<html data-fake="<head>"><img src="https://preview-leak.test/before-head.png">' +
      "<head><title>Hostile preview</title></head><body>" +
      '<img src="https://preview-leak.test/body.png"></body></html>';
    await context.route("https://preview-leak.test/**", async (route) => {
      leakedRequests.push(route.request().url());
      await route.fulfill({ body: "leaked", contentType: "image/png" });
    });
    await page.route("**/__openclaw__/hostile-preview.html", async (route) => {
      previewRequests.push(route.request().url());
      await route.fulfill({ body: hostileHtml, contentType: "text/html" });
    });
    await installMockGateway(page, {
      historyMessages: [
        {
          id: "assistant-hostile-html-preview",
          role: "assistant",
          content: [
            {
              type: "attachment",
              attachment: {
                kind: "document",
                label: "hostile-preview.html",
                mimeType: "text/html",
                sizeBytes: Buffer.byteLength(hostileHtml),
                url: "/__openclaw__/hostile-preview.html",
              },
            },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const card = page
        .locator(".chat-assistant-attachment-card--document")
        .filter({ hasText: "hostile-preview.html" });
      const transcriptFrame = card.locator("iframe");
      await transcriptFrame.waitFor({ state: "visible", timeout: 10_000 });
      await transcriptFrame.evaluate(
        (frame) =>
          new Promise<void>((resolve) => {
            frame.addEventListener("load", () => resolve(), { once: true });
            setTimeout(resolve, 250);
          }),
      );
      expect(previewRequests).toHaveLength(1);
      expect(leakedRequests).toHaveLength(0);

      await card.locator(".chat-assistant-attachment-card__expand").click();
      const filesFrame = page.locator(".sidebar-attachment-preview__frame");
      await filesFrame.waitFor({ state: "visible", timeout: 10_000 });
      await filesFrame.evaluate(
        (frame) =>
          new Promise<void>((resolve) => {
            frame.addEventListener("load", () => resolve(), { once: true });
            setTimeout(resolve, 250);
          }),
      );
      expect(leakedRequests).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("renders every safe CSV cell in Files without a raw iframe", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const csv = Array.from({ length: 10 }, (_row, row) =>
      Array.from({ length: 64 }, (_column, column) => `${row}:${column}`).join(","),
    ).join("\n");
    await page.route("**/__openclaw__/wide.csv", async (route) => {
      await route.fulfill({ body: csv, contentType: "text/csv" });
    });
    await installMockGateway(page, {
      historyMessages: [
        {
          id: "assistant-wide-csv",
          role: "assistant",
          content: [
            {
              type: "attachment",
              attachment: {
                kind: "document",
                label: "wide.csv",
                mimeType: "text/csv",
                sizeBytes: Buffer.byteLength(csv),
                url: "/__openclaw__/wide.csv",
              },
            },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const card = page
        .locator(".chat-assistant-attachment-card--document")
        .filter({ hasText: "wide.csv" });
      await card.locator(".chat-assistant-attachment-card__expand").click();
      const tableWrap = page.locator(
        '.sidebar-attachment-preview .chat-assistant-attachment-card__table-wrap[data-display="full"]',
      );
      await tableWrap.waitFor({ state: "visible", timeout: 10_000 });

      expect(await tableWrap.locator("thead th").count()).toBe(64);
      expect(await tableWrap.locator("tbody tr").count()).toBe(9);
      expect(await page.locator(".sidebar-attachment-preview iframe").count()).toBe(0);
      expect(await tableWrap.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

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
        (await card.locator(".chat-assistant-attachment-card__expand").textContent())?.trim(),
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
