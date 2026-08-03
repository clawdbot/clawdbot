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

function notificationStatusConfigMocks() {
  const config = { ui: { prefs: { theme: "claw" } } };
  return {
    "config.get": {
      appliedConfigHash: "notification-status-e2e",
      config,
      configRevisionHash: "notification-status-e2e",
      hash: "notification-status-e2e",
      issues: [],
      raw: JSON.stringify(config),
      valid: true,
    },
    "config.schema": {
      generatedAt: "2026-07-28T00:00:00.000Z",
      schema: {
        type: "object",
        properties: {
          ui: {
            type: "object",
            title: "UI",
            properties: {
              prefs: {
                type: "object",
                title: "Prefs",
                properties: { theme: { type: "string", title: "Theme" } },
              },
            },
          },
        },
      },
      uiHints: { "ui.prefs.theme": { advanced: false } },
      version: "e2e",
    },
  };
}

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

  it("keeps the one advanced disclosure browser-local", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    const page = await context.newPage();
    const config = { ui: { prefs: { theme: "claw" } } };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          appliedConfigHash: "advanced-disclosure-e2e",
          config,
          configRevisionHash: "advanced-disclosure-e2e",
          hash: "advanced-disclosure-e2e",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
        "config.schema": {
          generatedAt: "2026-07-27T00:00:00.000Z",
          schema: {
            type: "object",
            properties: {
              ui: {
                type: "object",
                title: "UI",
                properties: {
                  seamColor: { type: "string", title: "Accent Color" },
                  prefs: {
                    type: "object",
                    title: "Prefs",
                    properties: {
                      theme: { type: "string", title: "Theme" },
                      sidebarEntries: {
                        type: "array",
                        title: "Sidebar Entries",
                        items: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          uiHints: {
            "ui.prefs.theme": { advanced: false },
            "ui.prefs.sidebarEntries": { advanced: true },
            "ui.seamColor": { advanced: true },
          },
          version: "e2e",
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      await page.getByRole("radio", { name: "UI", exact: true }).click();

      const disclosure = page.locator(".config-advanced-ghost");
      await expect.poll(() => disclosure.count()).toBe(1);
      await expect.poll(() => disclosure.textContent()).toContain("2 advanced settings hidden");
      await expect.poll(() => page.locator(".config-show-advanced").count()).toBe(1);
      await expect
        .poll(() => page.getByText("Show Advanced Settings", { exact: true }).count())
        .toBe(0);

      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(uiProofArtifactDir, "02-advanced-collapsed.png"),
        });
      }

      await disclosure.click();
      const hideAdvanced = page.locator(".config-advanced-divider__toggle");
      await expect.poll(() => hideAdvanced.count()).toBe(1);
      await expect.poll(() => hideAdvanced.textContent()).toContain("Hide Advanced");
      await expect.poll(() => disclosure.count()).toBe(0);

      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(uiProofArtifactDir, "03-advanced-expanded.png"),
        });
      }

      await hideAdvanced.click();
      await expect.poll(() => disclosure.count()).toBe(1);
      await page.waitForTimeout(750);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(uiProofArtifactDir, "04-advanced-collapsed-final.png"),
        });
      }
    } finally {
      await context.close();
    }
  });

  it("keeps a settled autosave quiet on Notifications", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: notificationStatusConfigMocks(),
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      await page.getByRole("radio", { name: "UI", exact: true }).click();

      const themeInput = page
        .locator(".settings-row")
        .filter({ hasText: "Theme" })
        .locator("input.settings-input");
      await expect.poll(() => themeInput.count()).toBe(1);
      await themeInput.fill("knot");
      await gateway.waitForRequest("config.set");
      await page.getByRole("button", { name: "Apply changes", exact: true }).click();
      await gateway.waitForRequest("config.apply");

      await page.getByRole("link", { name: "Notifications", exact: true }).click();
      await page.getByRole("heading", { name: "Push notifications", exact: true }).waitFor();

      const section = page.locator("#settings-communications-notifications");
      await expect.poll(() => page.locator(".config-toolbar").count()).toBe(0);
      await expect.poll(() => page.getByText("Saved", { exact: true }).count()).toBe(0);
      await expect
        .poll(() => section.locator(".settings-section__header .settings-status").count())
        .toBe(1);
      await expect
        .poll(() => section.locator(".settings-section__header").textContent())
        .toContain("Ready");

      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(uiProofArtifactDir, "05-notifications-ready-aligned.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
