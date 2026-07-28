// Control UI tests cover form support for transform-backed config fields.
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

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "config-form-guidance",
);

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI config form guidance mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders every accepted branch of a transform input schema", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    const page = await context.newPage();
    const config = { update: { groupPolicy: "allowlist" } };
    await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config,
          hash: "config-form-guidance-e2e",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
        "config.schema": {
          generatedAt: "2026-07-14T00:00:00.000Z",
          schema: {
            type: "object",
            properties: {
              update: {
                type: "object",
                title: "Updates",
                properties: {
                  groupPolicy: {
                    title: "Group policy",
                    anyOf: [
                      { type: "string", enum: ["open", "allowlist", "disabled"] },
                      { type: "string", const: "allowall" },
                    ],
                  },
                },
              },
            },
          },
          uiHints: {},
          version: "e2e",
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/advanced`);
      expect(response?.status()).toBe(200);

      await page.getByRole("button", { name: "Core" }).click();
      await page.getByRole("button", { name: "Updates", exact: true }).click();

      const policyRow = page.locator(".settings-row").filter({ hasText: "Group policy" });
      await expect.poll(() => policyRow.locator("wa-radio").count()).toBe(4);
      await expect.poll(() => policyRow.getByText("open", { exact: true }).count()).toBe(1);
      await expect.poll(() => policyRow.getByText("allowlist", { exact: true }).count()).toBe(1);
      await expect.poll(() => policyRow.getByText("disabled", { exact: true }).count()).toBe(1);
      await expect.poll(() => policyRow.getByText("allowall", { exact: true }).count()).toBe(1);
      await expect
        .poll(() => page.getByText("Unsupported schema node. Use Raw mode.").count())
        .toBe(0);
      await expect
        .poll(() => page.locator(".config-content-callout .callout.info").count())
        .toBe(0);

      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(uiProofArtifactDir, "01-transform-field-supported.png"),
        });
      }

      await page.getByRole("button", { name: "Raw", exact: true }).click();
      await expect.poll(() => page.locator(".config-raw-field textarea").count()).toBe(1);
      await expect
        .poll(() => page.locator(".config-content-callout .callout.info").count())
        .toBe(0);
    } finally {
      await context.close();
    }
  });
});
