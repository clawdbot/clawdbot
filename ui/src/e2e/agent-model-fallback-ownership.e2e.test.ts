// Real browser proof that agent model fallbacks follow the Gateway's ownership contract.
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent model fallback ownership",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const primaryModel = "openai/gpt-5.4";
const inheritedFallback = "anthropic/claude-sonnet-4-6";
const writerWorkspace = "/tmp/agents/writer";
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("agent-context-ownership");
  }
});

suite.define(() => {
  it.each([
    {
      name: "inherits global fallbacks when the agent has no model override",
      model: undefined,
      expectedFallbacks: [inheritedFallback],
    },
    {
      name: "does not inherit global fallbacks for a string primary",
      model: primaryModel,
      expectedFallbacks: [],
    },
    {
      name: "does not inherit global fallbacks for an object primary",
      model: { primary: primaryModel },
      expectedFallbacks: [],
    },
    {
      name: "preserves explicitly disabled agent fallbacks",
      model: { primary: primaryModel, fallbacks: [] },
      expectedFallbacks: [],
    },
    {
      name: "displays the agent's own fallback instead of the global fallback",
      model: { primary: primaryModel, fallbacks: ["google/gemini-3-pro"] },
      expectedFallbacks: ["google/gemini-3-pro"],
    },
    {
      name: "combines an inherited primary with agent-only fallback configuration",
      model: { fallbacks: ["google/gemini-3-pro"] },
      expectedFallbacks: ["google/gemini-3-pro"],
    },
  ])("$name", async ({ model, expectedFallbacks }) => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const config = {
          agents: {
            defaults: {
              workspace: "/tmp/agents",
              model: { primary: primaryModel, fallbacks: [inheritedFallback] },
            },
            entries: {
              main: { default: true },
              writer: model === undefined ? {} : { model },
            },
          },
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
              agents: [
                { id: "main", identity: { name: "Main" }, name: "Main" },
                {
                  id: "writer",
                  identity: { name: "Writer" },
                  name: "Writer",
                  workspace: writerWorkspace,
                  model: { primary: primaryModel, fallbacks: expectedFallbacks },
                },
              ],
            },
            "config.get": {
              config,
              sourceConfig: config,
              hash: "agent-model-fallback-ownership",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/tools`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("agents.list");
        await gateway.waitForRequest("config.get");
        const agentPicker = page.locator("openclaw-agents-page openclaw-agent-select");
        await agentPicker.locator(".agent-select__trigger").click();
        // Switching agents is the user action under test; the Tools panel must survive it.
        await agentPicker
          .locator("wa-dropdown-item[data-agent-option]")
          .filter({ hasText: "Writer" })
          .evaluate((item) => (item as HTMLElement).click());
        await expect
          .poll(() =>
            agentPicker.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
          )
          .toBe("writer");
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/writer/tools");
        await page.getByRole("tab", { name: "Overview", exact: true }).click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe("/settings/agents/writer/overview");

        if (captureUiProof && model && !("primary" in Object(model))) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              proofDir,
              `${process.env.OPENCLAW_UI_PROOF_LABEL ?? "agent-context"}.png`,
            ),
          });
        }

        await expect
          .poll(() => page.locator(".workspace-link").textContent())
          .toContain(writerWorkspace);
        const modelDescription = page
          .locator(".settings-kv dt")
          .filter({ hasText: "Primary Model" })
          .locator("xpath=following-sibling::dd[1]");
        const displayedModel = expectedFallbacks.length
          ? `${primaryModel} (+${expectedFallbacks.length} fallback)`
          : primaryModel;
        await expect.poll(() => modelDescription.textContent()).toContain(displayedModel);

        const fallbackInput = page.locator(".agent-chip-input");
        await fallbackInput.waitFor({ timeout: 10_000 });
        await expect
          .poll(async () =>
            (await fallbackInput.locator(".chip").allTextContents()).map((value) =>
              value.replace("×", "").trim(),
            ),
          )
          .toEqual(expectedFallbacks);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
      },
    );
  });
});
