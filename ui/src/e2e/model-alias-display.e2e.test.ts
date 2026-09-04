import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

const models = [
  {
    id: "claude-opus-4-8",
    name: "Opus 4.8",
    alias: "opus",
    provider: "anthropic",
  },
  {
    id: "claude-sonnet-5",
    name: "Sonnet 5",
    alias: "sonnet",
    provider: "anthropic",
  },
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    alias: "Kimi K2.5 (NVIDIA)",
    provider: "nvidia",
  },
];

let proofDir: string | null;
beforeEach(() => {
  proofDir =
    process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
      ? createControlUiE2eArtifactDir("model-alias-display")
      : null;
});

async function createProofContext() {
  return suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
    ...(proofDir
      ? {
          recordVideo: {
            dir: proofDir,
            size: { height: 900, width: 1280 },
          },
        }
      : {}),
  });
}

suite.define(() => {
  it("keeps model versions and custom aliases visible in the chat picker", async () => {
    const context = await createProofContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.patch"],
      models,
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const main = page.getByRole("main");
      const picker = main.locator('[data-chat-model-select="true"]').first();
      await picker.waitFor({ state: "visible", timeout: 10_000 });
      await picker.click();

      const opus = main.locator(
        '[data-chat-model-option="anthropic/claude-opus-4-8"] .chat-controls__model-option-name',
      );
      const sonnet = main.locator(
        '[data-chat-model-option="anthropic/claude-sonnet-5"] .chat-controls__model-option-name',
      );
      await expect.poll(() => opus.textContent()).toBe("Opus 4.8 · opus");
      await expect.poll(() => sonnet.textContent()).toBe("Sonnet 5 · sonnet");

      if (proofDir) {
        await writeFile(
          path.join(proofDir, "anthropic-versioned-model-aliases.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [opus, sonnet]),
        );
      }

      const nvidia = main.locator(
        '[data-chat-model-option="nvidia/moonshotai/kimi-k2.5"] .chat-controls__model-option-name',
      );
      await expect.poll(() => nvidia.textContent()).toBe("Kimi K2.5");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

      if (proofDir) {
        await writeFile(
          path.join(proofDir, "preserved-nvidia-model-alias.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [nvidia]),
        );
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("uses the same versioned catalog labels in the Agents model picker", async () => {
    const context = await createProofContext();
    const page = await context.newPage();
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-8" },
          models: {
            "anthropic/claude-opus-4-8": { alias: "opus" },
            "anthropic/claude-sonnet-5": { alias: "sonnet" },
            "nvidia/moonshotai/kimi-k2.5": { alias: "Kimi K2.5 (NVIDIA)" },
          },
        },
        entries: { main: { default: true } },
      },
    };
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      models,
      methodResponses: {
        "agents.list": {
          agents: [{ id: "main", identity: { name: "Main" }, name: "Main" }],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "config.get": {
          config,
          sourceConfig: config,
          hash: "versioned-model-aliases",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
      },
    });

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/overview`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("agents.list");
      await gateway.waitForRequest("config.get");
      const modelRequest = await gateway.waitForRequest("chat.metadata");
      expect(modelRequest.params).toEqual({ agentId: "main" });
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      const select = page.locator("wa-select.model-picker__select").first();
      await select.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => select.locator('wa-option[value="anthropic/claude-opus-4-8"]').textContent())
        .toContain("Opus 4.8 · opus");
      await expect
        .poll(() => select.locator('wa-option[value="anthropic/claude-sonnet-5"]').textContent())
        .toContain("Sonnet 5 · sonnet");
      await expect
        .poll(() => select.locator('wa-option[value="nvidia/moonshotai/kimi-k2.5"]').textContent())
        .toContain("Kimi K2.5 (NVIDIA)");
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      if (proofDir) {
        await writeFile(
          path.join(proofDir, "agents-versioned-model-aliases.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [select]),
        );
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
