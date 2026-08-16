// Control UI tests cover memory engine ordering and serialized config writes.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI memory engine settings mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "memory-settings-engine",
);

function configResponse(engineId: string, hash: string) {
  const config = { plugins: { slots: { memory: engineId } } };
  return {
    config,
    hash,
    appliedConfigHash: hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

const memoryPlugins = [
  {
    id: "memory-lancedb",
    name: "Memory LanceDB",
    installed: true,
    enabled: true,
    state: "enabled",
    kind: ["memory"],
  },
  {
    id: "memory-core",
    // The UI owns this product label; catalog ids/names are implementation detail.
    name: "memory-core",
    installed: true,
    enabled: true,
    state: "enabled",
    kind: ["memory"],
  },
];

suite.define(() => {
  it("keeps the default engine first and drains Off before selecting it", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const initialConfig = configResponse("memory-lancedb", "memory-hash-1");
        const selectedConfig = configResponse("memory-core", "memory-hash-2");
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": initialConfig,
            "plugins.list": { plugins: memoryPlugins, diagnostics: [], mutationAllowed: true },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
        expect(response?.status()).toBe(200);

        const engineGroup = page.locator("wa-radio-group.settings-segmented").first();
        await engineGroup.waitFor();
        await expect
          .poll(async () =>
            (await engineGroup.locator("wa-radio").allTextContents()).map((label) => label.trim()),
          )
          .toEqual(["OpenClaw Memory", "Memory LanceDB", "Off"]);

        await gateway.deferNext("config.set");
        await gateway.deferNext("plugins.setEnabled");
        await engineGroup.getByRole("radio", { name: "Off", exact: true }).click();
        // Click again immediately, before the 800 ms autosave debounce. The
        // write barrier must flush Off first instead of letting the plugin RPC
        // race a still-scheduled config.set.
        await engineGroup.getByRole("radio", { name: "OpenClaw Memory", exact: true }).click();
        expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);

        const pendingOffSave = await gateway.waitForRequest("config.set");
        expect(pendingOffSave.params).toMatchObject({ baseHash: "memory-hash-1" });
        if (captureUiProofEnabled) {
          await mkdir(uiProofArtifactDir, { recursive: true });
          await page
            .locator(".settings-page > .settings-section")
            .first()
            .screenshot({
              animations: "disabled",
              path: path.join(uiProofArtifactDir, "00-off-write-draining.png"),
            });
        }
        await gateway.resolveDeferred("config.set", { ok: true, hash: "mock-config-hash-1" });
        const enableRequest = await gateway.waitForRequest("plugins.setEnabled");
        expect(enableRequest.params).toEqual({ pluginId: "memory-core", enabled: true });

        await gateway.setMethodResponse("config.get", selectedConfig);
        await gateway.resolveDeferred("plugins.setEnabled", {
          ok: true,
          plugin: memoryPlugins[1],
          restartRequired: false,
        });

        const selected = engineGroup.getByRole("radio", {
          name: "OpenClaw Memory",
          exact: true,
        });
        await expect.poll(() => selected.getAttribute("aria-checked")).toBe("true");
        await expect
          .poll(() => page.getByText("Could not change the memory engine").count())
          .toBe(0);

        if (captureUiProofEnabled) {
          await mkdir(uiProofArtifactDir, { recursive: true });
          await page
            .locator(".settings-page > .settings-section")
            .first()
            .screenshot({
              animations: "disabled",
              path: path.join(uiProofArtifactDir, "01-openclaw-memory-selected.png"),
            });
        }
      },
    );
  });

  it("keeps a committed add-on enabled and makes a failed config refresh visible", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const activeMemory = {
          id: "active-memory",
          name: "Active memory",
          installed: true,
          enabled: false,
          state: "disabled",
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse("memory-lancedb", "memory-refresh-hash-1"),
            "plugins.list": {
              plugins: [...memoryPlugins, activeMemory],
              diagnostics: [],
              mutationAllowed: true,
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
        const toggle = page.getByRole("switch", { name: "Enable or disable Active memory" });
        await toggle.waitFor();
        const initialConfigReads = (await gateway.getRequests("config.get")).length;
        const initialCatalogReads = (await gateway.getRequests("plugins.list")).length;
        await gateway.deferNext("plugins.setEnabled");
        await gateway.deferNext("config.get");
        await page
          .locator("wa-switch.settings-toggle")
          .filter({ hasText: "Enable or disable Active memory" })
          .click();

        const mutation = await gateway.waitForRequest("plugins.setEnabled");
        expect(mutation.params).toEqual({ pluginId: "active-memory", enabled: true });
        const committed = { ...activeMemory, enabled: true, state: "enabled" };
        await gateway.setMethodResponse("plugins.list", {
          plugins: [...memoryPlugins, committed],
          diagnostics: [],
          mutationAllowed: true,
        });
        await gateway.resolveDeferred("plugins.setEnabled", {
          ok: true,
          plugin: committed,
          restartRequired: false,
        });
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBeGreaterThan(initialConfigReads);
        await gateway.rejectDeferred("config.get", {
          code: "UNAVAILABLE",
          message: "authoritative snapshot unavailable",
        });

        await expect
          .poll(async () => (await gateway.getRequests("plugins.list")).length)
          .toBeGreaterThan(initialCatalogReads);
        await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("true");
        await page.getByText("Needs attention", { exact: true }).first().waitFor();
        await page
          .getByText(
            "Could not refresh Control UI configuration: GatewayRequestError: authoritative snapshot unavailable",
          )
          .waitFor();
        expect(await page.getByText("Could not update Active memory").count()).toBe(0);
        expect(pageErrors).toEqual([]);

        if (captureUiProofEnabled) {
          await mkdir(uiProofArtifactDir, { recursive: true });
          await page.locator("openclaw-memory-settings").screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "03-addon-committed-refresh-warning.png"),
          });
        }
      },
    );
  });

  it("keeps a missing default engine labelled, first, and selected as unavailable", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse("memory-core", "memory-hash-missing-default"),
            "plugins.list": {
              plugins: memoryPlugins.filter((plugin) => plugin.id !== "memory-core"),
              diagnostics: [],
              mutationAllowed: true,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
        expect(response?.status()).toBe(200);

        const engineGroup = page.locator("wa-radio-group.settings-segmented").first();
        await engineGroup.waitFor();
        await expect
          .poll(async () =>
            (await engineGroup.locator("wa-radio").allTextContents()).map((label) => label.trim()),
          )
          .toEqual(["OpenClaw Memory (Unavailable)", "Memory LanceDB", "Off"]);
        await expect
          .poll(() =>
            engineGroup
              .getByRole("radio", { name: "OpenClaw Memory (Unavailable)", exact: true })
              .getAttribute("aria-checked"),
          )
          .toBe("true");

        if (captureUiProofEnabled) {
          await mkdir(uiProofArtifactDir, { recursive: true });
          await page
            .locator(".settings-page > .settings-section")
            .first()
            .screenshot({
              animations: "disabled",
              path: path.join(uiProofArtifactDir, "02-configured-engine-unavailable.png"),
            });
        }
      },
    );
  });
});
