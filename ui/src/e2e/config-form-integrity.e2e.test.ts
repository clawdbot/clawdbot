// Control UI tests cover schema-backed form constraints, draft recovery, and accessible names.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI config form integrity mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofVariant = process.env.OPENCLAW_UI_PROOF_VARIANT ?? "after";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir(`config-form-integrity-${proofVariant}`);
  }
});

function configFormIntegrityMocks() {
  const config = {
    laboratory: {
      endpoint: "local-api",
      metadata: { mode: "safe" },
      retryBudget: 4,
      countOrFlag: 6,
      privateCount: 6,
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
              countOrFlag: {
                title: "Count or flag",
                anyOf: [{ type: "integer" }, { type: "boolean" }],
              },
              privateCount: {
                title: "Private count",
                anyOf: [{ type: "integer" }, { type: "boolean" }],
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
      uiHints: { "laboratory.privateCount": { sensitive: true } },
      version: "e2e",
    },
  };
}

suite.define(() => {
  it.each([
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ])("keeps numeric-array adjusters beside the input at $width px", async (viewport) => {
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", serviceWorkers: "block", viewport },
      async ({ page }) => {
        const fixture = configFormIntegrityMocks();
        const gateway = await installMockGateway(page, { methodResponses: fixture });
        const response = await page.goto(
          `${suite.server.baseUrl}settings/advanced?section=laboratory`,
        );
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("config.get");
        await gateway.waitForRequest("config.schema");

        const weights = page.locator(".cfg-array").filter({ hasText: "Weights" });
        const input = weights.getByRole("spinbutton");
        const decrease = weights.getByRole("button", { name: /: -2$/ });
        const increase = weights.getByRole("button", { name: /: \+2$/ });
        const retryBudget = page.getByRole("spinbutton", { name: "Retry budget" });
        const countOrFlag = page.getByRole("spinbutton", { name: "Count or flag" });
        const privateCount = page.getByRole("spinbutton", { name: "Private count" });
        const endpoint = page.getByRole("textbox", { name: "Endpoint slug" });
        for (const control of [
          input,
          decrease,
          increase,
          retryBudget,
          countOrFlag,
          privateCount,
          endpoint,
        ]) {
          await expect.poll(() => control.count()).toBe(1);
          await expect.poll(() => control.isVisible()).toBe(true);
        }
        expect(await input.inputValue()).toBe("2");
        expect(await retryBudget.inputValue()).toBe("4");
        expect(await countOrFlag.inputValue()).toBe("6");
        expect(await privateCount.inputValue()).toBe("");
        expect(
          await privateCount.evaluate(
            (element) => element instanceof HTMLInputElement && element.readOnly,
          ),
        ).toBe(true);
        for (const control of [input, retryBudget]) {
          expect(await control.getAttribute("min")).toBe("2");
          expect(await control.getAttribute("max")).toBe("8");
          expect(await control.getAttribute("step")).toBe("2");
        }
        expect(await gateway.getRequests("config.set")).toHaveLength(0);

        const measure = async (controls: Locator[]) => {
          const [minus, field, plus] = await Promise.all(
            controls.map((control) => control.boundingBox()),
          );
          if (!minus || !field || !plus) {
            throw new Error("Numeric adjusters and input must all have visible bounds");
          }
          for (const box of [minus, field, plus]) {
            expect(box.width).toBeGreaterThan(0);
            expect(box.height).toBeGreaterThan(0);
          }
          return { minus, field, plus };
        };
        const nativeValidation = () =>
          input.evaluate((element) => {
            if (!(element instanceof HTMLInputElement)) {
              throw new Error("Numeric field must be a native input");
            }
            return {
              valid: element.validity.valid,
              message: element.validationMessage,
              focused: element.matches(":focus"),
              borderColor: getComputedStyle(element).borderTopColor,
            };
          });
        const measureInputStyle = (control: Locator) =>
          control.evaluate((element) => {
            if (!(element instanceof HTMLInputElement)) {
              throw new Error("Form value must be a native input");
            }
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const toggle = element.parentElement?.querySelector(".settings-secret__toggle");
            const toggleBox = toggle?.getBoundingClientRect();
            return {
              width: box.width,
              paddingLeft: Number.parseFloat(style.paddingLeft),
              paddingRight: Number.parseFloat(style.paddingRight),
              textAlign: style.textAlign,
              toggle: toggleBox
                ? { width: toggleBox.width, rightInset: box.right - toggleBox.right }
                : null,
            };
          });
        const measureInputStyles = async () => ({
          plain: await measureInputStyle(endpoint),
          numberUnion: await measureInputStyle(countOrFlag),
          sensitiveNumberUnion: await measureInputStyle(privateCount),
        });
        const observations: Array<{
          phase: string;
          value: string;
          invalid: string | null;
          validation: Awaited<ReturnType<typeof nativeValidation>>;
          array: Awaited<ReturnType<typeof measure>>;
          ordinary: Awaited<ReturnType<typeof measure>>;
          ordinaryControlRight: number;
          inputStyles: Awaited<ReturnType<typeof measureInputStyles>>;
        }> = [];
        const capture = async (phase: string) => {
          await weights.scrollIntoViewIfNeeded();
          observations.push({
            phase,
            value: await input.inputValue(),
            invalid: await input.getAttribute("aria-invalid"),
            validation: await nativeValidation(),
            inputStyles: await measureInputStyles(),
            array: await measure([decrease, input, increase]),
            ordinary: await measure([
              page.getByRole("button", { name: "Retry budget: -2", exact: true }),
              retryBudget,
              page.getByRole("button", { name: "Retry budget: +2", exact: true }),
            ]),
            ordinaryControlRight: await retryBudget.evaluate((element) => {
              const control = element.closest(".settings-row__control");
              if (!(control instanceof HTMLElement) || control.getBoundingClientRect().width <= 0) {
                throw new Error("Ordinary field must have a visible Settings control container");
              }
              return control.getBoundingClientRect().right;
            }),
          });
          if (captureUiProofEnabled) {
            await writeFile(
              path.join(uiProofArtifactDir, `numeric-array-${viewport.width}.json`),
              JSON.stringify(
                { viewport, observations, writes: await gateway.getRequests("config.set") },
                null,
                2,
              ),
            );
            await page.locator("#config-section-panel").screenshot({
              animations: "disabled",
              path: path.join(uiProofArtifactDir, `numeric-array-${viewport.width}-${phase}.png`),
            });
          }
        };

        await capture("initial");
        await input.fill("3");
        await expect.poll(() => input.getAttribute("aria-invalid")).toBe("true");
        expect(await input.inputValue()).toBe("3");
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        const error = weights.getByRole("alert", { includeHidden: true });
        await expect.poll(() => error.count()).toBe(1);
        await expect.poll(() => error.isVisible()).toBe(true);
        const errorId = await error.getAttribute("id");
        if (!errorId) {
          throw new Error("Validation feedback must have an accessible description id");
        }
        expect((await input.getAttribute("aria-describedby"))?.split(/\s+/)).toContain(errorId);
        const invalid = await nativeValidation();
        expect(invalid.valid).toBe(false);
        expect(invalid.message).not.toBe("");
        expect(await error.textContent()).toBe(invalid.message);
        await capture("invalid");

        await gateway.deferNext("config.set");
        await input.fill("4");
        const request = await gateway.waitForRequest("config.set");
        const params = request.params;
        if (
          !params ||
          typeof params !== "object" ||
          !("raw" in params) ||
          typeof params.raw !== "string"
        ) {
          throw new Error("Settings save must carry the serialized config");
        }
        expect(JSON.parse(params.raw)).toEqual({
          laboratory: { ...fixture["config.get"].config.laboratory, weights: [4] },
        });
        await gateway.resolveDeferred("config.set");
        await expect.poll(() => input.isEnabled()).toBe(true);
        await expect.poll(() => input.getAttribute("aria-invalid")).toBe("false");
        expect(await input.inputValue()).toBe("4");
        expect(await gateway.getRequests("config.set")).toHaveLength(1);
        expect((await nativeValidation()).valid).toBe(true);
        expect((await nativeValidation()).message).toBe("");
        expect(await error.isVisible()).toBe(false);
        expect(await error.textContent()).toBe("");
        await input.press("Tab");
        await expect.poll(async () => (await nativeValidation()).focused).toBe(false);
        await expect
          .poll(async () => (await nativeValidation()).borderColor)
          .toBe(await retryBudget.evaluate((element) => getComputedStyle(element).borderTopColor));
        expect(await gateway.getRequests("config.set")).toHaveLength(1);
        await capture("corrected");

        // Measure after the real draft/save path so a layout failure retains its behavior evidence.
        for (const observation of observations) {
          const { plain, numberUnion, sensitiveNumberUnion } = observation.inputStyles;
          for (const field of [plain, numberUnion]) {
            expect(field.toggle).toBeNull();
            expect(field.paddingRight).toBe(field.paddingLeft);
          }
          for (const field of [numberUnion, sensitiveNumberUnion]) {
            expect(Math.abs(field.width - 110)).toBeLessThanOrEqual(1);
            expect(field.textAlign).toBe("center");
          }
          const toggle = sensitiveNumberUnion.toggle;
          if (!toggle) {
            throw new Error("Sensitive number must retain its inset reveal toggle");
          }
          expect(toggle.width).toBeGreaterThan(0);
          expect(toggle.rightInset).toBeGreaterThanOrEqual(0);
          expect(sensitiveNumberUnion.paddingRight).toBeGreaterThan(
            toggle.width + toggle.rightInset,
          );
          expect(
            Math.abs(
              observation.ordinary.plus.x +
                observation.ordinary.plus.width -
                observation.ordinaryControlRight,
            ),
          ).toBeLessThanOrEqual(1);
          for (const layout of [observation.ordinary, observation.array]) {
            const centers = [layout.minus, layout.field, layout.plus].map(
              (box) => box.y + box.height / 2,
            );
            expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
            expect(layout.field.x).toBeGreaterThanOrEqual(layout.minus.x + layout.minus.width);
            expect(layout.plus.x).toBeGreaterThanOrEqual(layout.field.x + layout.field.width);
          }
        }
      },
    );
  });

  it("round-trips Agent List model overrides through the complete Gateway schema", async () => {
    const { buildConfigSchemaCore } = await import("../../../src/config/schema.ts");
    const schema = buildConfigSchemaCore();
    const config = (codeMode?: boolean) => ({
      agents: {
        entries: {
          main: {
            name: "Form proof",
            models: {
              "openai/gpt-5.6-sol": {
                alias: "coding",
                params: { temperature: 0.5 },
                agentRuntime: { id: "openclaw" },
                streaming: false,
                ...(codeMode === undefined ? {} : { codeMode }),
              },
            },
            tools: { codeMode: { enabled: "auto", maxOutputBytes: 4096 } },
          },
        },
      },
      tools: { codeMode: false },
    });
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const initial = config();
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              appliedConfigHash: "agent-list-initial",
              config: initial,
              configRevisionHash: "agent-list-initial",
              hash: "agent-list-initial",
              issues: [],
              raw: JSON.stringify(initial),
              valid: true,
            },
            "config.schema": schema,
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/agents`);
        await page
          .getByRole("button", {
            name: "Agent defaults Defaults every agent inherits unless overridden.",
          })
          .click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/ai-agents");
        await page.goto(`${suite.server.baseUrl}settings/ai-agents?section=agents&advanced=1`);

        const reveal = async (control: Locator) => {
          await expect.poll(() => control.count()).toBe(1);
          for (const details of await control.locator("xpath=ancestor::details").all()) {
            if ((await details.getAttribute("open")) === null) {
              await details.locator(":scope > summary").click();
            }
          }
          await expect.poll(() => control.isVisible()).toBe(true);
        };
        const mode = page.locator('select[aria-label="Code Mode"]');
        await reveal(mode);
        expect(
          (await mode.locator("option").allTextContents()).map((label) => label.trim()),
        ).toEqual(["Default", "On", "Off"]);
        expect((await mode.locator("option:checked").textContent())?.trim()).toBe("Default");
        const rawOnly = page.locator(".settings-row").filter({
          has: page.locator(".settings-row__title").getByText("Agent Code Mode", { exact: true }),
        });
        expect(await rawOnly.textContent()).toContain("Unsupported schema node. Use Raw mode.");
        expect(await rawOnly.locator("input,select,textarea").count()).toBe(0);

        const agentKey = page.locator('input[aria-label="Key: main"]').first();
        await reveal(agentKey);
        await agentKey.fill("bad/agent");
        await agentKey.blur();
        await expect.poll(() => agentKey.inputValue()).toBe("main");

        for (const [label, value] of [
          ["On", true],
          ["Off", false],
          ["Default", undefined],
        ] as const) {
          const before = (await gateway.getRequests("config.set")).length;
          await gateway.deferNext("config.set");
          await mode.selectOption({ label });
          const request = await gateway.waitForRequest("config.set", { after: before });
          const params = request.params as { raw?: string };
          expect(JSON.parse(String(params.raw))).toEqual(config(value));
          await gateway.resolveDeferred("config.set");
          await expect.poll(() => mode.isEnabled()).toBe(true);
          expect(await gateway.getRequests("config.set")).toHaveLength(before + 1);
          await page.reload();
          await reveal(mode);
          expect((await mode.locator("option:checked").textContent())?.trim()).toBe(label);
        }
        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(uiProofArtifactDir, "04-agent-list-model-overrides.png"),
          });
        }
      },
    );
  });

  it("keeps invalid drafts visible and exposes schema constraints to the browser", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        await installMockGateway(page, { methodResponses: configFormIntegrityMocks() });

        const response = await page.goto(
          `${suite.server.baseUrl}settings/advanced?section=laboratory`,
        );
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
      },
    );
  });

  it("matches rejected Settings-save errors to visible one-based model rows", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const providerId = "z.ai";
        const config = {
          models: {
            providers: {
              [providerId]: {
                models: [
                  { name: "First" },
                  { name: "Second" },
                  { name: "Third" },
                  { name: "Fourth" },
                ],
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

        const response = await page.goto(`${suite.server.baseUrl}settings/advanced?section=models`);
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
      },
    );
  });
});
