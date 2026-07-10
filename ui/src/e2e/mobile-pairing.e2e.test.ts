// Control UI tests cover mobile pairing setup through the mocked Gateway.
import { chromium, type Browser } from "playwright";
import qrcode from "qrcode";
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

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI mobile pairing mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("opens pairing from the app shell and Quick Settings", async () => {
    const setupCode = Buffer.from(
      JSON.stringify({
        url: "wss://gateway.example.test",
        bootstrapToken: "e2e-bootstrap-token",
      }),
      "utf8",
    ).toString("base64url");
    const qrDataUrl = await qrcode.toDataURL(setupCode, { margin: 2, width: 360 });
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "device.pair.list": {
          paired: [],
          pending: [{ deviceId: "mobile-1", requestId: "request-1" }],
        },
        "device.pair.setupCode": {
          auth: "token",
          gatewayUrl: "wss://gateway.example.test",
          qrDataUrl,
          setupCode,
          urlSource: "test",
        },
        "node.list": { nodes: [] },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}chat`);
      expect(response?.status()).toBe(200);

      const sidebarPairingButton = page.locator(".sidebar-pair-mobile");
      await sidebarPairingButton.waitFor();
      await expect.poll(async () => sidebarPairingButton.isEnabled()).toBe(true);
      await gateway.deferNext("device.pair.list");
      await sidebarPairingButton.click();

      const dialog = page.getByRole("dialog", { name: "OpenClaw mobile" });
      const qr = page.getByAltText("OpenClaw mobile pairing QR code");
      await dialog.waitFor();
      await qr.waitFor();
      expect(await dialog.isVisible()).toBe(true);
      expect(await qr.getAttribute("src")).toMatch(/^data:image\/png;base64,/u);
      expect(await page.getByText("wss://gateway.example.test", { exact: true }).isVisible()).toBe(
        true,
      );
      expect(
        await page.getByText("Official OpenClaw mobile apps connect automatically").isVisible(),
      ).toBe(true);
      await gateway.resolveDeferred("device.pair.list", {
        paired: [],
        pending: [{ deviceId: "mobile-1", requestId: "request-1" }],
      });
      expect(await page.getByText("Device requests waiting for review: 1").isVisible()).toBe(true);
      expect(
        await page.getByText("Official OpenClaw mobile apps connect automatically").isVisible(),
      ).toBe(false);

      const firstRequest = await gateway.waitForRequest("device.pair.setupCode");
      expect(firstRequest.params).toEqual({});
      await expect.poll(async () => (await gateway.getRequests("device.pair.list")).length).toBe(1);

      await gateway.emitGatewayEvent("device.pair.requested", { requestId: "request-2" });
      await expect.poll(async () => (await gateway.getRequests("device.pair.list")).length).toBe(2);

      await page.locator(".device-pair-setup__close").click();
      await dialog.waitFor({ state: "hidden" });

      const settingsResponse = await page.goto(`${server.baseUrl}config`);
      expect(settingsResponse?.status()).toBe(200);
      const quickSettingsPairingButton = page
        .locator(".qs-card--security")
        .getByRole("button", { name: "Pair mobile device" });
      await quickSettingsPairingButton.waitFor();
      const setupRequestsBeforeQuickSettings = (await gateway.getRequests("device.pair.setupCode"))
        .length;
      await quickSettingsPairingButton.click();
      await dialog.waitFor();
      await expect
        .poll(async () => (await gateway.getRequests("device.pair.setupCode")).length)
        .toBe(setupRequestsBeforeQuickSettings + 1);

      await page.getByRole("button", { name: "New code" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("device.pair.setupCode")).length)
        .toBe(setupRequestsBeforeQuickSettings + 2);

      await page.getByRole("button", { name: "Manage devices" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/nodes");
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
