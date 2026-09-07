import path from "node:path";
import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps a commentary fallback distinct from the full row sharing its transcript id", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, { historyMessages: [] });
      await page.goto(`${suite.server.baseUrl}chat`);

      await page.locator(".agent-chat__composer-combobox textarea").fill("Look it up for me.");
      await page.getByRole("button", { name: "Send message" }).click();
      const send = await gateway.waitForRequest("chat.send");
      const runId = requireString(requireRecord(send.params).idempotencyKey, "chat run id");

      const commentary = "Searching for the answer…";
      const answer = "The answer is 42.";
      const session = {
        key: "main",
        kind: "direct",
        status: "running",
        updatedAt: Date.now(),
        hasActiveRun: true,
        activeRunIds: [runId],
      };

      // The server history projection splits a mixed commentary/tool/answer turn
      // into two rows that share the owning transcript id: a keyed commentary
      // fallback and the full row (with the commentary stripped).
      await gateway.emitGatewayEvent("session.message", {
        sessionKey: "main",
        runId,
        clientRunId: runId,
        hasActiveRun: true,
        activeRunIds: [runId],
        messageId: "assistant",
        messageSeq: 2,
        session,
        message: {
          role: "assistant",
          content: [{ type: "text", text: commentary }],
          __openclaw: { id: "assistant", seq: 2, runId },
          openclawStreamFallback: {
            itemId: "commentary-0",
            replacementText: commentary,
            source: "segment",
          },
        },
      });
      await gateway.emitGatewayEvent("session.message", {
        sessionKey: "main",
        runId,
        clientRunId: runId,
        hasActiveRun: true,
        activeRunIds: [runId],
        messageId: "assistant",
        messageSeq: 2,
        session,
        message: {
          role: "assistant",
          content: [{ type: "text", text: answer }],
          __openclaw: { id: "assistant", seq: 2, runId },
        },
      });

      await page.locator(".chat-group.assistant .chat-text", { hasText: commentary }).waitFor();
      const assistantTexts = (
        await page.locator(".chat-group.assistant .chat-text").allTextContents()
      ).map((value) => value.trim());

      // The commentary fallback and the full row must both survive: the same
      // transcript id must not collapse them and drop the commentary text.
      expect(assistantTexts.filter((text) => text === commentary)).toHaveLength(1);
      expect(assistantTexts).toContain(answer);

      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(suite.artifactDir, "commentary-shared-id.png"),
        });
      }
    });
  });
});
