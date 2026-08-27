import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps send pending until reasoning and speed patches finish", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          ...chatSessionListResponse([
            {
              effectiveFastMode: false,
              fastMode: false,
              key: "agent:main:session-a",
              kind: "direct",
              label: "Session A",
              model: "gpt-5.5",
              modelProvider: "openai",
              thinkingLevel: "high",
              updatedAt: 2,
            },
          ]),
          defaults: {
            contextTokens: null,
            model: "gpt-5.5",
            modelProvider: "openai",
            thinkingDefault: "high",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
            ],
          },
        },
      },
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const main = page.getByRole("main");
      await main.locator('[data-chat-thinking-select="true"]').click();
      await gateway.deferNext("sessions.patch");
      const thinkingSlider = main.locator('[data-chat-thinking-slider="true"]');
      await expect.poll(() => thinkingSlider.isVisible()).toBe(true);
      await thinkingSlider.press("ArrowLeft");
      const firstPatch = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(firstPatch.params).thinkingLevel).toBe("medium");

      await gateway.deferNext("sessions.patch");
      await main.locator('[data-chat-speed-toggle="on"]').click();
      await expectRequestCountStable(gateway, "sessions.patch", 1);
      await page.keyboard.press("Escape");

      const prompt = "send with the new reasoning and speed";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await page.locator(".chat-queue").getByText("Applying chat settings").waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      const sessionListCount = (await gateway.getRequests("sessions.list")).length;
      await gateway.resolveDeferred("sessions.patch", {});
      const patches = await waitForRequests(gateway, "sessions.patch", 2);
      expect(requireRecord(patches[1]?.params).fastMode).toBe(true);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(sessionListCount);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await gateway.resolveDeferred("sessions.patch", {});
      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(requireRecord(sendRequest.params)).toMatchObject({
        message: prompt,
        sessionKey: "agent:main:session-a",
      });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
