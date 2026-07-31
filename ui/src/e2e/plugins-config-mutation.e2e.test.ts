// Control UI tests cover plugin mutations serialized behind pending config drafts.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  waitForControlUiRoute,
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
  "plugins-config-mutation",
);

let browser: Browser;
let server: ControlUiE2eServer;

function configResponse(fallback: string | undefined, workboardEnabled: boolean, hash: string) {
  const config = {
    agents: {
      defaults: { model: { primary: "openai/gpt-5" } },
      list: [
        {
          id: "main",
          model: {
            primary: "openai/gpt-5",
            ...(fallback ? { fallbacks: [fallback] } : {}),
          },
        },
      ],
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
  origin: "bundled",
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

describeControlUiE2e("Control UI plugin config mutation mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not available at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("drains a pending draft before enabling a plugin and refreshes the result", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
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

    try {
      const response = await page.goto(`${server.baseUrl}settings/agents/main/overview`);
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
        await mkdir(uiProofArtifactDir, { recursive: true });
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
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThanOrEqual(2);
      if (captureUiProofEnabled) {
        await workboardRow.screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "01-after-enable.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
