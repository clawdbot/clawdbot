// Control UI tests cover WhatsApp logout feedback against a mocked Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway, waitForConfirmModal } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI WhatsApp logout mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const QR_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=";
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "channels-save-failure",
);

suite.define(() => {
  it("shows rejected channel configuration saves in the open editor without losing the draft", async () => {
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(captureUiProofEnabled
          ? { recordVideo: { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } } }
          : {}),
      },
      async ({ page }) => {
        const config = { channels: { whatsapp: { enabled: true } } };
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
            "config.get": {
              config,
              hash: "channel-config-1",
              raw: JSON.stringify(config),
              valid: true,
              issues: [],
            },
            "config.schema": {
              generatedAt: "2026-08-25T00:00:00.000Z",
              version: "e2e",
              uiHints: { "channels.whatsapp.enabled": { advanced: false } },
              schema: {
                type: "object",
                properties: {
                  channels: {
                    type: "object",
                    properties: {
                      whatsapp: {
                        type: "object",
                        properties: { enabled: { type: "boolean", title: "Enabled" } },
                      },
                    },
                  },
                },
              },
            },
          },
        });

        expect((await page.goto(`${suite.server.baseUrl}settings/channels`))?.status()).toBe(200);
        await page.locator(".channels-item", { hasText: "WhatsApp" }).first().click();
        const detail = page.locator(".channels-detail");
        await detail.getByRole("switch", { name: "Enabled" }).waitFor();
        if (captureUiProofEnabled) {
          await detail.screenshot({ path: path.join(uiProofArtifactDir, "00-editor-before.png") });
        }

        await gateway.deferNext("config.set");
        await detail.locator("wa-switch").first().click();
        await gateway.waitForRequest("config.set");
        await gateway.rejectDeferred("config.set", {
          code: "INVALID_REQUEST",
          message: "automatic channel save rejected",
        });
        const alert = detail.getByRole("alert");
        await expect.poll(() => alert.textContent()).toContain("automatic channel save rejected");

        const save = detail.getByRole("button", { name: "Save", exact: true });
        await expect.poll(() => save.isEnabled()).toBe(true);
        const writesBefore = (await gateway.getRequests("config.set")).length;
        const readsBefore = (await gateway.getRequests("config.get")).length;
        await gateway.deferNext("config.set");
        await save.click();
        const request = await gateway.waitForRequest("config.set", { after: writesBefore });
        expect(request.params).toMatchObject({ baseHash: "channel-config-1" });
        await gateway.rejectDeferred("config.set", {
          code: "INVALID_REQUEST",
          message:
            "channel rejected: OPENAI_API_KEY=sk-1234567890abcdef <img src=x onerror=alert(1)>",
        });

        await expect.poll(() => alert.textContent()).toContain("channel rejected");
        const message = await alert.textContent();
        expect(message).toContain("OPENAI_API_KEY=sk-123...cdef");
        expect(message).not.toContain("sk-1234567890abcdef");
        expect(await alert.locator("img").count()).toBe(0);
        expect(await save.isEnabled()).toBe(true);
        expect(await detail.getByRole("switch", { name: "Enabled" }).isChecked()).toBe(false);
        expect(await gateway.getRequests("config.get")).toHaveLength(readsBefore);
        if (captureUiProofEnabled) {
          await detail.screenshot({ path: path.join(uiProofArtifactDir, "01-visible-error.png") });
        }
      },
    );
  });

  it("confirms the explicit default account and preserves a no-op logout", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1280 },
      },
      async ({ page }) => {
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

        const response = await page.goto(`${suite.server.baseUrl}settings/channels`);
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
        await expect.poll(async () => gateway.getRequests("channels.logout")).toHaveLength(0);
        const firstConfirm = await waitForConfirmModal(page);
        await expect(firstConfirm.textContent()).resolves.toContain(
          "Log out of WhatsApp account default?",
        );
        await expect(firstConfirm.textContent()).resolves.toContain(
          "Logging out of account default stops its listener and deletes its saved credentials.",
        );
        await firstConfirm.getByRole("button", { name: "Cancel" }).focus();
        await page.keyboard.press("Escape");
        if (captureUiProofEnabled) {
          await mkdir(uiProofArtifactDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              uiProofArtifactDir,
              `modal-escape-${process.env.OPENCLAW_UI_PROOF_LABEL ?? "dismissed"}.png`,
            ),
          });
        }
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/channels");
        await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(1);
        await expect.poll(async () => gateway.getRequests("channels.logout")).toHaveLength(0);
        await expect(qr.getAttribute("src")).resolves.toBe(QR_DATA_URL);
        await expect
          .poll(() =>
            detail
              .locator("dt", { hasText: "Linked" })
              .locator("xpath=following-sibling::dd[1]")
              .textContent(),
          )
          .toContain("Yes");

        await detail.getByRole("button", { name: "Logout" }).click();
        const secondConfirm = await waitForConfirmModal(page);
        await secondConfirm.getByRole("button", { name: "Logout" }).click();
        await expect
          .poll(async () => detail.locator(".settings-row__desc").allTextContents())
          .toContain(
            "No stored WhatsApp session was cleared. It may already be absent, or its auth directory may require manual cleanup.",
          );
        await expect(qr.getAttribute("src")).resolves.toBe(QR_DATA_URL);
        await expect(detail.getByText("Logged out.", { exact: true }).count()).resolves.toBe(0);
        await expect.poll(async () => gateway.getRequests("channels.logout")).toHaveLength(1);
        expect((await gateway.getRequests("channels.logout"))[0]?.params).toEqual({
          channel: "whatsapp",
          accountId: "default",
        });
        await expect.poll(async () => gateway.getRequests("channels.status")).toHaveLength(3);
      },
    );
  });

  it("rejects a captured custom-account logout after the Gateway reconnects", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
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
            channelAccounts: {
              whatsapp: [
                {
                  accountId: "work",
                  configured: true,
                  linked: true,
                  running: true,
                  connected: true,
                },
              ],
            },
            channelDefaultAccountId: { whatsapp: "work" },
          },
          "channels.pairing.list": {
            accounts: [],
            requests: [],
            commandOwnerConfigured: true,
            limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
          },
          "channels.logout": {
            channel: "whatsapp",
            accountId: "work",
            cleared: true,
            loggedOut: true,
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/channels`);
      await page.locator(".channels-item", { hasText: "WhatsApp" }).first().click();
      const detail = page.locator(".channels-detail");
      await detail.waitFor();
      await detail.getByRole("button", { name: "Logout" }).click();
      const confirm = await waitForConfirmModal(page);
      await expect(confirm.textContent()).resolves.toContain("work");
      const socketCount = await gateway.getSocketCount();
      await gateway.closeLatest(1012, "Reconnect during logout confirmation");
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await confirm.getByRole("button", { name: "Logout" }).click();
      await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(1);
      await expect.poll(async () => gateway.getRequests("channels.logout")).toHaveLength(0);
    });
  });

  it("preserves standard channel details and the complete Telegram setup wizard", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
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

      await page.goto(`${suite.server.baseUrl}settings/channels`);
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
      const account = wizard.locator("wa-select");
      await account.evaluate(async (select) => {
        const picker = select as HTMLElement & { value: string; updateComplete: Promise<unknown> };
        picker.value = "1";
        await picker.updateComplete;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await expect.poll(async () => gateway.getRequests("wizard.next")).toHaveLength(1);
      await expect.poll(() => account.getAttribute("disabled")).not.toBeNull();
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
    });
  });
});
