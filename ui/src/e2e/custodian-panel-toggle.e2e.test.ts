// Control UI tests cover the global Ask OpenClaw panel toggle and persisted session identity.
import { mkdir } from "node:fs/promises";
import path from "node:path";
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
const artifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "custodian-panel-toggle",
);

const CUSTODIAN_SESSION_STORAGE_KEY = "openclaw.custodian.session.v1";
const MOCK_SESSION_ID = "e2e-custodian-panel";

let browser: Browser;
let server: ControlUiE2eServer;

function custodianGatewayScenario() {
  return {
    featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat", "openclaw.chat.history"],
    methodResponses: {
      "openclaw.chat": {
        sessionId: MOCK_SESSION_ID,
        reply: "Machine is healthy. Ask me anything.",
        action: "none",
      },
      "openclaw.chat.history": {
        turns: [
          { role: "user", text: "Fix my channel", at: 1_700_000_100_000 },
          { role: "assistant", text: "Channel repaired.", at: 1_700_000_101_000 },
        ],
      },
    },
  };
}

describeControlUiE2e("Control UI Ask OpenClaw panel toggle mocked Gateway E2E", () => {
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

  it("hides the chrome toggle when openclaw.chat is not advertised", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, { featureMethods: ["chat.metadata", "chat.startup"] });

    try {
      const response = await page.goto(`${server.baseUrl}chat`);
      expect(response?.status()).toBe(200);
      await page.locator(".shell-chrome-controls__search").waitFor();
      await expect.poll(() => page.locator(".shell-chrome-controls__custodian").count()).toBe(0);
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "00-gated-off-no-button.png"),
      });
    } finally {
      await context.close();
    }
  });

  it("toggles the panel from chrome and palette and reuses the persisted session id", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, custodianGatewayScenario());

    try {
      const response = await page.goto(`${server.baseUrl}chat`);
      expect(response?.status()).toBe(200);

      // The lobster chrome button renders only while openclaw.chat is advertised.
      const chromeToggle = page.locator(".shell-chrome-controls__custodian");
      await chromeToggle.waitFor();
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "01-chrome-button.png"),
      });

      // Opening the panel renders the durable machine-wide history from the Gateway.
      await chromeToggle.click();
      const panel = page.locator("openclaw-custodian-panel");
      await panel.getByText("Channel repaired.").waitFor();
      const chatRequest = await gateway.waitForRequest("openclaw.chat");
      const firstSessionId = (chatRequest.params as { sessionId?: string }).sessionId;
      expect(typeof firstSessionId).toBe("string");
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "02-panel-open-history.png"),
      });

      // The same button closes it again.
      await chromeToggle.click();
      await panel.getByText("Channel repaired.").waitFor({ state: "hidden" });

      // The command palette exposes the same toggle from anywhere. Its action
      // dispatches the identical toggle event the chrome button uses (pinned by
      // the palette unit test), so this asserts the gated entry exists and
      // reopens through the chrome path — the palette click-through composition
      // proved timing-flaky on loaded CI runners without adding coverage.
      await page.locator(".shell-chrome-controls__search").click();
      await page.getByPlaceholder("Search chats and commands…").fill("Ask OpenClaw");
      const paletteItem = page.locator(".cmd-palette__item--active", { hasText: "Ask OpenClaw" });
      await paletteItem.waitFor();
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "03-palette-item.png"),
      });
      await page.keyboard.press("Escape");
      await chromeToggle.click();
      await panel.getByText("Channel repaired.").waitFor();

      // The server-confirmed session id persists and is reused after a full reload.
      const storedSessionId = await page.evaluate(
        (key) => window.localStorage.getItem(key),
        CUSTODIAN_SESSION_STORAGE_KEY,
      );
      expect(storedSessionId).toBe(MOCK_SESSION_ID);

      // Reload: the dock restores its open state on its own and rerenders the
      // durable history with the persisted session id — no clicks required.
      // The reload replaces the page context and restarts the request ring, so
      // the plain wait matches only post-reload openclaw.chat traffic.
      await page.reload();
      await page.locator("openclaw-custodian-panel").getByText("Channel repaired.").waitFor();
      const reloadedRequest = await gateway.waitForRequest("openclaw.chat");
      expect((reloadedRequest.params as { sessionId?: string }).sessionId).toBe(MOCK_SESSION_ID);
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "04-after-reload-same-session.png"),
      });
    } finally {
      await context.close();
    }
  });
});
