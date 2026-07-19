// Control UI tests cover event-reactive custodian presence against a mocked Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
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
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "custodian-event-nudge",
);

let browser: Browser;
let server: ControlUiE2eServer;

async function settleUi(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

describeControlUiE2e("Control UI custodian event nudge mocked Gateway E2E", () => {
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

  it("shows one consequential nudge and sends its canonical message", async () => {
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? { recordVideo: { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
      methodResponses: {
        "openclaw.chat": {
          sessionId: "e2e-custodian",
          reply: "I'm watching the system.",
          action: "none",
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}custodian`);
      expect(response?.status()).toBe(200);
      await page.getByRole("heading", { name: "OpenClaw", exact: true }).waitFor();
      await expect.poll(async () => (await gateway.getRequests("openclaw.chat")).length).toBe(1);

      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "01-before-event.png"),
        });
      }

      await gateway.emitGatewayEvent("config.changed", {
        hash: "config-hash",
        path: "/tmp/openclaw.json",
        ts: Date.now(),
      });
      await settleUi(page);
      expect(await page.locator(".custodian__nudge").count()).toBe(0);

      await gateway.emitGatewayEvent("health", {
        channelLabels: { telegram: "Telegram" },
        channels: {
          telegram: { configured: true, connected: false, running: true },
        },
      });

      const nudge = page.getByRole("button", {
        name: "Telegram just disconnected — ask me what happened",
      });
      await nudge.waitFor();
      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "02-disconnected-nudge.png"),
        });
      }

      await nudge.click();
      await expect.poll(async () => (await gateway.getRequests("openclaw.chat")).length).toBe(2);
      const requests = await gateway.getRequests("openclaw.chat");
      expect(requests[1]?.params).toMatchObject({
        message: "what happened with telegram?",
        sessionId: "e2e-custodian",
      });
      await page.locator(".chat-group.user", { hasText: "what happened with telegram?" }).waitFor();
      expect(await nudge.count()).toBe(0);

      await gateway.emitGatewayEvent("health", {
        configReload: { hotReloadStatus: "disabled" },
      });
      await settleUi(page);
      expect(await page.locator(".custodian__nudge").count()).toBe(0);

      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "03-message-sent.png"),
        });
      }
    } finally {
      await context.close();
    }
  });

  it("stays silent during onboarding", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
      methodResponses: {
        "openclaw.chat": {
          sessionId: "e2e-onboarding-custodian",
          reply: "Let's finish setup.",
          action: "none",
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}custodian?onboarding=1`);
      expect(response?.status()).toBe(200);
      await page.getByRole("heading", { name: "OpenClaw", exact: true }).waitFor();
      await gateway.emitGatewayEvent("health", {
        channelLabels: { telegram: "Telegram" },
        channels: {
          telegram: { configured: true, connected: false, running: true },
        },
      });
      await settleUi(page);
      expect(await page.locator(".custodian__nudge").count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
