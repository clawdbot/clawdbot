// Control UI tests cover the global Ask OpenClaw panel toggle and persisted session identity.
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
let artifactDir: string;
beforeEach(() => {
  artifactDir = createControlUiE2eArtifactDir("custodian-panel-toggle");
});

const CUSTODIAN_SESSION_STORAGE_KEY = "openclaw.custodian.session.v1";
const MOCK_SESSION_ID = "e2e-custodian-panel";
const WORK_SESSION_KEY = "agent:main:work";

let browser: Browser;
let server: ControlUiE2eServer;

function custodianGatewayScenario() {
  return {
    sessionKey: WORK_SESSION_KEY,
    featureMethods: [
      "chat.metadata",
      "chat.startup",
      "chat.history",
      "chat.send",
      "openclaw.chat",
      "openclaw.chat.history",
    ],
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
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps Home available without an OpenClaw tab when openclaw.chat is not advertised", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey: WORK_SESSION_KEY,
      featureMethods: ["chat.metadata", "chat.startup", "chat.history", "chat.send"],
    });

    try {
      const response = await page.goto(controlUiSessionUrl(server.baseUrl, WORK_SESSION_KEY));
      expect(response?.status()).toBe(200);
      await page.locator(".sidebar-brand__search").waitFor();
      await page.locator(".sidebar-identity-card").waitFor();
      await page.locator(".sidebar-footer-bar__home").click();
      const panel = page.locator("openclaw-assistant-panel");
      await panel.getByRole("button", { name: "Home", exact: true }).waitFor();
      expect(await panel.getByRole("button", { name: "Ask OpenClaw", exact: true }).count()).toBe(
        0,
      );
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "00-home-without-openclaw-tab.png"),
      });
    } finally {
      await context.close();
    }
  });

  it("opens OpenClaw from Home and the palette and reuses the persisted session id", async () => {
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
      const response = await page.goto(controlUiSessionUrl(server.baseUrl, WORK_SESSION_KEY));
      expect(response?.status()).toBe(200);

      await page.locator(".sidebar-footer-bar__home").click();
      const panel = page.locator("openclaw-assistant-panel");
      const openClawTab = panel.getByRole("button", { name: "Ask OpenClaw", exact: true });
      await openClawTab.waitFor();
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "01-home-dock.png"),
      });

      // Opening the panel renders the durable machine-wide history from the Gateway.
      await openClawTab.click();
      await panel.getByText("Channel repaired.").waitFor();
      const chatRequest = await gateway.waitForRequest("openclaw.chat");
      const firstSessionId = (chatRequest.params as { sessionId?: string }).sessionId;
      expect(typeof firstSessionId).toBe("string");
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "02-panel-open-history.png"),
      });

      await panel.getByRole("button", { name: "Close assistant sidebar", exact: true }).click();
      await panel.getByText("Channel repaired.").waitFor({ state: "hidden" });

      // The command palette opens the same conversation directly.
      await page.locator(".sidebar-brand__search").click();
      await page.getByPlaceholder("Search chats and commands…").fill("Ask OpenClaw");
      const paletteItem = page.getByRole("option", { name: "Ask OpenClaw", exact: true });
      await paletteItem.waitFor();
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "03-palette-item.png"),
      });
      await paletteItem.click();
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
      await page.locator("openclaw-assistant-panel").getByText("Channel repaired.").waitFor();
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
