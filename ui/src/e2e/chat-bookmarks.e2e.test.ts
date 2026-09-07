import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
} from "./chat-flow.test-support.ts";

async function setView(page: Page, value: "tool-calls" | "commentary", checked: boolean) {
  await page.locator(".chat-header-session-menu__trigger").click();
  await page.locator('wa-dropdown-item:has(wa-dropdown-item[value="view:tool-calls"])').hover();
  const item = page.locator('wa-dropdown-item[value="view:' + value + '"]:visible');
  await item.waitFor();
  if ((await item.getAttribute("aria-checked")) !== String(checked)) {
    await item.click();
  }
  await page.keyboard.press("Escape");
  await page
    .locator('wa-dropdown-item[value="view:tool-calls"]:visible')
    .waitFor({ state: "hidden" });
}

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it.each(["commentary preference", "collapsed work"] as const)(
    "reveals a bookmarked source hidden by %s without changing view preferences",
    async (hiddenBy) => {
      await suite.withPage(
        { viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          const key =
            hiddenBy === "collapsed work" ? "agent:main:dashboard:bookmarks" : "agent:main:main";
          const sessionId = "source-generation";
          const commentary = (id: string, text: string, timestamp: number) => ({
            role: "assistant",
            content: text,
            timestamp,
            runId: "source-run",
            __openclaw: { id },
            openclawStreamFallback: { replacementText: text, source: "segment", itemId: id },
          });
          const bookmark = {
            agentId: "main",
            sessionKey: key,
            sessionId,
            messageId: "saved-source",
            name: "Working note",
          };
          await installMockGateway(page, {
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
                sessionId,
                kind: "direct",
                label: "Bookmarks",
                model: "example-model",
                modelProvider: "example",
              },
            ],
            historyMessages: [
              {
                role: "user",
                content: "Inspect the workspace",
                timestamp: 1000,
                __openclaw: { id: "prompt", idempotencyKey: "source-run:user" },
              },
              commentary("saved-source", "Saved working note", 2000),
              commentary("unrelated-source", "Unrelated working note", 3000),
              {
                role: "toolResult",
                toolName: "read",
                toolCallId: "read-source",
                content: "Hidden tool output",
                timestamp: 4000,
                runId: "source-run",
                __openclaw: { id: "tool-source" },
              },
              {
                role: "assistant",
                content: "Workspace checked",
                phase: "final_answer",
                stopReason: "stop",
                timestamp: 5000,
                runId: "source-run",
                __openclaw: { id: "final-source" },
              },
            ],
            methodResponses: {
              "users.prefs.get": { status: "ok", entries: { "chat.bookmark:working": bookmark } },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
          await page.locator('.chat-bubble[data-entry-id="final-source"]').waitFor();
          await setView(page, "tool-calls", false);
          await setView(page, "commentary", true);
          const source = page.locator('.chat-bubble[data-entry-id="saved-source"]');
          const work = page.locator(".chat-work-group button");
          if (hiddenBy === "collapsed work") {
            await work.click();
          }
          await source.waitFor({ state: "visible" });
          if (hiddenBy === "collapsed work") {
            await work.click();
          } else {
            await setView(page, "commentary", false);
          }
          await source.waitFor({ state: "hidden" });
          await page.locator(".chat-header-session-menu__trigger").click();
          await page.locator('wa-dropdown-item[value="open-bookmarks"]:visible').click();
          await page.getByRole("button", { name: "Working note", exact: true }).click();
          await source.waitFor({ state: "visible" });
          await source.hover();
          expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
          await page
            .locator('.chat-bubble[data-entry-id="tool-source"]')
            .waitFor({ state: "hidden" });
          if (hiddenBy === "commentary preference") {
            await page
              .locator('.chat-bubble[data-entry-id="unrelated-source"]')
              .waitFor({ state: "hidden" });
          }
          await page.locator(".chat-header-session-menu__trigger").click();
          await page
            .locator('wa-dropdown-item:has(wa-dropdown-item[value="view:tool-calls"])')
            .hover();
          expect(
            await page
              .locator('wa-dropdown-item[value="view:tool-calls"]:visible')
              .getAttribute("aria-checked"),
          ).toBe("false");
          expect(
            await page
              .locator('wa-dropdown-item[value="view:commentary"]:visible')
              .getAttribute("aria-checked"),
          ).toBe(String(hiddenBy === "collapsed work"));
          await page.keyboard.press("Escape");
          await page
            .locator('wa-dropdown-item[value="view:tool-calls"]:visible')
            .waitFor({ state: "hidden" });
          if (hiddenBy === "collapsed work") {
            await work.click();
          } else {
            await setView(page, "commentary", true);
            await setView(page, "commentary", false);
          }
          await source.waitFor({ state: "hidden" });
        },
      );
    },
  );
  it("opens and renames a saved message through existing preferences without overriding view controls", async () => {
    await suite.withPage(
      { colorScheme: "dark", viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const key = "agent:main:main";
        const sessionId = "bookmark-generation";
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
              sessionId,
              kind: "direct",
              label: "Bookmarks",
              model: "example-model",
              modelProvider: "example",
            },
          ],
          historyMessages: Array.from({ length: 72 }, (_, index) => ({
            __openclaw: { id: "bookmark-source-" + index, seq: index * 4 + 1 },
            role: index % 2 ? "assistant" : "user",
            content: [{ type: "text", text: "Bookmark checkpoint " + index }],
            timestamp: Date.UTC(2026, 8, 6, 12, index),
          })).flatMap((message, index) =>
            index === 31
              ? [
                  message,
                  {
                    role: "toolResult",
                    toolName: "read",
                    toolCallId: "hidden-tool-call",
                    content: [{ type: "text", text: "Hidden tool result" }],
                    timestamp: Date.UTC(2026, 8, 6, 12, 31, 10),
                    __openclaw: { id: "hidden-tool", seq: 126 },
                  },
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "Hidden commentary" }],
                    openclawStreamFallback: {
                      replacementText: "Hidden commentary",
                      source: "segment",
                      itemId: "hidden-commentary",
                    },
                    timestamp: Date.UTC(2026, 8, 6, 12, 31, 20),
                    __openclaw: { id: "hidden-commentary", seq: 127 },
                  },
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "Unrelated commentary" }],
                    openclawStreamFallback: {
                      replacementText: "Unrelated commentary",
                      source: "segment",
                      itemId: "other-commentary",
                    },
                    timestamp: Date.UTC(2026, 8, 6, 12, 31, 30),
                    __openclaw: { id: "other-commentary", seq: 128 },
                  },
                ]
              : [message],
          ),
          methodResponses: {
            "users.prefs.get": {
              status: "ok",
              entries: {
                "chat.bookmark:decision": {
                  agentId: "main",
                  sessionKey: key,
                  sessionId,
                  messageId: "bookmark-source-31",
                  name: "Architecture decision",
                },
              },
            },
            "users.prefs.set": { status: "ok" },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await page.locator('.chat-bubble[data-entry-id="bookmark-source-71"]').waitFor();
        await setView(page, "tool-calls", false);
        await setView(page, "commentary", false);
        await page.locator(".agent-chat__composer-combobox > textarea").focus();
        await page.keyboard.press("Control+f");
        const search = page.locator(".agent-chat__search-bar input");
        await search.fill("Bookmark checkpoint 71");
        await page
          .locator('.chat-bubble[data-entry-id="bookmark-source-31"]')
          .waitFor({ state: "hidden" });
        await page.locator(".chat-header-session-menu__trigger").click();
        await page.locator('wa-dropdown-item[value="open-bookmarks"]:visible').click();
        await page.getByRole("button", { name: "Architecture decision", exact: true }).click();
        const source = page.locator('.chat-bubble[data-entry-id="bookmark-source-31"]');
        await source.waitFor({ state: "visible" });
        await search.waitFor({ state: "hidden" });
        // A row behind a reopened modal is not a successful navigation outcome.
        await source.hover();
        expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
        await expect
          .poll(() =>
            source.evaluate((element) => {
              const viewport = element.closest(".chat-thread")!.getBoundingClientRect();
              const rect = element.getBoundingClientRect();
              return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
            }),
          )
          .toBe(true);
        expect(
          await page.locator(".chat-position-rail__marker--bookmark .claw-icon__jaw").count(),
        ).toBeGreaterThan(0);
        const railBookmark = page.locator(".chat-position-rail__marker--bookmark").first();
        await railBookmark.hover();
        expect(
          await railBookmark
            .locator("svg")
            .evaluate((element) => getComputedStyle(element).transform),
        ).toBe("matrix(-1, 0, 0, 1, 0, 0)");
        await captureUiProof(suite, page, "chat-bookmarks", "right-rail-hover.png");
        const hiddenTool = page.locator('.chat-bubble[data-entry-id="hidden-tool"]');
        const hiddenCommentary = page.locator('.chat-bubble[data-entry-id="hidden-commentary"]');
        await hiddenTool.waitFor({ state: "hidden" });
        await hiddenCommentary.waitFor({ state: "hidden" });
        for (const value of ["tool-calls", "commentary"] as const) {
          const message = value === "tool-calls" ? hiddenTool : hiddenCommentary;
          await setView(page, value, true);
          await message.waitFor({ state: "visible" });
          await setView(page, value, false);
          await message.waitFor({ state: "hidden" });
        }
        const writes = (await gateway.getRequests("users.prefs.set")).length;
        await gateway.deferNext("users.prefs.set");
        await source.hover();
        await page.locator(".chat-bookmark-name").click();
        await page.getByRole("textbox", { name: "Name", exact: true }).fill("Reviewed decision");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect
          .poll(async () => (await gateway.getRequests("users.prefs.set")).length)
          .toBe(writes + 1);
        const renamed = {
          agentId: "main",
          sessionKey: key,
          sessionId,
          messageId: "bookmark-source-31",
          name: "Reviewed decision",
        };
        expect((await gateway.getRequests("users.prefs.set")).at(-1)?.params).toEqual({
          entries: { "chat.bookmark:decision": renamed },
        });
        await gateway.setMethodResponse("users.prefs.get", {
          status: "ok",
          entries: {
            "chat.bookmark:decision": renamed,
          },
        });
        await gateway.resolveDeferred("users.prefs.set", { status: "ok" });
        await page.locator("openclaw-modal-dialog").waitFor({ state: "hidden" });
        await expect
          .poll(() => page.locator(".chat-bookmark-name").textContent())
          .toContain("Reviewed decision");
        await gateway.setMethodResponse("users.prefs.get", {
          status: "ok",
          entries: {
            "chat.bookmark:decision": renamed,
            "chat.bookmark:deleted": {
              ...renamed,
              sessionKey: "agent:main:deleted-conversation",
              sessionId: "deleted-generation",
              name: "Deleted conversation marker",
            },
          },
        });
        await page.locator(".chat-header-session-menu__trigger").click();
        await page.locator('wa-dropdown-item[value="open-bookmarks"]:visible').click();
        const retired = page
          .locator(".chat-bookmarks-dialog__item")
          .filter({ hasText: "Deleted conversation marker" });
        expect(await retired.count()).toBe(0);
        await page.getByRole("checkbox", { name: "All conversations" }).check();
        await retired.waitFor({ state: "visible" });
        expect(await retired.textContent()).toContain("agent:main:deleted-conversation");
        expect(await retired.locator(".chat-bookmarks-dialog__source").isDisabled()).toBe(true);
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          expect(
            await retired
              .locator(".chat-bookmarks-dialog__source")
              .evaluate((element) => element.scrollWidth - element.clientWidth),
          ).toBeLessThanOrEqual(1);
          await captureUiProof(
            suite,
            page,
            "chat-bookmarks",
            "all-conversations-" + width + ".png",
          );
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await gateway.setMethodResponse("users.prefs.get", {
          status: "ok",
          entries: { "chat.bookmark:decision": renamed },
        });
        await retired.getByRole("button", { name: "Remove bookmark", exact: true }).click();
        await retired.waitFor({ state: "hidden" });
        expect((await gateway.getRequests("users.prefs.set")).at(-1)?.params).toEqual({
          entries: { "chat.bookmark:deleted": null },
        });
        expect(
          await gateway.getRequests("chat.history", {
            sessionKey: "agent:main:deleted-conversation",
          }),
        ).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await captureUiProof(suite, page, "chat-bookmarks", "removed-unavailable.png");
      },
    );
  });
});
