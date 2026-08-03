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
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.resolve(".artifacts/control-ui-e2e/control-ui-debug-diagnostics");

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI Debug diagnostics mocked Gateway E2E", () => {
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

  it("renders status, health, heartbeat, and model snapshots from the Gateway", async () => {
    if (captureUiProof) {
      await mkdir(path.join(proofDir, "video"), { recursive: true });
    }
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
      ...(captureUiProof
        ? {
            recordVideo: { dir: path.join(proofDir, "video"), size: { height: 1000, width: 1280 } },
          }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        status: {
          runtime: "diagnostics-e2e",
          securityAudit: { summary: { critical: 0, warn: 1, info: 2 } },
        },
        health: { ok: true, gateway: "healthy" },
        "models.list": {
          models: [
            {
              available: true,
              id: "gpt-5.6-luna",
              name: "GPT-5.6 Luna",
              provider: "openai",
            },
          ],
        },
        "last-heartbeat": { ageMs: 1250, source: "gateway-heartbeat" },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}debug`);
      expect(response?.status()).toBe(200);
      await page.locator(".page-title", { hasText: "Debug" }).waitFor();
      const snapshots = page.locator(".settings-section", {
        has: page.getByRole("heading", { name: "Snapshots" }),
      });
      await snapshots.waitFor();
      await expect.poll(() => snapshots.textContent()).toContain("1 warning");
      await expect.poll(() => snapshots.textContent()).toContain("diagnostics-e2e");
      await expect.poll(() => snapshots.textContent()).toContain("healthy");
      await expect.poll(() => snapshots.textContent()).toContain("gateway-heartbeat");
      const models = page.locator(".settings-section", {
        has: page.getByRole("heading", { name: "Models" }),
      });
      await expect.poll(() => models.textContent()).toContain("gpt-5.6-luna");

      for (const method of ["status", "health", "models.list", "last-heartbeat"]) {
        const requests = await gateway.getRequests(method);
        expect(requests.length).toBeGreaterThanOrEqual(1);
        expect(requests[0]?.params).toEqual({});
      }

      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "diagnostic-snapshots.png"),
        });
        await models.scrollIntoViewIfNeeded();
        await page.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "models-snapshot.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
