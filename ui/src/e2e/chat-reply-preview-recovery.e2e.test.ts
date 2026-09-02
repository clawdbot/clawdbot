import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createChatFlowE2eSuite,
  expectRequestCountStable,
  controlUiSessionUrl,
  installMockGateway,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    {
      name: "temporary lookup failure",
      artifact: "temporary-failure",
      response: {
        __mockError: {
          code: "UNAVAILABLE",
          message: "Session transcript projection is rebuilding: reply-preview-session",
        },
      },
    },
    {
      name: "permanently unavailable source",
      artifact: "unavailable-source",
      response: { ok: false, unavailableReason: "not_found" },
    },
  ])(
    "settles a $name without repeatedly loading the reply preview",
    async ({ artifact, response }) => {
      const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      const artifactDir = artifactRoot
        ? createControlUiE2eArtifactDir("chat-reply-preview-recovery", artifactRoot)
        : undefined;
      const context = await suite.newBrowserContext({
        locale: "en-US",
        ...(artifactDir
          ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
          : {}),
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "Follow up on the earlier answer." }],
            timestamp: 1_800_000_000_000,
            __openclaw: { id: "reply-message", seq: 101, replyToId: "older-answer" },
          },
        ],
        methodResponses: { "chat.message.get": response },
        sessionKey: "agent:main:reply-preview",
      });

      let firstCount = 0;
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:reply-preview"));
        const reply = page.locator(".chat-pane-cache__pane--active .chat-reply-preview--message");
        await reply.waitFor({ state: "visible" });
        expect(await reply.textContent()).toContain("Replying to message");
        await gateway.waitForRequest("chat.message.get");
        const composer = page.locator(
          ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
        );
        await composer.fill("This draft remains usable.");
        expect(await composer.inputValue()).toBe("This draft remains usable.");
        firstCount = (await gateway.getRequests("chat.message.get")).length;
        await expectRequestCountStable(gateway, "chat.message.get", 1);
        if (artifact === "unavailable-source") {
          await reply.click();
          await page
            .locator(".chat-pane-cache__pane--active")
            .getByRole("alert")
            .getByText("The original message is unavailable.", { exact: true })
            .waitFor();
          await expectRequestCountStable(gateway, "chat.message.get", 1);
        }
      } finally {
        if (artifactDir) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, `${artifact}.png`),
          });
          await writeFile(
            path.join(artifactDir, `${artifact}.json`),
            JSON.stringify(
              {
                firstCount,
                finalCount: (await gateway.getRequests("chat.message.get")).length,
                replyText: await page.locator(".chat-reply-preview--message").allTextContents(),
              },
              null,
              2,
            ),
          );
        }
        await suite.closeBrowserContext(context);
      }
    },
  );

  it.each(["temporary failure", "previous success", "not found"] as const)(
    "refreshes a reply preview after reconnect from $0 and keeps source navigation working",
    async (initial) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const source = {
        role: "assistant",
        content: [{ type: "text", text: "The current original answer." }],
        timestamp: 1_800_000_000_000,
        __openclaw: { id: "reconnect-source", seq: 1 },
      };
      // Deep enough that the source's page sits beyond the upward-prefetch
      // reach; the refresh must come from chat.message.get, not a loaded row.
      const interveningCount = 60;
      const reply = {
        role: "user",
        content: [{ type: "text", text: "A follow-up question after reconnect." }],
        timestamp: 1_800_000_000_001 + interveningCount,
        __openclaw: {
          id: "reconnect-reply",
          seq: interveningCount + 2,
          replyToId: "reconnect-source",
        },
      };
      const messages = [
        ...Array.from({ length: interveningCount }, (_, index) => ({
          role: index % 2 === 0 ? "assistant" : "user",
          content: [{ type: "text", text: `Conversation entry ${index + 2}.` }],
          timestamp: 1_800_000_000_001 + index,
          __openclaw: { id: `intervening-${index}`, seq: index + 2 },
        })),
        reply,
      ];
      const gateway = await installMockGateway(page, {
        historyMessages: messages,
        methodResponses: {
          "chat.message.get":
            initial === "temporary failure"
              ? {
                  __mockError: {
                    code: "UNAVAILABLE",
                    message: "Transcript temporarily unavailable",
                  },
                }
              : initial === "not found"
                ? { ok: false, unavailableReason: "not_found" }
                : {
                    ok: true,
                    message: { ...source, content: [{ type: "text", text: "Previous preview." }] },
                  },
          "chat.history": {
            cases: [
              {
                match: { offset: messages.length },
                response: {
                  messages: [source],
                  hasMore: false,
                  totalMessages: messages.length + 1,
                  sessionId: "reply-preview-history",
                },
              },
            ],
          },
          "chat.startup": {
            messages,
            hasMore: true,
            nextOffset: messages.length,
            totalMessages: messages.length + 1,
            sessionId: "reply-preview-history",
          },
        },
        sessionKey: "agent:main:reply-reconnect",
        sessions: [{ key: "agent:main:reply-reconnect", sessionId: "reply-preview-history" }],
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:reply-reconnect"));
        const preview = page.locator(".chat-pane-cache__pane--active .chat-reply-preview--message");
        await preview.waitFor();
        await gateway.waitForRequest("chat.message.get");
        await expectRequestCountStable(gateway, "chat.message.get", 1);
        if (initial === "previous success") {
          expect(await preview.textContent()).toContain("Previous preview.");
        }
        await gateway.setMethodResponse("chat.message.get", { ok: true, message: source });
        const connectCount = (await gateway.getRequests("connect")).length;
        await gateway.closeLatest(1006, "reply preview recovery");
        await waitForRequests(gateway, "connect", connectCount + 1);
        await expect.poll(() => preview.textContent()).toContain("The current original answer.");
        await expectRequestCountStable(gateway, "chat.message.get", 2);

        await preview.click();
        await page
          .locator(".chat-pane-cache__pane--active .chat-text")
          .getByText("The current original answer.", { exact: true })
          .waitFor();
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
