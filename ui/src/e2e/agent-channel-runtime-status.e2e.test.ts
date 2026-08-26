// Control UI E2E tests cover Agents channel runtime-status precedence.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Agents channel status",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "channel-runtime-status");

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

suite.define(() => {
  it("keeps an explicit stopped runtime in warning state when its API probe succeeds", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
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
              config: { agents: { entries: { main: { default: true } } } },
              hash: "hash-1",
              issues: [],
              raw: '{"agents":{"list":[{"id":"main"}]}}',
              valid: true,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/channels`);
        expect(response?.status()).toBe(200);
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe("/settings/agents/main/channels");
        await page.getByRole("tab", { name: /^Channels/ }).click();

        const discordRow = page.locator(".settings-row").filter({ hasText: "Discord" });
        await expect.poll(() => discordRow.count()).toBe(1);

        const status = discordRow.locator(".settings-status");
        await expect.poll(async () => (await status.textContent())?.trim()).toBe("0/1 connected");
        await expect
          .poll(async () => await status.getAttribute("class"))
          .toContain("settings-status--warn");
        await screenshot(page);
      },
    );
  });
});
