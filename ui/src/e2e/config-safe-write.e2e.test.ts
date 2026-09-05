// Control UI browser proof covers the config snapshot and guarded-write lifecycle.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI guarded config writes mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("config-safe-write");
  }
});

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

function configSchemaResponse() {
  return {
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
          properties: {
            elevated: {
              type: "object",
              properties: {
                allowFrom: {
                  type: "object",
                  additionalProperties: {
                    type: "array",
                    items: {
                      anyOf: [{ type: "string", pattern: "^[0-9]+$" }, { type: "number" }],
                    },
                  },
                },
              },
            },
          },
          additionalProperties: true,
        },
      },
    },
    uiHints: {
      "laboratory.endpoint": { advanced: false },
      "laboratory.retryBudget": { advanced: false },
    },
    version: "e2e",
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

function overlapArea(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): number {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x),
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y),
  );
  return width * height;
}

async function capture(page: Page, name: string, content: Locator): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await writeFile(
    path.join(uiProofArtifactDir, name),
    await takeControlUiViewportScreenshot(page, page.locator(".shell"), [content]),
  );
}

suite.define(() => {
  it("retains a Raw revert when an autosave commits after its connection closes", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: uiProofArtifactDir, size: { height: 1000, width: 1440 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const initialConfig = {
          laboratory: { endpoint: "original-api", retryBudget: 2 },
          tools: {},
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(initialConfig, "revision-original"),
            "config.schema": configSchemaResponse(),
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`);
        const endpoint = page.getByRole("textbox", { name: "Endpoint", exact: true });
        await expect.poll(() => endpoint.inputValue()).toBe("original-api");
        await page.getByRole("button", { name: "Raw", exact: true }).click();
        const raw = page.locator(".config-raw-field textarea");
        const originalRaw = await raw.inputValue();
        await page.getByRole("button", { name: "Form", exact: true }).click();

        await gateway.deferNext("config.set");
        await endpoint.fill("committed-api");
        const submitted = mutationParams(await gateway.waitForRequest("config.set"));
        expect(JSON.parse(String(submitted.raw))).toMatchObject({
          laboratory: { endpoint: "committed-api" },
        });
        await page.getByRole("button", { name: "Raw", exact: true }).click();
        await raw.fill(originalRaw);
        await capture(page, "14-lost-ack-raw-revert.png", raw);

        const getsBeforeReconnect = (await gateway.getRequests("config.get")).length;
        await gateway.setOnline(false);
        // Commit through the stateful mock after closing the socket: its late
        // acknowledgment is dropped, but reconnect must observe the saved revision.
        await gateway.resolveDeferred("config.set");
        await gateway.setOnline(true);
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBe(getsBeforeReconnect + 1);
        await expect.poll(() => raw.isEnabled()).toBe(true);
        await capture(page, "15-lost-ack-retained-draft.png", raw);
        expect(await raw.inputValue()).toBe(originalRaw);
        expect(await gateway.getRequests("config.set")).toHaveLength(1);

        const saveButton = page.getByRole("button", { name: "Save", exact: true });
        await expect.poll(() => saveButton.isEnabled()).toBe(true);
        await gateway.deferNext("config.set");
        await saveButton.click();
        const saved = mutationParams(await gateway.waitForRequest("config.set", { after: 1 }));
        expect(saved.baseHash).toBe("mock-config-hash-1");
        expect(saved.raw).toBe(originalRaw);
        await gateway.resolveDeferred("config.set");
        await expect.poll(() => saveButton.isEnabled()).toBe(false);
        await expect
          .poll(() => page.getByRole("button", { name: "Apply changes", exact: true }).count())
          .toBe(1);
        await page.reload();
        await expect.poll(() => endpoint.inputValue()).toBe("original-api");
        await capture(page, "16-lost-ack-explicit-save-reload.png", endpoint);
      },
    );
  });

  it("preserves a refreshed external edit after reverting a retained Raw draft", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: uiProofArtifactDir, size: { height: 1000, width: 1440 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const initialConfig = {
          laboratory: { endpoint: "original-api", retryBudget: 2 },
          tools: {},
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(initialConfig, "revision-original"),
            "config.schema": configSchemaResponse(),
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`);
        const endpoint = page.getByRole("textbox", { name: "Endpoint", exact: true });
        await expect.poll(() => endpoint.inputValue()).toBe("original-api");
        await page.getByRole("button", { name: "Raw", exact: true }).click();
        const raw = page.locator(".config-raw-field textarea");
        const originalRaw = await raw.inputValue();
        await raw.fill(originalRaw.replace("original-api", "unsaved-api"));

        const getsBeforeReconnect = (await gateway.getRequests("config.get")).length;
        await gateway.setMethodResponse(
          "config.get",
          configResponse(
            { ...initialConfig, laboratory: { endpoint: "external-api", retryBudget: 2 } },
            "revision-external",
          ),
        );
        await gateway.setOnline(false);
        await gateway.setOnline(true);
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBe(getsBeforeReconnect + 1);
        await expect.poll(() => raw.isEnabled()).toBe(true);
        await raw.fill(originalRaw);
        await page.getByRole("button", { name: "Form", exact: true }).click();
        await endpoint.waitFor();
        await capture(page, "12-reconnect-raw-revert.png", endpoint);
        expect.soft(await endpoint.inputValue()).toBe("external-api");

        await gateway.deferNext("config.set");
        await page.getByRole("spinbutton", { name: "Retry budget", exact: true }).fill("3");
        const save = mutationParams(await gateway.waitForRequest("config.set"));
        expect(save.baseHash).toBe("revision-external");
        expect.soft(JSON.parse(String(save.raw))).toEqual({
          ...initialConfig,
          laboratory: { endpoint: "external-api", retryBudget: 3 },
        });
        await gateway.resolveDeferred("config.set");
        await expect
          .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
          .toContain("Saved");
        await page.reload();
        await endpoint.waitFor();
        await capture(page, "13-reconnect-save-reload.png", endpoint);
        expect(await endpoint.inputValue()).toBe("external-api");
      },
    );
  });

  it("restores form values when a failed edit is reverted in Raw mode", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: uiProofArtifactDir, size: { height: 1000, width: 1440 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const initialConfig = {
          laboratory: { endpoint: "saved-api", retryBudget: 2 },
          tools: {},
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(initialConfig, "revert-snapshot"),
            "config.schema": configSchemaResponse(),
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`);
        const endpoint = page.getByRole("textbox", { name: "Endpoint", exact: true });
        await expect.poll(() => endpoint.inputValue()).toBe("saved-api");

        await gateway.deferNext("config.set");
        await endpoint.fill("discarded-api");
        await gateway.waitForRequest("config.set");
        await gateway.rejectDeferred("config.set", {
          code: "UNAVAILABLE",
          message: "QA configuration save failed",
        });
        const saveIndicator = page.locator("openclaw-settings-save-indicator");
        await expect.poll(() => saveIndicator.textContent()).toContain("Save failed");
        await page.getByRole("button", { name: "Raw", exact: true }).click();
        await page
          .locator(".config-raw-field textarea")
          .fill(JSON.stringify(initialConfig, null, 2));
        await page.getByRole("button", { name: "Form", exact: true }).click();
        await endpoint.waitFor();
        await capture(page, "11-form-after-raw-revert.png", endpoint);
        expect.soft(await endpoint.inputValue()).toBe("saved-api");

        const previousSaves = (await gateway.getRequests("config.set")).length;
        await gateway.deferNext("config.set");
        await page.getByRole("spinbutton", { name: "Retry budget", exact: true }).fill("3");
        const save = mutationParams(
          await gateway.waitForRequest("config.set", { after: previousSaves }),
        );
        expect(save.baseHash).toBe("revert-snapshot");
        expect(JSON.parse(String(save.raw))).toEqual({
          ...initialConfig,
          laboratory: { endpoint: "saved-api", retryBudget: 3 },
        });
        await gateway.resolveDeferred("config.set");
        await expect.poll(() => saveIndicator.textContent()).toContain("Saved");
      },
    );
  });

  it("edits schema and raw config with guarded set, patch, reload, and apply requests", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: uiProofArtifactDir, size: { height: 1000, width: 1440 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const initialConfig = {
          laboratory: { endpoint: "local-api", retryBudget: 2 },
          tools: { codeMode: { timeoutMs: 5000 } },
        };
        const patchedConfig = {
          laboratory: initialConfig.laboratory,
          tools: { codeMode: { enabled: "auto", timeoutMs: 5000 } },
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(initialConfig, "snapshot-1"),
            "config.schema": configSchemaResponse(),
          },
        });

        expect((await page.goto(`${suite.server.baseUrl}settings/labs`))?.status()).toBe(200);
        const labsLink = page.locator('.settings-sidebar__item[href="/settings/labs"]');
        await expect.poll(() => labsLink.getAttribute("aria-current")).toBe("page");
        const codeModeRow = settingsRow(page, "Code Mode");
        const codeModeSwitch = codeModeRow.getByRole("switch", { name: "Code Mode", exact: true });
        await codeModeSwitch.waitFor();
        await expect.poll(() => codeModeRow.textContent()).toContain("Using default: Disabled");

        const configGetsBeforePatch = (await gateway.getRequests("config.get")).length;
        await gateway.deferNext("config.patch");
        await codeModeRow.locator("wa-switch").click();
        const patchParams = mutationParams(await gateway.waitForRequest("config.patch"));
        expect(patchParams.baseHash).toBe("snapshot-1");
        expect(patchParams.sessionKey).toBe("agent:main:main");
        expect(JSON.parse(String(patchParams.raw))).toEqual({
          tools: { codeMode: { enabled: "auto" } },
        });

        const patchedResponse = configResponse(patchedConfig, "snapshot-2", "snapshot-1");
        await gateway.setMethodResponse("config.get", patchedResponse);
        await gateway.resolveDeferred("config.patch", {
          hash: "snapshot-2",
          ok: true,
        });
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBe(configGetsBeforePatch + 1);
        await expect.poll(() => codeModeRow.textContent()).toContain("Default: Disabled");
        await expect.poll(() => labsLink.getAttribute("aria-current")).toBe("page");
        await capture(page, "00-labs-canonical-refresh.png", codeModeSwitch);

        expect(
          (
            await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`)
          )?.status(),
        ).toBe(200);
        const advancedLink = page.locator('.settings-sidebar__item[href="/settings/advanced"]');
        await expect.poll(() => advancedLink.getAttribute("aria-current")).toBe("page");
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
        await capture(page, "01-base-hash-conflict.png", saveIndicator);

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
        const retriedSetRequest = gateway.waitForRequest("config.set", {
          after: setRequestsBeforeRetry,
        });
        await endpoint.fill("form-api");
        const retriedSetParams = mutationParams(await retriedSetRequest);
        expect(await gateway.getRequests("config.set")).toHaveLength(setRequestsBeforeRetry + 1);
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
        const rawSave = page.getByRole("button", { name: "Save", exact: true });
        await expect.poll(() => rawSave.isEnabled()).toBe(true);
        await capture(page, "02-raw-draft.png", rawEditor);

        const setRequestsBeforeRawSave = (await gateway.getRequests("config.set")).length;
        const rawSetRequest = gateway.waitForRequest("config.set", {
          after: setRequestsBeforeRawSave,
        });
        await rawSave.click();
        const rawSetParams = mutationParams(await rawSetRequest);
        expect(await gateway.getRequests("config.set")).toHaveLength(setRequestsBeforeRawSave + 1);
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
        expect(applyParams.sessionKey).toBe("agent:main:main");
        await expect.poll(() => saveIndicator.textContent()).toContain("Applying");
        await capture(page, "03-applying.png", saveIndicator);

        const configGetsBeforeApply = (await gateway.getRequests("config.get")).length;
        await gateway.resolveDeferred("config.apply");
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBeGreaterThan(configGetsBeforeApply);
        await expect
          .poll(() => page.getByRole("button", { name: "Apply changes", exact: true }).count())
          .toBe(0);
        await expect.poll(() => rawEditor.inputValue()).toBe(rawDraft);
        await capture(page, "04-apply-complete.png", rawEditor);
      },
    );
  });

  it("refreshes config after reconnect and client replacement before the next save", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: uiProofArtifactDir, size: { height: 1000, width: 1440 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const initialConfig = {
          laboratory: { endpoint: "initial-api", retryBudget: 2 },
          tools: {},
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(initialConfig, "snapshot-initial"),
            "config.schema": configSchemaResponse(),
          },
        });

        expect(
          (
            await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`)
          )?.status(),
        ).toBe(200);
        const endpoint = page.getByRole("textbox", { name: "Endpoint", exact: true });
        await expect.poll(() => endpoint.inputValue()).toBe("initial-api");
        const initialConfigGets = (await gateway.getRequests("config.get")).length;

        await page.locator('.settings-sidebar__item[href="/settings/connection"]').click();
        await page.waitForURL(/\/settings\/connection$/u);
        const reconnectedConfig = {
          laboratory: { endpoint: "reconnected-api", retryBudget: 4 },
          tools: {},
        };
        await gateway.setMethodResponse(
          "config.get",
          configResponse(reconnectedConfig, "snapshot-reconnected"),
        );
        await gateway.setOnline(false);
        await gateway.setOnline(true);
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBe(initialConfigGets + 1);

        await page.locator('.settings-sidebar__item[href="/settings/advanced"]').click();
        await page.waitForURL(/\/settings\/advanced/u);
        await expect.poll(() => endpoint.inputValue()).toBe("reconnected-api");
        await capture(page, "05-reconnected-config.png", endpoint);

        await page.locator('.settings-sidebar__item[href="/settings/connection"]').click();
        await page.waitForURL(/\/settings\/connection$/u);
        const replacementConfig = {
          laboratory: { endpoint: "replacement-api", retryBudget: 6 },
          tools: {},
        };
        await gateway.setMethodResponse(
          "config.get",
          configResponse(replacementConfig, "snapshot-replacement"),
        );
        const configGetsBeforeReplacement = (await gateway.getRequests("config.get")).length;
        const connectsBeforeReplacement = (await gateway.getRequests("connect")).length;
        await page.getByRole("textbox", { name: "WebSocket URL" }).fill("ws://127.0.0.1:19999");
        await page.getByRole("button", { name: "Connect", exact: true }).click();
        await expect
          .poll(async () => (await gateway.getRequests("connect")).length)
          .toBe(connectsBeforeReplacement + 1);
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBe(configGetsBeforeReplacement + 1);

        await page.locator('.settings-sidebar__item[href="/settings/advanced"]').click();
        await page.waitForURL(/\/settings\/advanced/u);
        await expect.poll(() => endpoint.inputValue()).toBe("replacement-api");
        await gateway.deferNext("config.set");
        const setsBeforeEdit = (await gateway.getRequests("config.set")).length;
        await endpoint.fill("saved-on-replacement");
        const save = mutationParams(await gateway.waitForRequest("config.set"));
        expect(save.baseHash).toBe("snapshot-replacement");
        expect(JSON.parse(String(save.raw))).toEqual({
          laboratory: { endpoint: "saved-on-replacement", retryBudget: 6 },
          tools: {},
        });
        expect(await gateway.getRequests("config.set")).toHaveLength(setsBeforeEdit + 1);
        await gateway.resolveDeferred("config.set", { hash: "snapshot-saved" });
        await expect
          .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
          .toContain("Saved");
        await capture(page, "06-replacement-save.png", endpoint);
      },
    );
  });

  it("keeps a dirty draft and adopts an opaque revision after an unchanged reconnect", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: uiProofArtifactDir, size: { height: 1000, width: 1440 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const config = {
          laboratory: { endpoint: "initial-api", retryBudget: 2 },
          tools: {},
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(config, "legacy-raw-hash"),
            "config.schema": configSchemaResponse(),
          },
        });

        expect(
          (
            await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`)
          )?.status(),
        ).toBe(200);
        const endpoint = page.getByRole("textbox", { name: "Endpoint", exact: true });
        await expect.poll(() => endpoint.inputValue()).toBe("initial-api");
        await endpoint.fill("retained-draft");

        const getsBeforeReconnect = (await gateway.getRequests("config.get")).length;
        await gateway.setMethodResponse(
          "config.get",
          configResponse(config, "hmac-sha256:v1:opaque-current"),
        );
        await gateway.setOnline(false);
        await gateway.setOnline(true);
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBe(getsBeforeReconnect + 1);
        await expect.poll(() => endpoint.inputValue()).toBe("retained-draft");

        const saveIndicator = page.locator("openclaw-settings-save-indicator");
        await expect
          .poll(() => saveIndicator.textContent())
          .toContain("Autosave paused after reconnect");
        const saveButton = saveIndicator.getByRole("button", { name: "Save", exact: true });
        const buildLink = page.locator(".settings-sidebar__footer .sidebar-footer-build");
        await saveButton.focus();
        await expect
          .poll(() => saveButton.evaluate((element) => element === document.activeElement))
          .toBe(true);
        const [saveBounds, buildBounds] = await Promise.all([
          saveButton.boundingBox(),
          buildLink.boundingBox(),
        ]);
        expect(saveBounds).not.toBeNull();
        expect(buildBounds).not.toBeNull();
        if (!saveBounds || !buildBounds) {
          throw new Error("Expected visible settings footer controls");
        }
        expect(overlapArea(saveBounds, buildBounds)).toBe(0);
        expect(await buildLink.textContent()).not.toBe("");
        await capture(page, "07-opaque-revision-reconnect.png", saveButton);

        await page.setViewportSize({ height: 900, width: 1280 });
        const [narrowSaveBounds, narrowBuildBounds] = await Promise.all([
          saveButton.boundingBox(),
          buildLink.boundingBox(),
        ]);
        expect(narrowSaveBounds).not.toBeNull();
        expect(narrowBuildBounds).not.toBeNull();
        if (!narrowSaveBounds || !narrowBuildBounds) {
          throw new Error("Expected visible settings footer controls at 1280px");
        }
        expect(overlapArea(narrowSaveBounds, narrowBuildBounds)).toBe(0);
        await capture(page, "07-opaque-revision-reconnect-1280.png", saveButton);

        await gateway.deferNext("config.set");
        await saveButton.click();
        const save = mutationParams(await gateway.waitForRequest("config.set"));
        expect(save.baseHash).toBe("hmac-sha256:v1:opaque-current");
        expect(JSON.parse(String(save.raw))).toMatchObject({
          laboratory: { endpoint: "retained-draft", retryBudget: 2 },
        });
        await gateway.setMethodResponse(
          "config.get",
          configResponse(
            { ...config, laboratory: { ...config.laboratory, endpoint: "retained-draft" } },
            "hmac-sha256:v1:opaque-next",
          ),
        );
        await gateway.resolveDeferred("config.set", { hash: "hmac-sha256:v1:opaque-next" });
        await expect.poll(() => endpoint.inputValue()).toBe("retained-draft");
      },
    );
  });

  it("preserves untouched 64-bit identifier strings during an unrelated form save", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: uiProofArtifactDir, size: { height: 1000, width: 1440 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const identifier = "1048113311314608148";
        const initialConfig = {
          laboratory: { endpoint: "before-save", retryBudget: 2 },
          tools: { elevated: { allowFrom: { discord: [identifier, 42] } } },
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(initialConfig, "id-snapshot-1"),
            "config.schema": configSchemaResponse(),
          },
        });

        expect(
          (
            await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`)
          )?.status(),
        ).toBe(200);
        const endpoint = page.getByRole("textbox", { name: "Endpoint", exact: true });
        await expect.poll(() => endpoint.inputValue()).toBe("before-save");
        await capture(page, "08-id-before-unrelated-save.png", endpoint);

        await gateway.deferNext("config.set");
        await endpoint.fill("after-save");
        const save = mutationParams(await gateway.waitForRequest("config.set"));
        const submitted = JSON.parse(String(save.raw)) as typeof initialConfig;
        expect(save.baseHash).toBe("id-snapshot-1");
        expect(String(save.raw)).toContain(`"${identifier}"`);
        expect(String(save.raw)).not.toContain(String(Number(identifier)));
        expect(submitted).toEqual({
          laboratory: { endpoint: "after-save", retryBudget: 2 },
          tools: { elevated: { allowFrom: { discord: [identifier, 42] } } },
        });
        expect(submitted.tools.elevated.allowFrom.discord[0]).toBe(identifier);
        expect(typeof submitted.tools.elevated.allowFrom.discord[0]).toBe("string");

        if (captureUiProofEnabled) {
          await writeFile(
            path.join(uiProofArtifactDir, "09-id-config-set-payload.json"),
            `${JSON.stringify({ before: initialConfig, submitted }, null, 2)}\n`,
          );
        }
        await gateway.resolveDeferred("config.set");
        const saveIndicator = page.locator("openclaw-settings-save-indicator");
        await expect.poll(() => saveIndicator.textContent()).toContain("Saved");

        await page.reload();
        await expect.poll(() => endpoint.inputValue()).toBe("after-save");
        await page.getByRole("button", { name: "Raw", exact: true }).click();
        const rawEditor = page.locator(".config-raw-field textarea");
        await rawEditor.waitFor();
        await expect.poll(() => rawEditor.inputValue()).toContain(`"${identifier}"`);
        await capture(page, "10-id-after-unrelated-save.png", rawEditor);
      },
    );
  });
});
