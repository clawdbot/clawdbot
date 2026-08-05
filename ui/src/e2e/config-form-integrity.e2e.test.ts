// Control UI tests cover schema-backed form constraints, draft recovery, and accessible names.
import { mkdir, writeFile } from "node:fs/promises";
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
const proofVariant = process.env.OPENCLAW_UI_PROOF_VARIANT ?? "after";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "config-form-integrity",
  proofVariant,
);

let browser: Browser;
let server: ControlUiE2eServer;

function configFormIntegrityMocks() {
  const config = {
    laboratory: {
      endpoint: "local-api",
      metadata: { mode: "safe" },
      retryBudget: 4,
      weights: [2],
      codes: [],
    },
  };
  return {
    "config.get": {
      appliedConfigHash: "config-form-integrity-e2e",
      config,
      configRevisionHash: "config-form-integrity-e2e",
      hash: "config-form-integrity-e2e",
      issues: [],
      raw: JSON.stringify(config),
      valid: true,
    },
    "config.schema": {
      generatedAt: "2026-07-29T00:00:00.000Z",
      schema: {
        type: "object",
        properties: {
          laboratory: {
            type: "object",
            title: "Form Integrity",
            properties: {
              endpoint: {
                type: "string",
                title: "Endpoint slug",
                description: "Lowercase letters and hyphens only.",
                minLength: 3,
                maxLength: 16,
                pattern: "[a-z-]+",
              },
              retryBudget: {
                type: "integer",
                title: "Retry budget",
                description: "Even values from two through eight.",
                minimum: 2,
                maximum: 8,
                multipleOf: 2,
              },
              weights: {
                type: "array",
                title: "Weights",
                items: { type: "integer", minimum: 2, maximum: 8, multipleOf: 2 },
              },
              codes: {
                type: "array",
                title: "Codes",
                items: {
                  type: "string",
                  minLength: 3,
                  pattern: "^[0-9]+$",
                },
              },
            },
            additionalProperties: true,
          },
        },
      },
      uiHints: {},
      version: "e2e",
    },
  };
}

describeControlUiE2e("Control UI config form integrity mocked Gateway E2E", () => {
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

  it("keeps invalid drafts visible and exposes schema constraints to the browser", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, { methodResponses: configFormIntegrityMocks() });

    try {
      const response = await page.goto(`${server.baseUrl}settings/advanced?section=laboratory`);
      expect(response?.status()).toBe(200);

      const endpoint = page.getByRole("textbox", { name: "Endpoint slug" });
      const retryBudget = page.getByRole("spinbutton", { name: "Retry budget" });
      const weights = page.locator(".cfg-array").filter({ hasText: "Weights" });
      const addWeight = weights.getByRole("button", { name: "Add" });
      await addWeight.click();

      const metadataEditor = page.locator(".cfg-map textarea");
      await metadataEditor.fill('{"mode":');
      await metadataEditor.blur();

      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await page.locator("#config-section-panel").screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "01-invalid-json-draft.png"),
        });
      }

      await expect.poll(() => endpoint.getAttribute("minlength")).toBeNull();
      await expect.poll(() => endpoint.getAttribute("maxlength")).toBeNull();
      await expect.poll(() => endpoint.getAttribute("pattern")).toBeNull();
      await expect.poll(() => endpoint.getAttribute("aria-describedby")).not.toBeNull();
      await expect.poll(() => retryBudget.getAttribute("min")).toBe("2");
      await expect.poll(() => retryBudget.getAttribute("max")).toBe("8");
      await expect.poll(() => retryBudget.getAttribute("step")).toBe("2");
      await expect
        .poll(() => page.locator(".cfg-array input[type='number']").last().inputValue())
        .toBe("2");
      await expect.poll(() => metadataEditor.inputValue()).toBe('{"mode":');
      await expect.poll(() => metadataEditor.getAttribute("aria-invalid")).toBe("true");
      await expect.poll(() => page.getByRole("alert").textContent()).toContain("valid JSON");

      const codes = page.locator(".cfg-array").filter({ hasText: "Codes" });
      await codes.getByRole("button", { name: "Add" }).click();
      const codeDraft = codes.locator(".cfg-collection-draft");
      await expect.poll(() => codeDraft.isVisible()).toBe(true);
      const codeValue = codeDraft.getByRole("textbox", { name: "Add: Codes" });
      await codeValue.fill("abc");
      await codeDraft.getByRole("button", { name: "Add" }).click();
      await expect.poll(() => codeValue.getAttribute("aria-invalid")).toBe("true");
      await expect.poll(() => codes.locator("input[aria-label='Codes']").count()).toBe(0);

      if (captureUiProofEnabled) {
        await page.locator("#config-section-panel").screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "02-pattern-collection-draft.png"),
        });
      }

      await codeValue.fill("123");
      await codeDraft.getByRole("button", { name: "Add" }).click();
      await expect
        .poll(() => codes.locator("input[aria-label='Codes']").last().inputValue())
        .toBe("123");
    } finally {
      await context.close();
    }
  });

  it("matches rejected Settings-save errors to visible one-based model rows", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    const page = await context.newPage();
    const providerId = "z.ai";
    const config = {
      models: {
        providers: {
          [providerId]: {
            models: [{ name: "First" }, { name: "Second" }, { name: "Third" }, { name: "Fourth" }],
          },
        },
      },
    };
    const issue = {
      path: `models.providers.${providerId}.models.3.name`,
      message: "Invalid model name",
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          appliedConfigHash: "model-row-e2e",
          config,
          configRevisionHash: "model-row-e2e",
          hash: "model-row-e2e",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
        "config.schema": {
          generatedAt: "2026-08-01T00:00:00.000Z",
          schema: {
            type: "object",
            properties: {
              models: {
                type: "object",
                title: "Models",
                properties: {
                  providers: {
                    type: "object",
                    title: "Providers",
                    additionalProperties: {
                      type: "object",
                      properties: {
                        models: {
                          type: "array",
                          title: "Configured models",
                          items: {
                            type: "object",
                            properties: {
                              name: { type: "string", title: "Model name" },
                            },
                          },
                        },
                      },
                    },
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
      const response = await page.goto(`${server.baseUrl}settings/advanced?section=models`);
      expect(response?.status()).toBe(200);
      const panel = page.locator("#config-section-panel");
      const fourthRow = panel.locator(".settings-row__title").getByText("#4", { exact: true });
      await expect.poll(() => fourthRow.isVisible()).toBe(true);

      await gateway.deferNext("config.set");
      await panel.getByRole("textbox", { name: "Model name" }).nth(3).fill("Broken");
      const request = await gateway.waitForRequest("config.set");
      const params = request.params as { baseHash?: string; raw?: string };
      const submitted = JSON.parse(String(params.raw)) as {
        models: { providers: Record<string, { models: Array<{ name: string }> }> };
      };
      expect(submitted.models.providers[providerId]?.models[3]?.name).toBe("Broken");
      expect(params.baseHash).toBe("model-row-e2e");

      const rejection = {
        code: "INVALID_REQUEST",
        message: `invalid config: ${issue.path}: ${issue.message}`,
        details: { issues: [issue] },
      };
      await gateway.rejectDeferred("config.set", rejection);

      const status = page.locator('.settings-save-indicator--danger[role="status"]');
      await expect.poll(() => status.isVisible()).toBe(true);
      await expect
        .poll(() => status.getAttribute("title"))
        .toBe(
          `GatewayRequestError: invalid config: models.providers.${providerId}.models.#4.name: Invalid model name`,
        );
      expect(await status.getAttribute("aria-label")).toContain(
        `models.providers.${providerId}.models.#4.name`,
      );
      expect(await status.textContent()).toContain("Save failed");
      expect(issue.path).toBe(`models.providers.${providerId}.models.3.name`);
      expect(rejection.message).toContain(".3.name");

      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(uiProofArtifactDir, "03-model-row-rejection.png"),
        });
        await writeFile(
          path.join(uiProofArtifactDir, "03-model-row-rejection-accessibility.yml"),
          await status.ariaSnapshot(),
        );
      }
    } finally {
      await context.close();
    }
  });
});
