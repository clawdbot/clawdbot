// Control UI tests cover Memory default provenance and clearing optional overrides.
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Memory defaults mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("memory-settings-defaults");
  }
});

const memoryPlugins = [
  {
    id: "memory-core",
    name: "memory-core",
    installed: true,
    enabled: true,
    state: "enabled",
    kind: ["memory"],
  },
  {
    id: "memory-lancedb",
    name: "Memory LanceDB",
    installed: true,
    enabled: true,
    state: "enabled",
    kind: ["memory"],
  },
];

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config.set params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
}

function settingsRow(page: Page, title: string): Locator {
  return page.locator(".settings-row").filter({
    has: page.locator(".settings-row__title").getByText(title, { exact: true }),
  });
}

function scheduleSection(page: Page): Locator {
  return page.locator(".settings-section").filter({
    has: page.locator(".settings-section__heading").getByText("Schedule", { exact: true }),
  });
}

async function captureProof(page: Page, name: string, locator?: Locator) {
  if (!captureUiProofEnabled) {
    return;
  }
  await locator?.scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: path.join(uiProofArtifactDir, name),
  });
}

suite.define(() => {
  it("persists a cleared dreaming frequency and preserves the explicit engine across reload", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const config = {
          agents: { defaults: { userTimezone: "Asia/Singapore" } },
          plugins: {
            slots: { memory: "memory-core" },
            entries: {
              "memory-core": {
                config: {
                  dreaming: {
                    frequency: "0 6 * * *",
                    verboseLogging: true,
                  },
                },
              },
            },
          },
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              config,
              hash: "memory-defaults-e2e",
              appliedConfigHash: "memory-defaults-e2e",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "plugins.list": {
              plugins: memoryPlugins,
              diagnostics: [],
              mutationAllowed: true,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
        expect(response?.status()).toBe(200);

        const engineRow = settingsRow(page, "Memory engine");
        const frequencyRow = settingsRow(page, "Dreaming frequency");
        await expect.poll(() => engineRow.textContent()).toContain("Default: OpenClaw Memory");
        await expect.poll(() => frequencyRow.textContent()).toContain("Default: 0 3 * * *");
        await expect.poll(() => frequencyRow.getByRole("textbox").inputValue()).toBe("0 6 * * *");

        await captureProof(page, "01-explicit-engine.png");
        await captureProof(page, "02-explicit-dreaming.png", scheduleSection(page));

        await frequencyRow.getByRole("textbox").fill("");
        await frequencyRow.getByRole("textbox").blur();

        const saved = requestRaw(await gateway.waitForRequest("config.set"));
        expect(saved).toHaveProperty("plugins.slots.memory", "memory-core");
        expect(saved).not.toHaveProperty("plugins.entries.memory-core.config.dreaming.frequency");
        expect(saved).toHaveProperty(
          "plugins.entries.memory-core.config.dreaming.verboseLogging",
          true,
        );
        await expect
          .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
          .toContain("Saved");

        await page.reload();
        const reloadedEngineRow = settingsRow(page, "Memory engine");
        const reloadedFrequencyRow = settingsRow(page, "Dreaming frequency");
        await expect
          .poll(() => reloadedEngineRow.textContent())
          .toContain("Default: OpenClaw Memory");
        await expect
          .poll(() => reloadedFrequencyRow.textContent())
          .toContain("Using default: 0 3 * * *");
        await expect.poll(() => reloadedFrequencyRow.getByRole("textbox").inputValue()).toBe("");
        await expect
          .poll(() => reloadedFrequencyRow.getByRole("textbox").getAttribute("placeholder"))
          .toBe("0 3 * * *");
        await captureProof(page, "03-preserved-engine.png");
        await captureProof(page, "04-inherited-dreaming.png", scheduleSection(page));
      },
    );
  });
});
