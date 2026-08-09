// Control UI tests cover the first-run model-to-channel onboarding handoff.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  waitForControlUiRoute,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "custodian-channel-onboarding",
);

let browser: Browser;
let server: ControlUiE2eServer;

const emptyChannelSnapshot = {
  ts: 1_700_000_000_000,
  channelOrder: ["whatsapp", "telegram", "discord"],
  channelLabels: {
    whatsapp: "WhatsApp",
    telegram: "Telegram",
    discord: "Discord",
  },
  channelMeta: [
    { id: "whatsapp", label: "WhatsApp", detailLabel: "WhatsApp Web" },
    { id: "telegram", label: "Telegram", detailLabel: "Telegram Bot" },
    { id: "discord", label: "Discord", detailLabel: "Discord Bot" },
  ],
  channels: {
    whatsapp: { configured: false, running: false, connected: false },
    telegram: { configured: false, running: false, connected: false },
    discord: { configured: false, running: false, connected: false },
  },
  channelAccounts: {
    whatsapp: [],
    telegram: [],
    discord: [],
  },
  channelDefaultAccountId: {},
};

describeControlUiE2e("Control UI Custodian channel onboarding mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    await mkdir(artifactDir, { recursive: true });
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("offers optional channels after model setup and opens the real Channels hub", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "channels.pairing.list",
        "channels.status",
        "openclaw.setup.detect",
        "openclaw.setup.activate",
        "openclaw.chat",
      ],
      methodResponses: {
        "channels.pairing.list": {
          accounts: [],
          requests: [],
          commandOwnerConfigured: true,
          limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
        },
        "channels.status": emptyChannelSnapshot,
        "openclaw.setup.detect": {
          candidates: [
            {
              kind: "codex-cli",
              brandId: "openai",
              label: "Codex CLI",
              detail: "Signed in locally",
              modelRef: "openai/gpt-5",
              recommended: true,
              credentials: true,
            },
          ],
          manualProviders: [{ id: "openai", label: "OpenAI" }],
          workspace: "/tmp/openclaw-e2e",
          setupComplete: false,
        },
        "openclaw.setup.activate": {
          ok: true,
          modelRef: "openai/gpt-5",
          latencyMs: 73,
          lines: ["Model ready"],
        },
        "openclaw.chat": {
          sessionId: "e2e-channel-onboarding",
          reply: "Your AI is ready. The web app works now.",
          action: "none",
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-setup?firstRun=1`);
      expect(response?.status()).toBe(200);
      await page.getByRole("button", { name: "Test & use" }).click();
      const continueSetup = page.getByRole("button", { name: "Continue setup" });
      await continueSetup.waitFor();
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "01-after-model-ready-continue-setup.png"),
      });

      await continueSetup.click();
      await waitForControlUiRoute(page, {
        pathname: "/custodian",
        routeId: "custodian",
        search: "?onboarding=1",
      });
      const channelNudge = page.locator(".custodian__nudge--channel-onboarding");
      await channelNudge.waitFor();
      await expect.poll(() => channelNudge.textContent()).toContain("The web app already works");
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "02-after-custodian-channel-nudge.png"),
      });

      await page.setViewportSize({ height: 844, width: 390 });
      await expect
        .poll(() =>
          channelNudge.evaluate((nudge) => {
            const cta = nudge.querySelector<HTMLElement>(".custodian__nudge-cta");
            if (!cta) {
              return null;
            }
            const nudgeBox = nudge.getBoundingClientRect();
            const ctaBox = cta.getBoundingClientRect();
            return {
              ctaVisible: ctaBox.width > 0 && ctaBox.height > 0,
              mobileMediaQuery: window.matchMedia("(max-width: 640px)").matches,
              noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
              nudgeVisible: nudgeBox.width > 0 && nudgeBox.height > 0,
              nudgeWithinViewport: nudgeBox.left >= 0 && nudgeBox.right <= window.innerWidth,
              ctaWithinNudge: ctaBox.left >= nudgeBox.left && ctaBox.right <= nudgeBox.right,
              viewportWidth: window.innerWidth,
            };
          }),
        )
        .toEqual({
          ctaVisible: true,
          mobileMediaQuery: true,
          noHorizontalOverflow: true,
          nudgeVisible: true,
          nudgeWithinViewport: true,
          ctaWithinNudge: true,
          viewportWidth: 390,
        });
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "02b-after-custodian-channel-nudge-mobile.png"),
      });
      await page.setViewportSize({ height: 900, width: 1280 });

      const channelStatusRequests = await gateway.getRequests("channels.status");
      expect(channelStatusRequests).toHaveLength(1);
      expect(channelStatusRequests[0]?.params).toMatchObject({ probe: false });

      await page.getByRole("button", { name: "Set up a channel" }).click();
      await waitForControlUiRoute(page, {
        pathname: "/settings/channels",
        routeId: "channels",
        search: "",
      });
      await page.getByText("No channels connected yet. Pick one below to get started.").waitFor();
      await page.getByText("No configured channel accounts use DM sender pairing.").waitFor();
      await page.getByRole("heading", { name: "Add a channel" }).waitFor();
      expect(new URL(page.url()).searchParams.has("onboarding")).toBe(false);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(artifactDir, "03-after-channels-destination.png"),
      });

      await page.goBack();
      await waitForControlUiRoute(page, {
        pathname: "/custodian",
        routeId: "custodian",
        search: "?onboarding=1",
      });
      await expect
        .poll(() => page.locator(".custodian__nudge--channel-onboarding").count())
        .toBe(0);
    } finally {
      await context.close();
    }
  });
});
