import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
let dynamicCatalogProofDir: string | null;
beforeEach(() => {
  dynamicCatalogProofDir =
    process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
      ? createControlUiE2eArtifactDir("dynamic-catalog-convergence")
      : null;
});

suite.define(() => {
  it("converges Chat reasoning and context metadata after dynamic catalog discovery", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(dynamicCatalogProofDir
        ? { recordVideo: { dir: dynamicCatalogProofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:dynamic-catalog";
    const preparedLevels = [{ id: "off", label: "off" }];
    const discoveredLevels = ["off", "low", "medium", "high", "xhigh"].map((id) => ({
      id,
      label: id,
    }));
    const preparedModel = {
      available: true,
      id: "deepseekv4flash-equivalent",
      name: "DeepSeek V4 Flash",
      provider: "omniroute",
      reasoning: true,
    };
    const discoveredModel = {
      ...preparedModel,
      compat: { supportedReasoningEfforts: discoveredLevels.map((level) => level.id) },
      contextWindow: 262_144,
    };
    const agentsList = {
      agents: [
        {
          id: "main",
          model: { primary: "omniroute/deepseekv4flash-equivalent" },
          name: "Main",
        },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    };
    const sessionResponse = (levels: typeof preparedLevels, contextTokens: number) => ({
      count: 1,
      defaults: {
        contextTokens,
        model: "deepseekv4flash-equivalent",
        modelProvider: "omniroute",
        thinkingDefault: "off",
        thinkingLevels: levels,
      },
      path: "",
      sessions: [
        {
          contextTokens,
          key: sessionKey,
          sessionId: "control-ui-dynamic-catalog-convergence",
          kind: "direct",
          label: "Dynamic catalog",
          model: "deepseekv4flash-equivalent",
          modelProvider: "omniroute",
          thinkingDefault: "off",
          thinkingLevels: levels,
          updatedAt: 2,
        },
      ],
      ts: Date.now(),
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.startup": {
          agentsList,
          messages: [],
          metadata: { models: [preparedModel] },
          sessionId: "control-ui-dynamic-catalog-convergence",
          thinkingLevel: null,
        },
        "sessions.list": sessionResponse(preparedLevels, 8_192),
        "models.list": {
          sequence: [{ models: [preparedModel] }, { models: [discoveredModel] }],
        },
      },
      models: [discoveredModel],
      sessionKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const main = page.getByRole("main");
      const modelSelect = main.locator('[data-chat-model-select="true"]');
      const effortSelect = main.locator('[data-chat-thinking-select="true"]');

      await effortSelect.click();
      await expect.poll(() => main.locator('[data-chat-thinking-option="off"]').count()).toBe(1);
      expect(await main.locator('[data-chat-thinking-slider="true"]').count()).toBe(0);
      const initialModelsRequestCount = (await gateway.getRequests("models.list")).length;
      expect(initialModelsRequestCount).toBe(1);
      if (dynamicCatalogProofDir) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(dynamicCatalogProofDir, "01-prepared-off-only.png"),
        });
      }

      await page.keyboard.press("Escape");
      await gateway.setMethodResponse("sessions.list", sessionResponse(discoveredLevels, 65_536));
      const sessionListCount = (await gateway.getRequests("sessions.list")).length;
      await modelSelect.click();
      const modelsRequest = await gateway.waitForRequest("models.list", {
        after: initialModelsRequestCount,
      });
      expect(modelsRequest.params).toMatchObject({ view: "configured", agentId: "main" });
      const refreshedSessionsRequest = await gateway.waitForRequest("sessions.list", {
        after: sessionListCount,
      });
      expect(refreshedSessionsRequest.params).toMatchObject({ agentId: "main" });
      const modelOption = main.locator(
        '[data-chat-model-option="omniroute/deepseekv4flash-equivalent"]',
      );
      await expect.poll(() => modelOption.textContent()).toContain("262.1k");
      if (dynamicCatalogProofDir) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(dynamicCatalogProofDir, "02-discovered-context.png"),
        });
      }

      await page.keyboard.press("Escape");
      await effortSelect.click();
      const thinkingSlider = main.locator('[data-chat-thinking-slider="true"]');
      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toBe("off,low,medium,high,xhigh");
      if (dynamicCatalogProofDir) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(dynamicCatalogProofDir, "03-discovered-thinking-levels.png"),
        });
      }

      await page.keyboard.press("Escape");
      await page.locator("openclaw-app-sidebar .sidebar-brand__new-thread").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      const newSessionPage = page.locator("openclaw-new-session-page");
      await newSessionPage.waitFor();
      const newSessionModelSelect = newSessionPage.locator(
        '.new-session-page__composer [data-chat-model-select="true"]',
      );
      await expect.poll(() => newSessionModelSelect.getAttribute("aria-disabled")).toBe("false");
      await newSessionModelSelect.click();
      const newSessionModel = newSessionPage.locator(
        '[data-chat-model-option="omniroute/deepseekv4flash-equivalent"]',
      );
      await expect.poll(() => newSessionModel.textContent()).toContain("262.1k");
      await expect.poll(() => newSessionModel.isVisible()).toBe(true);
      if (dynamicCatalogProofDir) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(dynamicCatalogProofDir, "04-new-session-discovered-context.png"),
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
