// Control UI E2E tests cover Agents channel runtime-status precedence.
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
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "channel-runtime-status");

let browser: Browser;
let server: ControlUiE2eServer;

async function screenshot(page: Page) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, "after.png"),
  });
}

describeControlUiE2e("Control UI Agents channel status", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not available at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps an explicit stopped runtime in warning state when its API probe succeeds", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      assistantName: "Main agent",
      defaultAgentId: "main",
      methodResponses: {
        "agents.list": {
          agents: [{ id: "main", name: "Main agent" }],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "channels.status": {
          ts: Date.now(),
          channelOrder: ["discord"],
          channelLabels: { discord: "Discord" },
          channelMeta: [{ id: "discord", label: "Discord", detailLabel: "Discord Bot" }],
          channels: {},
          channelAccounts: {
            discord: [
              {
                accountId: "default",
                configured: true,
                connected: false,
                enabled: true,
                probe: { ok: true },
                running: false,
              },
            ],
          },
          channelDefaultAccountId: { discord: "default" },
        },
        "config.get": {
          config: { agents: { list: [{ id: "main" }] } },
          hash: "hash-1",
          issues: [],
          raw: '{"agents":{"list":[{"id":"main"}]}}',
          valid: true,
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}agents`);
      expect(response?.status()).toBe(200);
      await page.getByRole("button", { name: /^Channels/ }).click();

      const discordRow = page.locator(".settings-row").filter({ hasText: "Discord" });
      await expect.poll(() => discordRow.count()).toBe(1);

      const status = discordRow.locator(".settings-status");
      await expect.poll(async () => (await status.textContent())?.trim()).toBe("0/1 connected");
      await expect
        .poll(async () => await status.getAttribute("class"))
        .toContain("settings-status--warn");
      await screenshot(page);
    } finally {
      await context.close();
    }
  });
});
