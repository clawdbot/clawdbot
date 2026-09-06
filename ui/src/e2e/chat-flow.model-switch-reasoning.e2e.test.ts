import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("applies provider-specific reasoning after the selected model is saved", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:session-a";
    const fableSession = {
      key: sessionKey,
      kind: "direct",
      label: "Session A",
      model: "claude-fable-5",
      modelProvider: "anthropic",
      thinkingDefault: "high",
      thinkingLevel: "high",
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "adaptive", label: "adaptive" },
        { id: "high", label: "high" },
        { id: "xhigh", label: "xhigh" },
        { id: "max", label: "max" },
      ],
      updatedAt: 2,
    };
    const solSession = {
      ...fableSession,
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
        { id: "ultra", label: "ultra" },
      ],
    };
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.patch"],
      methodResponses: {
        "sessions.list": chatSessionListResponse([fableSession]),
      },
      models: [
        { id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic" },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
      ],
      sessionKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));

      const main = page.getByRole("main");
      await main.locator('[data-chat-model-select="true"]').click();
      await main.locator('[data-chat-model-option="openai/gpt-5.6-sol"]').click();

      const modelPatch = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(modelPatch.params)).toMatchObject({
        key: sessionKey,
        model: "openai/gpt-5.6-sol",
      });
      const thinkingSlider = main.locator('[data-chat-thinking-slider="true"]');
      const effortSelect = main.locator('[data-chat-thinking-select="true"]');
      await expect
        .poll(async () => ({
          effortDisabled: await effortSelect.getAttribute("data-chat-thinking-disabled"),
          effortAriaDisabled: await effortSelect.getAttribute("aria-disabled"),
          sliderDisabled: await thinkingSlider.isDisabled(),
        }))
        .toEqual({
          effortDisabled: "true",
          effortAriaDisabled: "true",
          sliderDisabled: true,
        });
      await thinkingSlider.evaluate((input) => {
        const slider = input as HTMLInputElement;
        slider.value = slider.max;
        slider.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await expectRequestCountStable(gateway, "sessions.patch", 1);

      await gateway.setMethodResponse("sessions.list", chatSessionListResponse([solSession]));
      const sessionsListCount = (await gateway.getRequests("sessions.list")).length;
      await gateway.resolveDeferred("sessions.patch");
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(sessionsListCount);
      await main.locator('[data-chat-thinking-select="true"]').click();
      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toContain("ultra");
      await expect.poll(() => thinkingSlider.isEnabled()).toBe(true);

      await thinkingSlider.evaluate((input) => {
        const slider = input as HTMLInputElement;
        const values = (slider.dataset.chatThinkingValues ?? "").split(",");
        slider.value = String(values.indexOf("ultra"));
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        slider.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const patches = await waitForRequests(gateway, "sessions.patch", 2);
      expect(requireRecord(patches[1]?.params)).toMatchObject({
        key: sessionKey,
        thinkingLevel: "ultra",
      });
      await expect.poll(() => page.getByText(/not supported for/u).count()).toBe(0);

      const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      const artifactDir = artifactDirParent
        ? createControlUiE2eArtifactDir("chat-flow.model-switch-reasoning", artifactDirParent)
        : undefined;
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/model-thinking-sync.png`,
          fullPage: true,
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
