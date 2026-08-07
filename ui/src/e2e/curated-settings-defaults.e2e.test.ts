// Control UI tests cover inherited defaults across curated settings pages.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI curated settings defaults mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "curated-settings-defaults",
);

function configResponse(config: Record<string, unknown>, hash: string) {
  return {
    appliedConfigHash: hash,
    config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config mutation params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
}

function hasOwnPath(value: Record<string, unknown>, pathSegments: readonly string[]): boolean {
  let current: unknown = value;
  for (const [index, segment] of pathSegments.entries()) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return false;
    }
    if (!Object.hasOwn(current, segment)) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
    if (index === pathSegments.length - 1) {
      return true;
    }
  }
  return false;
}

function settingsRow(page: Page, title: string): Locator {
  return page.locator(".settings-row").filter({
    has: page.locator(".settings-row__title", { hasText: title }),
  });
}

async function expectInherited(row: Locator, value: string) {
  await expect.poll(() => row.textContent()).toContain(`Using default: ${value}`);
  await expect.poll(() => row.getByRole("button", { name: "Reset to default" }).count()).toBe(0);
}

suite.define(() => {
  it("restores Labs, Security, and Models overrides to inherited defaults across reloads", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const initialConfig = {
          agents: {
            defaults: {
              fastModeDefault: true,
              model: "openai/gpt-5.5",
              thinkingDefault: "high",
            },
          },
          browser: { enabled: false },
          tools: {
            codeMode: { enabled: false },
            profile: "minimal",
          },
        };
        const afterLabsReset = {
          agents: initialConfig.agents,
          browser: initialConfig.browser,
          tools: { profile: "minimal" },
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(initialConfig, "curated-defaults-1"),
          },
        });

        expect((await page.goto(`${suite.server.baseUrl}settings/labs`))?.status()).toBe(200);
        const codeModeRow = settingsRow(page, "Code Mode");
        const codeModeSwitch = codeModeRow.getByRole("switch", { name: "Code Mode", exact: true });
        await codeModeSwitch.waitFor();
        expect(await codeModeSwitch.getAttribute("aria-checked")).toBe("false");
        await expect.poll(() => codeModeRow.textContent()).toContain("Default: Enabled");

        if (captureUiProofEnabled) {
          await mkdir(uiProofArtifactDir, { recursive: true });
          await codeModeRow.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "01-labs-explicit-override.png"),
          });
        }

        const configGetsBeforeLabsReset = (await gateway.getRequests("config.get")).length;
        await gateway.deferNext("config.patch");
        await codeModeRow.getByRole("button", { name: "Reset to default" }).click();
        const labsPatch = requestRaw(await gateway.waitForRequest("config.patch"));
        expect(labsPatch).toEqual({ tools: { codeMode: { enabled: null } } });

        const afterLabsResponse = configResponse(afterLabsReset, "curated-defaults-2");
        await gateway.setMethodResponse("config.get", afterLabsResponse);
        await gateway.resolveDeferred("config.patch", afterLabsResponse);
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBe(configGetsBeforeLabsReset + 1);
        await expectInherited(codeModeRow, "Enabled");
        expect(await codeModeSwitch.getAttribute("aria-checked")).toBe("true");

        if (captureUiProofEnabled) {
          await codeModeRow.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "02-labs-inherited-default.png"),
          });
        }

        expect((await page.goto(`${suite.server.baseUrl}settings/security`))?.status()).toBe(200);
        const browserRow = settingsRow(page, "Browser enabled");
        const profileRow = settingsRow(page, "Tool profile");
        await browserRow.getByRole("switch", { name: "Browser enabled", exact: true }).waitFor();
        await expect.poll(() => browserRow.textContent()).toContain("Default: Enabled");
        await expect.poll(() => profileRow.textContent()).toContain("Default: Full");

        if (captureUiProofEnabled) {
          await page
            .locator(".security-page .settings-section")
            .first()
            .screenshot({
              animations: "disabled",
              path: path.join(uiProofArtifactDir, "03-security-explicit-overrides.png"),
            });
        }

        const securitySavesBefore = (await gateway.getRequests("config.set")).length;
        await browserRow.getByRole("button", { name: "Reset to default" }).click();
        await profileRow.getByRole("button", { name: "Reset to default" }).click();
        await expectInherited(browserRow, "Enabled");
        await expectInherited(profileRow, "Full");
        await expect
          .poll(async () => {
            const requests = await gateway.getRequests("config.set");
            const latest = requests.at(-1);
            if (requests.length <= securitySavesBefore || !latest) {
              return false;
            }
            const raw = requestRaw(latest);
            return (
              !hasOwnPath(raw, ["browser", "enabled"]) && !hasOwnPath(raw, ["tools", "profile"])
            );
          })
          .toBe(true);
        await expect
          .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
          .toContain("Saved");

        if (captureUiProofEnabled) {
          await page
            .locator(".security-page .settings-section")
            .first()
            .screenshot({
              animations: "disabled",
              path: path.join(uiProofArtifactDir, "04-security-inherited-defaults.png"),
            });
        }

        expect((await page.reload())?.status()).toBe(200);
        await expectInherited(settingsRow(page, "Browser enabled"), "Enabled");
        await expectInherited(settingsRow(page, "Tool profile"), "Full");

        expect((await page.goto(`${suite.server.baseUrl}settings/model-providers`))?.status()).toBe(
          200,
        );
        const thinkingRow = settingsRow(page, "Thinking");
        const fastModeRow = settingsRow(page, "Fast mode");
        await thinkingRow.getByRole("radio", { name: "High", exact: true }).waitFor();
        expect(
          await thinkingRow
            .getByRole("radio", { name: "High", exact: true })
            .getAttribute("aria-checked"),
        ).toBe("true");
        await expect.poll(() => thinkingRow.textContent()).toContain("Default: Model policy");
        await expect.poll(() => fastModeRow.textContent()).toContain("Default: Model policy");

        if (captureUiProofEnabled) {
          await page.locator("#settings-model-behavior").screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "05-models-explicit-overrides.png"),
          });
        }

        const modelSavesBefore = (await gateway.getRequests("config.set")).length;
        await thinkingRow.getByRole("button", { name: "Reset to default" }).click();
        await fastModeRow.getByRole("button", { name: "Reset to default" }).click();
        await expectInherited(thinkingRow, "Model policy");
        await expectInherited(fastModeRow, "Model policy");
        await expect
          .poll(async () => {
            const requests = await gateway.getRequests("config.set");
            const latest = requests.at(-1);
            if (requests.length <= modelSavesBefore || !latest) {
              return false;
            }
            const raw = requestRaw(latest);
            return (
              !hasOwnPath(raw, ["agents", "defaults", "thinkingDefault"]) &&
              !hasOwnPath(raw, ["agents", "defaults", "fastModeDefault"])
            );
          })
          .toBe(true);
        await expect
          .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
          .toContain("Saved");

        if (captureUiProofEnabled) {
          await page.locator("#settings-model-behavior").screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "06-models-inherited-defaults.png"),
          });
        }

        expect((await page.reload())?.status()).toBe(200);
        const reloadedThinkingRow = settingsRow(page, "Thinking");
        const reloadedFastModeRow = settingsRow(page, "Fast mode");
        await expectInherited(reloadedThinkingRow, "Model policy");
        await expectInherited(reloadedFastModeRow, "Model policy");
        expect(
          await reloadedThinkingRow
            .getByRole("radio", { name: "Default", exact: true })
            .getAttribute("aria-checked"),
        ).toBe("true");
        expect(
          await reloadedFastModeRow
            .getByRole("radio", { name: "Default", exact: true })
            .getAttribute("aria-checked"),
        ).toBe("true");

        expect((await page.goto(`${suite.server.baseUrl}settings/labs`))?.status()).toBe(200);
        const reloadedCodeModeRow = settingsRow(page, "Code Mode");
        await expectInherited(reloadedCodeModeRow, "Enabled");
        expect(
          await reloadedCodeModeRow
            .getByRole("switch", { name: "Code Mode", exact: true })
            .getAttribute("aria-checked"),
        ).toBe("true");

        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(uiProofArtifactDir, "07-reload-inherited-defaults.png"),
          });
        }
      },
    );
  });
});
