// Control UI browser proof covers the config snapshot and guarded-write lifecycle.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI guarded config writes mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "config-safe-write",
);

function configResponse(config: Record<string, unknown>, hash: string, appliedConfigHash = hash) {
  return {
    appliedConfigHash,
    config,
    configRevisionHash: hash,
    hash,
    issues: [],
    raw: JSON.stringify(config, null, 2),
    valid: true,
  };
}

function mutationParams(request: MockGatewayRequest): {
  baseHash?: string;
  note?: string;
  raw?: string;
  sessionKey?: string;
} {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`Expected ${request.method} mutation params`);
  }
  return params as {
    baseHash?: string;
    note?: string;
    raw?: string;
    sessionKey?: string;
  };
}

function settingsRow(page: Page, title: string): Locator {
  return page.locator(".settings-row").filter({
    has: page.locator(".settings-row__title").getByText(title, { exact: true }),
  });
}

async function capture(page: Page, name: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(uiProofArtifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(uiProofArtifactDir, name),
  });
}

suite.define(() => {
  it("edits schema and raw config with guarded set, patch, reload, and apply requests", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const initialConfig = {
          laboratory: { endpoint: "local-api", retryBudget: 2 },
          tools: { codeMode: { enabled: false } },
        };
        const patchedConfig = {
          laboratory: initialConfig.laboratory,
          tools: {},
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(initialConfig, "snapshot-1"),
            "config.schema": {
              generatedAt: "2026-08-03T00:00:00.000Z",
              schema: {
                type: "object",
                properties: {
                  laboratory: {
                    type: "object",
                    title: "Safe writes",
                    properties: {
                      endpoint: {
                        type: "string",
                        title: "Endpoint",
                        description: "Endpoint selected by the operator.",
                      },
                      retryBudget: {
                        type: "integer",
                        title: "Retry budget",
                        minimum: 0,
                        maximum: 10,
                      },
                    },
                  },
                  tools: {
                    type: "object",
                    title: "Tools",
                    additionalProperties: true,
                  },
                },
              },
              uiHints: {
                "laboratory.endpoint": { advanced: false },
                "laboratory.retryBudget": { advanced: false },
              },
              version: "e2e",
            },
          },
        });

        expect((await page.goto(`${suite.server.baseUrl}settings/labs`))?.status()).toBe(200);
        const codeModeRow = settingsRow(page, "Code Mode");
        await codeModeRow.getByRole("switch", { name: "Code Mode", exact: true }).waitFor();
        await expect.poll(() => codeModeRow.textContent()).toContain("Default: Enabled");

        const configGetsBeforePatch = (await gateway.getRequests("config.get")).length;
        await gateway.deferNext("config.patch");
        await codeModeRow.getByRole("button", { name: "Reset to default" }).click();
        const patchParams = mutationParams(await gateway.waitForRequest("config.patch"));
        expect(patchParams.baseHash).toBe("snapshot-1");
        expect(patchParams.sessionKey).toBe("main");
        expect(JSON.parse(String(patchParams.raw))).toEqual({
          tools: { codeMode: { enabled: null } },
        });

        const patchedResponse = configResponse(patchedConfig, "snapshot-2", "snapshot-1");
        await gateway.setMethodResponse("config.get", patchedResponse);
        await gateway.resolveDeferred("config.patch", {
          hash: "snapshot-2",
          ok: true,
        });
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBeGreaterThan(configGetsBeforePatch);
        await expect.poll(() => codeModeRow.textContent()).toContain("Using default: Enabled");

        expect(
          (
            await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`)
          )?.status(),
        ).toBe(200);
        const endpoint = page.getByRole("textbox", { name: "Endpoint", exact: true });
        await expect.poll(() => endpoint.inputValue()).toBe("local-api");

        await gateway.deferNext("config.set");
        await endpoint.fill("form-api");
        const staleSetParams = mutationParams(await gateway.waitForRequest("config.set"));
        expect(staleSetParams.baseHash).toBe("snapshot-2");
        expect(JSON.parse(String(staleSetParams.raw))).toMatchObject({
          laboratory: { endpoint: "form-api", retryBudget: 2 },
        });
        await gateway.rejectDeferred("config.set", {
          code: "INVALID_REQUEST",
          message: "config changed since last load; re-run config.get and retry",
        });

        const saveIndicator = page.locator("openclaw-settings-save-indicator");
        await expect
          .poll(() => saveIndicator.textContent())
          .toContain("Settings changed elsewhere");
        await expect
          .poll(() => saveIndicator.getByRole("button", { name: "Reload" }).count())
          .toBe(1);
        await capture(page, "01-base-hash-conflict.png");

        const externalConfig = {
          laboratory: { endpoint: "external-api", retryBudget: 4 },
          tools: {},
        };
        await gateway.setMethodResponse(
          "config.get",
          configResponse(externalConfig, "snapshot-3", "snapshot-1"),
        );
        const configGetsBeforeReload = (await gateway.getRequests("config.get")).length;
        await saveIndicator.getByRole("button", { name: "Reload" }).click();
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBeGreaterThan(configGetsBeforeReload);
        await expect.poll(() => endpoint.inputValue()).toBe("external-api");

        const setRequestsBeforeRetry = (await gateway.getRequests("config.set")).length;
        await endpoint.fill("form-api");
        await expect
          .poll(async () => (await gateway.getRequests("config.set")).length)
          .toBe(setRequestsBeforeRetry + 1);
        const retriedSetParams = mutationParams((await gateway.getRequests("config.set")).at(-1)!);
        expect(retriedSetParams.baseHash).toBe("snapshot-3");
        expect(JSON.parse(String(retriedSetParams.raw))).toMatchObject({
          laboratory: { endpoint: "form-api", retryBudget: 4 },
        });
        await expect.poll(() => saveIndicator.textContent()).toContain("Saved");

        await page.getByRole("button", { name: "Raw", exact: true }).click();
        const rawEditor = page.locator(".config-raw-field textarea");
        await rawEditor.waitFor();
        const rawDraft = `{
  laboratory: {
    endpoint: "raw-api",
    retryBudget: 8,
  },
  tools: {},
}
`;
        await rawEditor.fill(rawDraft);
        await capture(page, "02-raw-draft.png");

        const setRequestsBeforeRawSave = (await gateway.getRequests("config.set")).length;
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect
          .poll(async () => (await gateway.getRequests("config.set")).length)
          .toBe(setRequestsBeforeRawSave + 1);
        const rawSetParams = mutationParams((await gateway.getRequests("config.set")).at(-1)!);
        expect(rawSetParams.baseHash).toBe("mock-config-hash-1");
        expect(rawSetParams.raw).toBe(rawDraft);
        await expect
          .poll(() => page.getByRole("button", { name: "Apply changes", exact: true }).count(), {
            timeout: 5_000,
          })
          .toBe(1);
        await gateway.deferNext("config.apply");
        await page.getByRole("button", { name: "Apply changes", exact: true }).click();
        const applyParams = mutationParams(await gateway.waitForRequest("config.apply"));
        expect(applyParams.baseHash).toBe("mock-config-hash-2");
        expect(applyParams.raw).toBe(rawDraft);
        expect(applyParams.sessionKey).toBe("main");
        await expect.poll(() => saveIndicator.textContent()).toContain("Applying");
        await capture(page, "03-applying.png");

        const configGetsBeforeApply = (await gateway.getRequests("config.get")).length;
        await gateway.resolveDeferred("config.apply");
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBeGreaterThan(configGetsBeforeApply);
        await expect
          .poll(() => page.getByRole("button", { name: "Apply changes", exact: true }).count())
          .toBe(0);
        await expect.poll(() => rawEditor.inputValue()).toBe(rawDraft);
        await capture(page, "04-apply-complete.png");
      },
    );
  });
});
