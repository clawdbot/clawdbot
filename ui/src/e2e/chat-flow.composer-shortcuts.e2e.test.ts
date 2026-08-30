import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each(["queue", "steer", "collect", "followup"] as const)(
    "explains and submits the opposite of %s with modified Enter",
    async (followUpMode) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const inheritsQueueMode = followUpMode === "collect" || followUpMode === "followup";
      const runtimeConfig = {
        messages: { queue: { mode: inheritsQueueMode ? followUpMode : "steer" } },
      };
      const gateway = await installMockGateway(
        page,
        inheritsQueueMode
          ? {
              methodResponses: {
                "config.get": {
                  config: runtimeConfig,
                  hash: "composer-shortcut-config",
                  issues: [],
                  raw: JSON.stringify(runtimeConfig),
                  runtimeConfig,
                  valid: true,
                },
              },
            }
          : {},
      );

      try {
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        const followUp = page.locator("[data-settings-follow-up-mode]");
        await followUp.waitFor({ state: "visible" });
        if (!inheritsQueueMode) {
          await followUp.selectOption(followUpMode);
        }
        await page.locator("[data-settings-send-shortcut]").selectOption("enter");
        await page.goto(`${suite.server.baseUrl}chat`);

        const composer = page.locator(".agent-chat__composer-combobox textarea");
        const initialText = "keep the shortcut run active";
        await composer.fill(initialText);
        await page.getByRole("button", { name: "Send message" }).click();
        const initialSend = await gateway.waitForRequest("chat.send");
        const runId = requireString(requireRecord(initialSend.params).idempotencyKey, "active run");
        await page.getByRole("button", { name: "Stop generating" }).waitFor();

        const followUpText = "use the alternate follow-up action";
        await composer.fill(followUpText);
        const primary = page.locator(".agent-chat__composer-actions .chat-send-btn--send");
        await primary.hover();
        const tooltip =
          followUpMode === "steer"
            ? "Steer ⏎ · Queue ⌘/Ctrl+Enter"
            : "Queue ⏎ · Steer ⌘/Ctrl+Enter";
        const tooltipContent = primary.locator("..").locator("wa-tooltip .tooltip-content");
        await expect.poll(() => tooltipContent.textContent()).toBe(tooltip);
        await tooltipContent.waitFor({ state: "visible" });
        await composer.press("Control+Enter");

        if (followUpMode === "steer") {
          const queuedRow = page.locator(".chat-queue__item", { hasText: followUpText });
          await queuedRow.waitFor();
          await expectRequestCountStable(gateway, "chat.send", 1);
          await gateway.setMethodResponse("chat.history", {
            messages: [{ role: "user", content: [{ type: "text", text: initialText }] }],
            sessionId: "session:agent:main:main",
            sessionInfo: {
              key: "main",
              hasActiveRun: false,
              activeRunIds: [],
              lastRunId: runId,
              status: "done",
            },
            thinkingLevel: null,
          });
          await gateway.emitChatFinal({ runId, text: "The original run is done." });
          const sends = await waitForRequests(gateway, "chat.send", 2);
          const queuedParams = requireRecord(sends[1]?.params);
          expect(queuedParams).toMatchObject({
            message: followUpText,
            sessionKey: "agent:main:main",
          });
          expect(queuedParams).not.toHaveProperty("queueMode");
          await queuedRow.waitFor({ state: "detached" });
          await expectRequestCountStable(gateway, "chat.send", 2);
        } else {
          const sends = await waitForRequests(gateway, "chat.send", 2);
          const steerParams = requireRecord(sends[1]?.params);
          expect(steerParams).toMatchObject({
            deliver: false,
            message: followUpText,
            queueMode: "steer",
            sessionKey: "agent:main:main",
          });
          expect(steerParams).not.toHaveProperty("expectedRunId");
          expect(steerParams).not.toHaveProperty("expectedLeafEntryId");
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
