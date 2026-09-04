import { writeFile } from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { expect, it } from "vitest";
import { startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activateSelfRemovingControl,
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionUrl,
  installMockGateway,
  openSessionMenuSubmenu,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat export attribution",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
const sessionKey = "agent:main:export-attribution";
const messages = [
  { role: "user", senderLabel: "Alex", content: "I will write the release notes." },
  {
    role: "user",
    __openclaw: { senderName: "Sam", senderId: "sam@example.invalid" },
    content: "I will verify the build.",
  },
  {
    role: "assistant",
    senderLabel: "Review assistant",
    content: "Alex owns the notes; Sam owns build verification.",
  },
];

suite.define(() => {
  it.each(["download", "copy"])(
    "preserves the visible speakers in a Markdown %s",
    async (action) => {
      await suite.withPage(
        {
          viewport: { width: 1280, height: 900 },
          ...(captureUiProofEnabled
            ? { recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } } }
            : {}),
        },
        async ({ context, page }) => {
          await context.grantPermissions(["clipboard-read", "clipboard-write"], {
            origin: new URL(suite.server.baseUrl).origin,
          });
          const gateway = await installMockGateway(page, {
            sessionKey,
            featureMethods: ["chat.metadata", "chat.startup", "chat.history"],
            historyMessages: messages,
            methodResponses: {
              "sessions.list": sessionsListResponse([
                sessionRow(sessionKey, "Release planning", Date.parse("2026-08-15T06:00:00Z")),
              ]),
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await gateway.waitForRequest("chat.startup");
          const thread = page.locator(".chat-thread-inner");
          for (const sender of ["Alex", "Sam", "Review assistant"]) {
            await thread.locator(".chat-sender-name").getByText(sender, { exact: true }).waitFor({
              state: "visible",
            });
          }
          await captureUiProof(suite, page, `${action}-transcript.png`);

          let markdown: string;
          if (action === "download") {
            await page.locator(".agent-chat__composer-combobox textarea").fill("/export");
            const downloadPromise = page.waitForEvent("download");
            await page.getByRole("button", { name: "Send message" }).click();
            const download = await downloadPromise;
            expect(download.suggestedFilename()).toMatch(/^chat-OpenClaw-.+\.md$/);
            const stream = await download.createReadStream();
            if (!stream) {
              throw new Error("chat export did not provide a readable download");
            }
            markdown = await text(stream);
          } else {
            const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
            await row.hover();
            await row.getByRole("button", { name: "Open session menu: Release planning" }).click();
            await openSessionMenuSubmenu(page, "Copy");
            await captureUiProof(suite, page, "copy-menu.png");
            const copy = page.locator("openclaw-session-menu").getByRole("menuitem", {
              name: "Conversation as Markdown",
              exact: true,
            });
            await copy.click({ trial: true });
            await activateSelfRemovingControl(copy);
            await expect.poll(() => page.locator(".app-toast").textContent()).toContain("Copied");
            markdown = await page.evaluate(() => navigator.clipboard.readText());
          }
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          if (captureUiProofEnabled) {
            await writeFile(path.join(suite.artifactDir, `${action}.md`), markdown);
            const preview = await context.newPage();
            await preview.goto(`data:text/plain;charset=utf-8,${encodeURIComponent(markdown)}`);
            await captureUiProof(suite, preview, `${action}-markdown.png`);
            await preview.close();
          }
          expect(markdown.match(/^## .+$/gm)).toEqual(["## Alex", "## Sam", "## Review assistant"]);
          for (const message of messages) {
            expect(markdown).toContain(message.content);
          }
        },
      );
    },
  );
});
