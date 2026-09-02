// Control UI tests cover plugin mutations serialized behind pending config drafts.
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI plugin config mutation mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("plugins-config-mutation");
  }
});

function configResponse(fallback: string | undefined, workboardEnabled: boolean, hash: string) {
  const config = {
    agents: {
      defaults: { model: { primary: "openai/gpt-5" } },
      entries: {
        main: {
          default: true,
          model: {
            primary: "openai/gpt-5",
            ...(fallback ? { fallbacks: [fallback] } : {}),
          },
        },
      },
    },
    plugins: {
      entries: { workboard: { enabled: workboardEnabled } },
    },
  };
  return {
    config,
    hash,
    appliedConfigHash: hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

const workboardDisabled = {
  id: "workboard",
  name: "Workboard",
  description: "Plan and track work",
  origin: "global",
  installed: true,
  enabled: false,
  state: "disabled",
  featured: true,
  order: 10,
};

const workboardEnabled = {
  ...workboardDisabled,
  enabled: true,
  state: "enabled",
};

suite.define(() => {
  it("drains a pending draft before re-enabling an accepted external plugin without review", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
              agents: [{ id: "main", identity: { name: "Main" }, name: "Main" }],
            },
            "config.get": configResponse(undefined, false, "config-hash-1"),
            "plugins.list": {
              plugins: [workboardDisabled],
              diagnostics: [],
              mutationAllowed: true,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/overview`);
        expect(response?.status()).toBe(200);

        const fallbackInput = page.locator(".agent-chip-input input");
        await fallbackInput.waitFor();
        await gateway.deferNext("config.set");
        await fallbackInput.fill("anthropic/claude-sonnet-4-6");
        await fallbackInput.press("Enter");
        await page.evaluate(() => {
          history.pushState(null, "", "/settings/plugins");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await waitForControlUiRoute(page, {
          pathname: "/settings/plugins",
          routeId: "plugins",
        });

        const workboardRow = page.locator('[data-plugin-id="workboard"]');
        await workboardRow.waitFor();
        if (captureUiProofEnabled) {
          await workboardRow.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "00-before-enable.png"),
          });
        }

        await gateway.deferNext("plugins.setEnabled");
        await workboardRow.getByRole("button", { name: "Enable", exact: true }).click();
        expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);

        const pendingDraft = await gateway.waitForRequest("config.set");
        expect(pendingDraft.params).toMatchObject({ baseHash: "config-hash-1" });
        await gateway.resolveDeferred("config.set", { ok: true, hash: "config-hash-2" });

        const enableRequest = await gateway.waitForRequest("plugins.setEnabled");
        expect(enableRequest.params).toEqual({ pluginId: "workboard", enabled: true });
        await gateway.setMethodResponse(
          "config.get",
          configResponse("anthropic/claude-sonnet-4-6", true, "config-hash-3"),
        );
        await gateway.setMethodResponse("plugins.list", {
          plugins: [workboardEnabled],
          diagnostics: [],
          mutationAllowed: true,
        });
        await gateway.resolveDeferred("plugins.setEnabled", {
          ok: true,
          plugin: workboardEnabled,
          restartRequired: true,
        });

        await workboardRow.getByRole("button", { name: "Disable", exact: true }).waitFor();
        expect(await gateway.getRequests("plugins.inspect")).toHaveLength(0);
        expect(await page.locator("[data-plugin-consent]").count()).toBe(0);
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBeGreaterThanOrEqual(2);
        if (captureUiProofEnabled) {
          await workboardRow.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "01-after-enable.png"),
          });
        }
      },
    );
  });
});
