import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:main";
let proofDir: string | null;
beforeEach(() => {
  proofDir =
    process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
      ? createControlUiE2eArtifactDir("chat-only-model")
      : null;
});

const models = [
  {
    id: "qwen3-8b",
    name: "Qwen3 8B",
    provider: "lmstudio",
    contextWindow: 32_768,
    supportsTools: false,
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai",
    contextWindow: 200_000,
    supportsTools: true,
  },
];

function sessionsList(model: string, modelProvider: string) {
  return {
    count: 1,
    defaults: {
      contextTokens: 32_768,
      model: "qwen3-8b",
      modelProvider: "lmstudio",
      thinkingDefault: "off",
      thinkingLevels: [{ id: "off", label: "off" }],
    },
    path: "",
    sessions: [
      {
        contextTokens: 32_768,
        displayName: "Local chat",
        hasActiveRun: false,
        key: sessionKey,
        kind: "direct",
        label: "Local chat",
        model,
        modelProvider,
        status: "done",
        totalTokens: 0,
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

suite.define(() => {
  it("explains chat-only models and keeps model switching as the recovery path", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      agentModel: "lmstudio/qwen3-8b",
      featureMethods: ["chat.metadata", "chat.startup", "sessions.patch"],
      models,
      sessionKey,
      methodResponses: {
        "sessions.list": sessionsList("qwen3-8b", "lmstudio"),
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const main = page.getByRole("main");
      const composer = main.locator(".agent-chat__composer-shell");
      const picker = composer.locator('[data-chat-model-select="true"]');
      const badge = picker.locator(".chat-controls__model-capability-badge");

      await expect.poll(() => picker.getAttribute("data-chat-model-tools")).toBe("unavailable");
      await expect.poll(async () => (await badge.textContent())?.trim()).toBe("Chat only");
      await expect.poll(() => picker.getAttribute("aria-label")).toContain("Chat only");

      if (proofDir) {
        await composer.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "01-desktop-chat-only-composer.png"),
        });
      }

      await picker.click();
      const localOption = composer.locator('[data-chat-model-option="lmstudio/qwen3-8b"]');
      const openAiOption = composer.locator('[data-chat-model-option="openai/gpt-5.5"]');
      await expect
        .poll(() => localOption.locator(".chat-controls__model-option-meta").textContent())
        .toBe("32.8k");
      await expect.poll(() => localOption.getAttribute("aria-label")).toContain("cannot use tools");
      const infoIcon = localOption.locator(".chat-controls__model-chat-only-info");
      await expect.poll(() => infoIcon.locator("svg").count()).toBe(1);
      await expect.poll(async () => (await infoIcon.boundingBox())?.width).toBe(16);
      await expect
        .poll(async () => (await openAiOption.textContent())?.includes("Chat only"))
        .toBe(false);

      if (proofDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "02-desktop-model-picker.png"),
        });
      }

      await openAiOption.click();
      const patch = await gateway.waitForRequest("sessions.patch");
      expect(patch.params).toMatchObject({ key: sessionKey, model: "openai/gpt-5.5" });
      await expect.poll(() => picker.getAttribute("data-chat-model-tools")).toBe("available");
      await expect.poll(() => badge.count()).toBe(0);

      const pickerDetails = composer.locator("details.chat-controls__model-picker");
      if (!(await pickerDetails.evaluate((element: HTMLDetailsElement) => element.open))) {
        await picker.click();
      }
      await localOption.click();
      await expect.poll(() => picker.getAttribute("data-chat-model-tools")).toBe("unavailable");
      if (await pickerDetails.evaluate((element: HTMLDetailsElement) => element.open)) {
        await picker.click();
      }
      await page.setViewportSize({ height: 844, width: 390 });
      await expect.poll(() => picker.isVisible()).toBe(true);

      if (proofDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "03-mobile-chat-only-model.png"),
        });
      }

      if (!(await pickerDetails.evaluate((element: HTMLDetailsElement) => element.open))) {
        await picker.click();
      }
      const menu = composer.locator(".chat-controls__model-menu");
      await expect
        .poll(async () => {
          const box = await menu.boundingBox();
          return box !== null && box.x >= 0 && box.x + box.width <= 390;
        })
        .toBe(true);

      if (proofDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "04-mobile-model-picker.png"),
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
