import { expect, it } from "vitest";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("reads a pre-reset bookmark without replacing the current chat, draft, or marker positions", async () => {
    await suite.withPage(
      { colorScheme: "dark", viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const key = "agent:main:main";
        const activeId = "current-generation";
        const retiredId = "saved-generation";
        const saved = {
          agentId: "main",
          sessionKey: key,
          sessionId: retiredId,
          messageId: "same-entry-id",
          name: "Release decision",
        };
        const currentText = "This is the current generation, not the saved decision.";
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          agentModel: "example/example-model",
          models: [{ id: "example-model", provider: "example", name: "Example model" }],
          presenceUsers: [
            {
              self: true,
              id: "reader",
              name: "Example user",
              identity: { type: "profile", id: "reader" },
            },
          ],
          sessions: [
            {
              key,
              sessionId: activeId,
              kind: "direct",
              label: "Release planning",
              model: "example-model",
              modelProvider: "example",
            },
          ],
          historyMessages: [
            {
              role: "user",
              content: "Start the new conversation.",
              timestamp: Date.UTC(2026, 8, 7, 12),
              __openclaw: { id: "new-start", seq: 1 },
            },
            {
              role: "assistant",
              content: currentText,
              timestamp: Date.UTC(2026, 8, 7, 12, 1),
              __openclaw: { id: "same-entry-id", seq: 2 },
            },
            {
              role: "assistant",
              content: "Current plan remains visible.",
              timestamp: Date.UTC(2026, 8, 7, 12, 2),
              __openclaw: { id: "current-plan", seq: 3 },
            },
          ],
          methodResponses: {
            "users.prefs.get": {
              status: "ok",
              entries: {
                "chat.bookmark:old": saved,
                "chat.bookmark:current": {
                  ...saved,
                  sessionId: activeId,
                  messageId: "current-plan",
                  name: "Current plan",
                },
              },
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        await page.getByText(currentText, { exact: true }).waitFor();
        const draft = page.locator(".agent-chat__composer-combobox > textarea");
        await draft.fill("This draft must remain unchanged.");
        const location = page.url();
        const currentRows = await page.locator(".chat-bubble[data-entry-id]").count();
        expect(await page.locator(".chat-position-rail__marker--bookmark").count()).toBe(1);
        await page.locator(".chat-header-session-menu__trigger").click();
        await page.locator('wa-dropdown-item[value="open-bookmarks"]:visible').click();
        const old = page.getByRole("button", { name: /^Release decision/ });
        await old.waitFor();
        await captureUiProof(suite, page, "chat-bookmark-history", "history-entry.png");
        expect(await old.isEnabled()).toBe(true);
        const before = (await gateway.getRequests("chat.history")).length;
        await gateway.deferNext("chat.history");
        await old.click();
        const dialog = page.locator(".chat-bookmarks-dialog");
        await dialog.getByRole("status").waitFor();
        await expect
          .poll(async () => (await gateway.getRequests("chat.history")).length)
          .toBe(before + 1);
        expect((await gateway.getRequests("chat.history")).at(-1)?.params).toMatchObject({
          agentId: "main",
          sessionKey: key,
          sessionId: retiredId,
          messageId: saved.messageId,
        });
        await gateway.resolveDeferred("chat.history", {
          sessionId: retiredId,
          // Historical reads also carry live metadata; it must not choose the excerpt's generation.
          sessionInfo: { key, sessionId: activeId },
          messages: [
            {
              role: "user",
              content: "What belongs in the first release?",
              timestamp: Date.UTC(2026, 8, 6, 14, 31),
              __openclaw: { id: "old-question" },
            },
            {
              role: "assistant",
              content: "The archived **release decision**: ship search and export first.",
              timestamp: Date.UTC(2026, 8, 6, 14, 32),
              __openclaw: { id: saved.messageId },
            },
            {
              role: "user",
              content: "Agreed. This is the saved scope.",
              timestamp: Date.UTC(2026, 8, 6, 14, 33),
              __openclaw: { id: "old-followup" },
            },
          ],
        });
        await dialog.getByText("The archived", { exact: false }).waitFor();
        expect(await dialog.getByText(currentText, { exact: true }).count()).toBe(0);
        expect(
          await dialog.locator("textarea, input, .chat-actions, openclaw-canvas-frame").count(),
        ).toBe(0);
        expect(
          await dialog.getByText("What belongs in the first release?", { exact: true }).count(),
        ).toBe(0);
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await captureUiProof(suite, page, "chat-bookmark-history", "reader-" + width + ".png");
          expect(
            await dialog.evaluate((el) => el.scrollWidth - el.clientWidth),
          ).toBeLessThanOrEqual(1);
        }
        await dialog.getByRole("button", { name: "Show context", exact: true }).click();
        await dialog.getByText("What belongs in the first release?", { exact: true }).waitFor();
        await dialog.getByText("Agreed. This is the saved scope.", { exact: true }).waitFor();
        await captureUiProof(suite, page, "chat-bookmark-history", "reader-context-mobile.png");
        await dialog.getByRole("button", { name: "Back to bookmarks", exact: true }).click();
        await old.waitFor();
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await page.locator("openclaw-modal-dialog").waitFor({ state: "hidden" });
        expect(await draft.inputValue()).toBe("This draft must remain unchanged.");
        expect(page.url()).toBe(location);
        expect(await page.locator(".chat-bubble[data-entry-id]").count()).toBe(currentRows);
        expect(await page.getByText(currentText, { exact: true }).count()).toBe(1);
        expect(await page.locator(".chat-position-rail__marker--bookmark").count()).toBe(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("users.prefs.set")).toHaveLength(0);
      },
    );
  });
});
