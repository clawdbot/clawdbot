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
        "channels.pairing.list": {
          accounts: [],
          requests: [],
          commandOwnerConfigured: true,
          limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
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

  it("preserves standard channel details and the complete Telegram setup wizard", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const channelEntries = [
      ["discord", "Discord"],
      ["googlechat", "Google Chat"],
      ["imessage", "iMessage"],
      ["signal", "Signal"],
      ["slack", "Slack"],
      ["telegram", "Telegram"],
    ] as const;
    const running = { configured: true, running: true };
    const details: Record<string, Record<string, unknown>> = {
      googlechat: {
        credentialSource: "service-account",
        audienceType: "url",
        audience: "https://chat.example.test",
      },
      signal: { baseUrl: "https://signal.example.test" },
    };
    const bot = (accountId: string, username: string) => ({
      accountId,
      ...running,
      probe: { bot: { username } },
    });
    const step = (id: string, type: string, values: Record<string, unknown> = {}) => ({
      done: false,
      status: "running",
      step: { id, type, ...values },
    });
    const gateway = await installMockGateway(page, {
      featureMethods: ["channels.status", "channels.pairing.list", "wizard.start", "wizard.next"],
      methodResponses: {
        "channels.status": {
          ts: Date.now(),
          channelOrder: channelEntries.map(([id]) => id),
          channelLabels: Object.fromEntries(channelEntries),
          channelMeta: channelEntries.map(([id, label]) => ({ id, label })),
          channels: Object.fromEntries(
            channelEntries.map(([id]) => [id, { ...running, ...details[id] }]),
          ),
          channelAccounts: { telegram: [bot("personal", "alpha_bot"), bot("work", "work_bot")] },
          channelDefaultAccountId: { telegram: "personal" },
        },
        "channels.pairing.list": {
          accounts: [],
          requests: [],
          commandOwnerConfigured: true,
          limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
        },
        "wizard.start": {
          sessionId: "channel-standard-proof",
          ...step("account", "select", {
            message: "Choose Telegram account",
            initialValue: "personal",
            options: ["personal", "work"].map((value) => ({
              value,
              label: value === "work" ? "Work bot" : "Personal bot",
            })),
          }),
        },
        "wizard.next": {
          sequence: [
            step("token", "text", { message: "Telegram bot token", sensitive: true }),
            step("features", "multiselect", {
              initialValue: ["alpha"],
              options: ["alpha", "beta"].map((value) => ({
                value,
                label: value === "alpha" ? "Alpha" : "Beta",
              })),
            }),
            step("confirm", "confirm", { message: "Apply Telegram settings?" }),
            step("progress", "progress", { executor: "gateway", message: "Finish preparation" }),
            { done: true, status: "done", channels: ["telegram"], accounts: [] },
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/channels`);
      const expectedFields: Record<string, string[]> = {
        googlechat: ["service-account", "url · https://chat.example.test"],
        signal: ["https://signal.example.test"],
        telegram: ["@alpha_bot", "@work_bot", "2"],
      };
      for (const [channelId, label] of channelEntries) {
        await page.locator(".channels-item", { hasText: label }).first().click();
        const detail = page.locator(".channels-detail");
        await expect
          .poll(() => detail.locator("h2.settings-section__heading").textContent())
          .toContain(label);
        await detail.getByRole("button", { name: "Probe" }).waitFor();
        for (const value of expectedFields[channelId] ?? []) {
          await detail.getByText(value, { exact: true }).waitFor();
        }
        if (channelId !== "telegram") {
          await detail.getByRole("button", { name: "Close" }).click();
        }
      }

      await page.locator(".channels-detail").getByRole("button", { name: "Run setup" }).click();
      const wizard = page.locator(".channels-wizard");
      await gateway.deferNext("wizard.next");
      await wizard.getByRole("radio", { name: "Work bot" }).click();
      await expect.poll(async () => gateway.getRequests("wizard.next")).toHaveLength(1);
      await expect
        .poll(() => wizard.locator("wa-radio-group").getAttribute("disabled"))
        .not.toBeNull();
      await gateway.resolveDeferred("wizard.next");

      const token = wizard.getByLabel("Telegram bot token");
      await expect.poll(() => token.getAttribute("type")).toBe("password");
      await token.fill("123456:proof-secret");
      await wizard.getByRole("button", { name: "Continue" }).click();
      const beta = wizard.getByRole("button", { name: /Beta/u });
      await expect.poll(() => beta.getAttribute("aria-pressed")).toBe("false");
      await beta.click();
      await expect.poll(() => beta.getAttribute("aria-pressed")).toBe("true");
      await wizard.getByRole("button", { name: "Continue" }).click();
      await wizard.getByRole("button", { name: "Yes" }).click();
      await wizard.getByRole("button", { name: "Finish" }).waitFor();

      const userAnswers = [
        ["account", "work"],
        ["token", "123456:proof-secret"],
        ["features", ["alpha", "beta"]],
        ["confirm", true],
      ] as const;
      expect((await gateway.getRequests("wizard.next")).map(({ params }) => params)).toEqual([
        ...userAnswers.map(([stepId, value]) => ({
          sessionId: "channel-standard-proof",
          answer: { stepId, value },
        })),
        { sessionId: "channel-standard-proof" },
      ]);
    } finally {
      await context.close();
    }
  });
});
