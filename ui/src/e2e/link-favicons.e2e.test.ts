// Control UI tests cover the authenticated default-on link-favicon flow and explicit opt-out.
import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);

suite.define(() => {
  it("loads enabled favicons only through the authenticated same-origin route", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 600, width: 900 },
    });
    const page = await context.newPage();
    const destinationRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith("https://docs.example.com")) {
        destinationRequests.push(request.url());
      }
    });
    let faviconRequests = 0;
    await page.route("**/__openclaw__/link-favicon/docs.example.com", async (route) => {
      faviconRequests += 1;
      expect(route.request().headers()["authorization"]).toBe("Bearer e2e-device-token");
      await route.fulfill({ body: ONE_PIXEL_PNG, contentType: "image/png", status: 200 });
    });
    await installMockGateway(page, {
      automaticallyFetchFavicons: true,
      historyMessages: [
        {
          content: [{ type: "text", text: "Read [the docs](https://docs.example.com/guide)." }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const icon = page.locator(
        'img.markdown-link-favicon[data-link-favicon-host="docs.example.com"]',
      );
      await expect.poll(() => icon.getAttribute("class")).toContain("is-loaded");
      expect(faviconRequests).toBe(1);
      expect(destinationRequests).toEqual([]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("makes zero favicon requests when the setting is explicitly off", async () => {
    const context = await suite.newBrowserContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    let faviconRequests = 0;
    await page.route("**/__openclaw__/link-favicon/**", async (route) => {
      faviconRequests += 1;
      await route.abort();
    });
    await installMockGateway(page, {
      automaticallyFetchFavicons: false,
      historyMessages: [
        {
          content: [{ type: "text", text: "Read [the docs](https://docs.example.com/guide)." }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator('a[href="https://docs.example.com/guide"]').waitFor();
      await page.waitForTimeout(100);
      expect(faviconRequests).toBe(0);
      expect(await page.locator("img.markdown-link-favicon").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
