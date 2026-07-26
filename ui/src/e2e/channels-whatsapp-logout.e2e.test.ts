// Control UI tests cover WhatsApp logout feedback against a mocked Gateway.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const QR_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=";

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI WhatsApp logout mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps the QR visible and explains a no-op logout", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "channels.status": {
          ts: Date.now(),
          channelOrder: ["whatsapp"],
          channelLabels: { whatsapp: "WhatsApp" },
          channels: {
            whatsapp: {
              configured: true,
              linked: true,
              running: true,
              connected: true,
              reconnectAttempts: 0,
            },
          },
          channelAccounts: {},
          channelDefaultAccountId: {},
        },
        "web.login.start": {
          connected: false,
          message: "Scan this QR.",
          qrDataUrl: QR_DATA_URL,
        },
        "channels.logout": {
          channel: "whatsapp",
          accountId: "default",
          cleared: false,
          loggedOut: false,
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/channels`);
      expect(response?.status()).toBe(200);
      const channel = page.locator(".channels-item", { hasText: "WhatsApp" }).first();
      await channel.click();
      const detail = page.locator(".channels-detail");
      await detail.waitFor();

      await detail.getByRole("button", { name: "Relink" }).click();
      const qr = detail.getByRole("img", { name: "WhatsApp QR" });
      await qr.waitFor();
      await expect(qr.getAttribute("src")).resolves.toBe(QR_DATA_URL);

      await detail.getByRole("button", { name: "Logout" }).click();
      await expect
        .poll(async () => detail.locator(".settings-row__desc").allTextContents())
        .toContain(
          "No stored WhatsApp session was cleared. It may already be absent, or its auth directory may require manual cleanup.",
        );
      await expect(qr.getAttribute("src")).resolves.toBe(QR_DATA_URL);
      await expect(detail.getByText("Logged out.", { exact: true }).count()).resolves.toBe(0);
      await expect.poll(async () => gateway.getRequests("channels.logout")).toHaveLength(1);
      await expect.poll(async () => gateway.getRequests("channels.status")).toHaveLength(3);
    } finally {
      await context.close();
    }
  });
});
