// Control UI E2E proves provider-usage request failures remain distinct from provider data.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Model Provider usage outcomes mocked Gateway E2E",
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
});
