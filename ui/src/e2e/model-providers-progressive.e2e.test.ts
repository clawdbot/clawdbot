import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplicationRouter } from "../app-routes.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
let artifactDir: string;
beforeEach(() => {
  if (recordVisuals) {
    artifactDir = createControlUiE2eArtifactDir(
      "model-providers-progressive",
      process.env.OPENCLAW_UI_E2E_PROOF_DIR,
    );
  }
});

describeControlUiE2e("Control UI progressive Model Providers loading", () => {
  let browser: Browser;
  let server: ControlUiE2eServer;

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

  it.each(["cold", "prewarmed", "cached"] as const)(
    "renders provider controls before usage and cost settle (%s module)",
    async (moduleState) => {
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_280 },
        ...(recordVisuals
          ? { recordVideo: { dir: artifactDir, size: { height: 1_000, width: 1_280 } } }
          : {}),
      });
      const page = await context.newPage();
      const now = Date.now();
      const gateway = await installMockGateway(page, {
        models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
        heldMethods:
          moduleState === "cached"
            ? []
            : [
                "usage.status",
                "sessions.usage",
                ...(moduleState === "cold" ? ["models.authStatus"] : []),
              ],
        methodResponses: {
          "config.get": {
            config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
            sourceConfig: {},
            hash: "progressive-model-providers",
            issues: [],
            raw: "{}",
            valid: true,
          },
          "models.authStatus": {
            ts: now,
            providers: [
              {
                provider: "openai",
                displayName: "OpenAI",
                status: "static",
                profiles: [],
                apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
              },
            ],
          },
          "usage.status": {
            updatedAt: now,
            providers: [{ provider: "openai", displayName: "OpenAI", plan: "Pro", windows: [] }],
          },
          "sessions.usage": {
            aggregates: {
              byProvider: [
                {
                  provider: "openai",
                  count: 1,
                  totals: { totalTokens: 100, totalCost: 1.25 },
                },
              ],
            },
          },
        },
      });

      try {
        const previousLoads = moduleState === "cached" ? 1 : 0;
        let previousConfigLoads = 0;
        if (moduleState === "cached") {
          await page.goto(`${server.baseUrl}settings/appearance`);
          await waitForControlUiRoute(page, { routeId: "appearance" });
          await page.locator('a[href="/settings/model-providers"]').first().click();
          await waitForControlUiRoute(page, { routeId: "model-providers" });
          await expect
            .poll(() => page.locator('[data-provider-id="openai"]').textContent())
            .toContain("$1.25");
          await page.locator('a[href="/settings/appearance"]').first().click();
          await waitForControlUiRoute(page, { routeId: "appearance" });
          await gateway.deferNext("usage.status");
          await gateway.deferNext("sessions.usage");
        }
        if (moduleState !== "cold") {
          if (moduleState === "prewarmed") {
            await page.goto(`${server.baseUrl}settings/appearance`);
          }
          await waitForControlUiRoute(page, { routeId: "appearance" });
          // Hold only the route's core request: a competing page load must not
          // share this gate and conceal the duplicate work.
          await gateway.deferNext("config.get");
          previousConfigLoads = (await gateway.getRequests("config.get")).length;
          await page.evaluate(async () => {
            const app = document.querySelector<
              HTMLElement & { runtime: { router: ApplicationRouter } }
            >("openclaw-app");
            const route = app?.runtime.router.getRoute("model-providers");
            if (!route) {
              throw new Error("Models route is unavailable");
            }
            await route.component();
          });
          await page.locator('a[href="/settings/model-providers"]').first().click();
        } else {
          expect((await page.goto(`${server.baseUrl}settings/model-providers`))?.status()).toBe(
            200,
          );
        }
        if (moduleState === "cold") {
          await gateway.waitForRequest("models.authStatus");
        } else {
          await expect
            .poll(async () => (await gateway.getRequests("config.get")).length)
            .toBeGreaterThan(previousConfigLoads);
        }
        await page.locator("openclaw-model-providers-page").waitFor();
        if (moduleState === "cached") {
          await expect
            .poll(() => page.locator('[data-provider-id="openai"]').textContent())
            .toContain("Credentials configured");
          await expect
            .poll(() => page.locator('[data-provider-id="openai"]').textContent())
            .toContain("Loading");
        }
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "route-pending.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator("openclaw-model-providers-page"),
            ]),
          );
        }
        expect(await gateway.getRequests("usage.status")).toHaveLength(previousLoads);
        expect(await gateway.getRequests("sessions.usage")).toHaveLength(previousLoads);
        await gateway.resolveDeferred(moduleState === "cold" ? "models.authStatus" : "config.get");
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        await gateway.waitForRequest("usage.status");
        await gateway.waitForRequest("sessions.usage");
        const provider = page.locator('[data-provider-id="openai"]');
        await provider.waitFor();
        await expect.poll(async () => provider.textContent()).toContain("Credentials configured");
        await expect.poll(async () => provider.textContent()).toContain("Loading");
        expect(await gateway.getRequests("usage.status")).toHaveLength(previousLoads + 1);
        expect(await gateway.getRequests("sessions.usage")).toHaveLength(previousLoads + 1);
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "before.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [provider]),
          );
        }

        await gateway.resolveDeferred("usage.status");
        await expect.poll(async () => provider.textContent()).toContain("Pro");
        expect(await provider.textContent()).not.toContain("$1.25");
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "usage-ready.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [provider]),
          );
        }

        await gateway.resolveDeferred("sessions.usage");
        await expect.poll(async () => provider.textContent()).toContain("$1.25");
        expect(await gateway.getRequests("usage.status")).toHaveLength(previousLoads + 1);
        expect(await gateway.getRequests("sessions.usage")).toHaveLength(previousLoads + 1);
        expect(await page.locator('[data-provider-id="unknown-provider"]').count()).toBe(0);
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "after.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [provider]),
          );
        }
      } finally {
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "final.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator("openclaw-model-providers-page"),
            ]),
          );
        }
        await context.close();
      }
    },
  );
});
