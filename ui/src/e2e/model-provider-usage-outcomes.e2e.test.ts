// Control UI E2E proves provider-usage request failures remain distinct from provider data.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Model Provider operator outcomes mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});
const now = Date.now();
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
const artifactDir = path.resolve(".artifacts/control-ui-e2e/model-providers");
const unavailableMessage =
  "Provider usage is unavailable; the last request failed. Refresh to retry.";

function providerUsageResponses(usageStatus: unknown) {
  return {
    "config.get": { config: {}, hash: "provider-usage-outcome" },
    "models.list": { models: [] },
    "models.authStatus": {
      ts: now,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          status: "ok",
          profiles: [],
        },
      ],
    },
    "sessions.usage": { aggregates: { byProvider: [] } },
    "usage.status": usageStatus,
  };
}

suite.define(() => {
  it("shows a visible warning when the provider usage request fails", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: providerUsageResponses({
            __mockError: { code: "INTERNAL_ERROR", message: "gateway transport unavailable" },
          }),
        });

        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await page.locator('[data-provider-id="openai"]').waitFor();
        await expect
          .poll(async () => (await gateway.getRequests("usage.status")).length)
          .toBeGreaterThan(0);
        await expect
          .poll(() => page.locator(".settings-page").textContent())
          .toContain(unavailableMessage);
        if (recordVisuals) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "provider-usage-request-failed.png"),
          });
        }
      },
    );
  });

  it("keeps provider-scoped usage errors as data without the global warning", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: providerUsageResponses({
            updatedAt: now,
            providers: [
              {
                provider: "openai",
                displayName: "OpenAI",
                windows: [],
                error: "provider API unavailable",
              },
            ],
          }),
        });

        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const card = page.locator('[data-provider-id="openai"]');
        await card.waitFor();
        await expect
          .poll(async () => (await gateway.getRequests("usage.status")).length)
          .toBeGreaterThan(0);
        await expect.poll(() => card.textContent()).toContain("provider API unavailable");
        await expect
          .poll(() => page.locator(".settings-page").textContent())
          .not.toContain(unavailableMessage);
        if (recordVisuals) {
          await mkdir(artifactDir, { recursive: true });
          await card.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "provider-usage-provider-error.png"),
          });
        }
      },
    );
  });

  it("clears unsaved provider credentials when switching agents without saving them", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_280 },
      },
      async ({ page }) => {
        const config = {
          agents: { defaults: { model: "openai/gpt-5.5" } },
          models: { providers: { openai: { apiKey: "[redacted]" } } },
        };
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          featureMethods: ["chat.metadata", "chat.startup", "config.patch"],
          methodResponses: {
            ...providerUsageResponses({ updatedAt: now, providers: [] }),
            "agents.list": {
              agents: [
                { id: "main", name: "Main" },
                { id: "writer", name: "Writer" },
              ],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            "config.get": {
              config,
              sourceConfig: config,
              hash: "model-providers-agent-credentials",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "config.patch": { ok: true },
            "models.list": {
              models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
            },
            "models.authStatus": {
              ts: now,
              providerCapabilities: [
                { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
                { provider: "google", apiKeySupported: true, quickApiKeySetup: true },
              ],
              providers: [
                {
                  provider: "openai",
                  displayName: "OpenAI",
                  status: "static",
                  profiles: [],
                  apiKey: { source: "config" },
                },
              ],
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const openaiCard = page.locator('[data-provider-id="openai"]');
        await expect.poll(async () => openaiCard.textContent()).toContain("Credentials for Main");
        await openaiCard.getByRole("button", { name: "Replace key" }).click();
        if (recordVisuals) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            path: path.join(artifactDir, "provider-credential-scope-before.png"),
            fullPage: true,
          });
        }
        await openaiCard.getByLabel("API key").fill("synthetic-main-provider-key");

        const agentPicker = page.locator(".agent-scope-control openclaw-agent-select");
        await agentPicker.locator(".agent-select__trigger").click();
        await agentPicker.locator('wa-dropdown-item[aria-label="Writer"]').click();
        await expect.poll(async () => openaiCard.textContent()).toContain("Credentials for Writer");
        await expect.poll(async () => openaiCard.locator('input[type="password"]').count()).toBe(0);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        if (recordVisuals) {
          await page.screenshot({
            path: path.join(artifactDir, "provider-credential-scope-inline-cleared.png"),
            fullPage: true,
          });
        }

        const addSection = page.locator(".settings-section", {
          has: page.getByRole("heading", { name: "Add provider" }),
        });
        await addSection.getByRole("button", { name: "Add provider", exact: true }).click();
        await addSection.getByLabel("Provider").selectOption("google");
        await addSection.getByLabel("API key").fill("synthetic-writer-provider-key");
        await agentPicker.locator(".agent-select__trigger").click();
        await agentPicker.locator('wa-dropdown-item[aria-label="Main"]').click();
        await expect.poll(async () => openaiCard.textContent()).toContain("Credentials for Main");
        await expect.poll(async () => page.locator(".model-providers__add-form").count()).toBe(0);
        await expect.poll(async () => openaiCard.locator('input[type="password"]').count()).toBe(0);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        if (recordVisuals) {
          await page.screenshot({
            path: path.join(artifactDir, "provider-credential-scope-after.png"),
            fullPage: true,
          });
        }
      },
    );
  });
});
