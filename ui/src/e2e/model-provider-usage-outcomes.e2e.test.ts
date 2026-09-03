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
  it("shows usage request failures with no configured providers", async () => {
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
        await expect
          .poll(async () => (await gateway.getRequests("usage.status")).length)
          .toBeGreaterThan(0);
        await expect
          .poll(() => page.locator(".settings-page").textContent())
          .toContain(unavailableMessage);
        expect(await page.locator("[data-provider-id]").count()).toBe(0);
        if (recordVisuals) {
          await mkdir(path.join(suite.artifactDir, "model-providers"), { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              path.join(suite.artifactDir, "model-providers"),
              "provider-usage-request-failed.png",
            ),
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
          await mkdir(path.join(suite.artifactDir, "model-providers"), { recursive: true });
          await card.screenshot({
            animations: "disabled",
            path: path.join(
              path.join(suite.artifactDir, "model-providers"),
              "provider-usage-provider-error.png",
            ),
          });
        }
      },
    );
  });

  it("keeps configured models visible when their catalog fails, then recovers on refresh", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const config = {
          agents: { defaults: { model: "openai/gpt-5.5" } },
          models: { providers: { openai: { apiKey: "[redacted]" } } },
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            ...providerUsageResponses({ updatedAt: now, providers: [] }),
            "config.get": {
              config,
              sourceConfig: config,
              hash: "model-providers-catalog-failure",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "models.list": {
              __mockError: {
                code: "UNAVAILABLE",
                message: "Model catalog temporarily unavailable",
              },
            },
            "models.authStatus": {
              ts: now,
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
        const card = page.locator('[data-provider-id="openai"]');
        await card.waitFor();
        await expect
          .poll(async () => (await gateway.getRequests("models.list")).length)
          .toBeGreaterThan(0);

        if (recordVisuals) {
          await mkdir(path.join(suite.artifactDir, "model-providers"), { recursive: true });
          const phase =
            (await page.locator(".provider-usage-error").count()) === 0 ? "before" : "after";
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              path.join(suite.artifactDir, "model-providers"),
              `model-catalog-request-failure-${phase}.png`,
            ),
          });
        }

        await expect
          .poll(() => page.locator(".provider-usage-error").textContent(), { timeout: 5_000 })
          .toContain("Model catalog temporarily unavailable");
        expect(await page.locator('[data-model-readiness="model-required"]').count()).toBe(0);
        const primary = page.locator(".model-providers__defaults wa-select").first();
        await expect
          .poll(() =>
            primary.evaluate((element) =>
              String((element as HTMLElement & { value?: string }).value),
            ),
          )
          .toBe("openai/gpt-5.5");

        await gateway.setMethodResponse("models.list", {
          models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
        });
        await page.getByRole("button", { name: "Refresh", exact: true }).click();

        await expect.poll(() => page.locator(".provider-usage-error").count()).toBe(0);
        await expect.poll(() => card.textContent()).toContain("API key set in config");
        await expect
          .poll(() =>
            primary.evaluate((element) =>
              String((element as HTMLElement & { value?: string }).value),
            ),
          )
          .toBe("openai/gpt-5.5");
        if (recordVisuals) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              path.join(suite.artifactDir, "model-providers"),
              "model-catalog-request-recovered.png",
            ),
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
                { provider: "openai", apiKeySupported: true },
                { provider: "google", apiKeySupported: true },
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
        await expect.poll(async () => openaiCard.textContent()).toContain("Access");
        await openaiCard.getByRole("button", { name: "Replace key" }).click();
        if (recordVisuals) {
          await mkdir(path.join(suite.artifactDir, "model-providers"), { recursive: true });
          await page.screenshot({
            path: path.join(
              path.join(suite.artifactDir, "model-providers"),
              "provider-credential-scope-before.png",
            ),
            fullPage: true,
          });
        }
        await openaiCard.getByLabel("API key").fill("synthetic-main-provider-key");

        const agentPicker = page.locator(".agent-scope-control openclaw-agent-select");
        await agentPicker.locator(".agent-select__trigger").click();
        await agentPicker.locator('wa-dropdown-item[aria-label="Writer"]').click();
        await expect
          .poll(async () => agentPicker.locator(".agent-select__trigger").textContent())
          .toContain("Writer");
        await expect.poll(async () => openaiCard.locator('input[type="password"]').count()).toBe(0);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        if (recordVisuals) {
          await page.screenshot({
            path: path.join(
              path.join(suite.artifactDir, "model-providers"),
              "provider-credential-scope-inline-cleared.png",
            ),
            fullPage: true,
          });
        }

        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        if (recordVisuals) {
          await page.screenshot({
            path: path.join(
              path.join(suite.artifactDir, "model-providers"),
              "provider-credential-scope-after.png",
            ),
            fullPage: true,
          });
        }
      },
    );
  });
});
