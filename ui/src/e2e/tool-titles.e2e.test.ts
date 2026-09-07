import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("renders recorded and live execution purposes without requesting generated titles", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const command = "set -euo pipefail\npnpm test";
        const gateway = await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "history-check",
                  name: "exec",
                  arguments: { command, title: "Check the test suite" },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "history-check",
              toolName: "exec",
              content: [{ type: "text", text: "All tests passed." }],
            },
            { role: "assistant", content: [{ type: "text", text: "The checks are complete." }] },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const historyRow = page.locator(".chat-tool-row", { hasText: "Check the test suite" });
        await historyRow.waitFor();
        await historyRow.click();
        await page.locator(".chat-tool-msg-body", { hasText: "All tests passed." }).waitFor();
        expect(await page.locator(".chat-tool-msg-body").textContent()).toContain(command);

        await page.locator(".agent-chat__composer-combobox textarea").fill("Check the workspace");
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const params = requireRecord(send.params);
        const runId = requireString(params.idempotencyKey, "chat run id");
        const sessionKey = requireString(params.sessionKey, "chat session key");
        await gateway.emitGatewayEvent("agent", {
          runId,
          sessionKey,
          seq: 1,
          ts: Date.now(),
          stream: "tool",
          data: {
            phase: "start",
            toolCallId: "live-check",
            name: "exec",
            args: {
              code: "await tools.read({ path: 'README.md' })",
              title: "Inspect the workspace guide",
            },
          },
        });
        await page
          .locator(".chat-tool-row--running .chat-tool-row__title", {
            hasText: "Inspect the workspace guide",
          })
          .waitFor();
        expect(await gateway.getRequests("chat.toolTitles")).toHaveLength(0);
      },
    );
  });
});
