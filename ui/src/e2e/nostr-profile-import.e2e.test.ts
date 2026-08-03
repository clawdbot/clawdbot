// Control UI tests cover the Nostr profile import draft lifecycle.
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

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI Nostr profile import E2E", () => {
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

  it("locks the draft while importing and cancels without applying the response", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    let importRequestBody: unknown;
    let releaseImport!: () => void;
    const importReleased = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });

    await installMockGateway(page, {
      methodResponses: {
        "channels.status": {
          ts: 1,
          channelOrder: ["nostr"],
          channelLabels: { nostr: "Nostr" },
          channels: {
            nostr: { configured: true, running: false, publicKey: "a".repeat(64) },
          },
          channelAccounts: {
            nostr: [
              {
                accountId: "default",
                configured: true,
                running: false,
                profile: { name: "local" },
              },
            ],
          },
          channelDefaultAccountId: { nostr: "default" },
        },
        "config.get": { config: {}, hash: "e2e" },
        "config.schema": { schema: {}, uiHints: {}, version: 1 },
      },
    });
    await page.route("**/api/channels/nostr/default/profile/import", async (route) => {
      importRequestBody = JSON.parse(route.request().postData() ?? "null");
      await importReleased;
      try {
        await route.fulfill({
          body: JSON.stringify({ ok: true, imported: { name: "imported" } }),
          contentType: "application/json",
          status: 200,
        });
      } catch {
        // Cancel may close the request before the deferred response is released.
      }
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/channels`);
      expect(response?.status()).toBe(200);

      const nostrCard = page.locator(".card").filter({ hasText: "Nostr" }).first();
      await nostrCard.getByRole("button", { name: "Edit Profile" }).click();
      const form = page.locator(".nostr-profile-form");
      await form.waitFor();
      await form.getByRole("button", { name: "Import from Relays" }).click();

      await expect.poll(() => importRequestBody).toEqual({ autoMerge: false });
      await expect
        .poll(() =>
          form
            .locator("input, textarea")
            .evaluateAll((fields) =>
              fields.map((field) => (field as HTMLInputElement | HTMLTextAreaElement).disabled),
            ),
        )
        .toEqual([true, true, true, true]);
      expect(await form.getByRole("button", { name: "Cancel" }).isEnabled()).toBe(true);

      await form.getByRole("button", { name: "Cancel" }).click();
      await expect.poll(() => form.count()).toBe(0);
      releaseImport();
    } finally {
      releaseImport();
      await context.close();
    }
  });
});
