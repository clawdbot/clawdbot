import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentMessage } from "../../../src/agents/runtime/index.js";
import { redactTranscriptMessage } from "../../../src/agents/transcript-redact.js";
import { resolveChatHistoryWithCliSessionImports } from "../../../src/gateway/cli-session-history.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
  visibleChatBubbleTexts,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

suite.define(() => {
  it("renders a real imported Claude transcript once without exposing its unredacted secret", async () => {
    const homeDir = tempDirs.make("openclaw-cli-history-redaction-");
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());

    try {
      const page = await context.newPage();
      const cliSessionId = "control-ui-claude-history-redaction";
      const secret = "sk-abcdef1234567890xyz";
      const userText = `CLI user copy ${secret}`;
      const assistantText = `CLI imported-only reply ${secret}`;
      const projectsDir = path.join(homeDir, ".claude", "projects", "control-ui-e2e");
      const filePath = path.join(projectsDir, `${cliSessionId}.jsonl`);
      await fs.mkdir(projectsDir, { recursive: true });
      await fs.writeFile(
        filePath,
        [
          {
            type: "user",
            uuid: "control-ui-claude-user-copy",
            timestamp: "2026-03-26T16:29:54.800Z",
            message: { role: "user", content: userText },
          },
          {
            type: "assistant",
            uuid: "control-ui-claude-imported-assistant",
            timestamp: "2026-03-26T16:29:55.800Z",
            message: { role: "assistant", content: assistantText },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
        "utf-8",
      );

      const localUserMessage = redactTranscriptMessage({
        role: "user",
        content: userText,
        timestamp: Date.parse("2026-03-26T16:29:54.800Z"),
      } as AgentMessage);
      const mergedMessages = resolveChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "control-ui-local-claude-history",
          updatedAt: Date.now(),
          cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } },
        },
        provider: "claude-cli",
        localMessages: [localUserMessage],
        homeDir,
      }).messages;

      expect(mergedMessages).toHaveLength(2);
      expect(mergedMessages[0]).toBe(localUserMessage);
      expect(requireRecord(requireRecord(mergedMessages[1])["__openclaw"])).toMatchObject({
        cliSessionId,
        externalId: "control-ui-claude-imported-assistant",
        importedFrom: "claude-cli",
      });
      expect(JSON.stringify(mergedMessages)).not.toContain(secret);
      expect(await fs.readFile(filePath, "utf-8")).toContain(secret);

      const gateway = await installMockGateway(page, {
        historyMessages: mergedMessages,
        methodResponses: { "sessions.list": chatSessionListResponse() },
        sessionKey: "agent:main:session-a",
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
      await waitForRequests(gateway, "chat.startup", 1);
      const thread = page.locator(".chat-thread");
      await thread.getByText("CLI user copy", { exact: false }).waitFor({ timeout: 10_000 });
      await thread.getByText("CLI imported-only reply", { exact: false }).waitFor({
        timeout: 10_000,
      });

      const visibleMessages = await visibleChatBubbleTexts(page);
      expect(visibleMessages.filter((message) => message.includes("CLI user copy"))).toHaveLength(
        1,
      );
      expect(
        visibleMessages.filter((message) => message.includes("CLI imported-only reply")),
      ).toHaveLength(1);
      expect(await thread.textContent()).not.toContain(secret);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
