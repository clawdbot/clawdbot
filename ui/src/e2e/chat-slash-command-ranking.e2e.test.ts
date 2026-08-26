// Control UI E2E tests cover slash command relevance and keyboard ordering.
import path from "node:path";
import { text } from "node:stream/consumers";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI slash command ranking",
});

suite.define(() => {
  it.each(["/export-session", "/export"])(
    "shows an empty export result and retains staged attachments for %s",
    async (command) => {
      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, { historyMessages: [] });
        const downloads: string[] = [];
        page.on("download", (download) => downloads.push(download.suggestedFilename()));

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await page.locator(".agent-chat__file-input").setInputFiles({
          name: "export-proof.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("keep this staged"),
        });
        const attachment = page.locator(".chat-attachment-file__name", {
          hasText: "export-proof.txt",
        });
        await attachment.waitFor({ state: "visible" });

        await composer.fill(command);
        if (artifactDir && command === "/export") {
          await page.screenshot({
            path: path.join(artifactDir, "empty-export-before.png"),
            fullPage: true,
          });
        }
        await page.getByRole("button", { name: "Send message" }).click();

        await page
          .locator(".chat-thread-inner")
          .getByText("There are no messages to export yet.", { exact: true })
          .waitFor({ state: "visible" });
        if (artifactDir && command === "/export") {
          await page.screenshot({
            path: path.join(artifactDir, "empty-export-after.png"),
            fullPage: true,
          });
        }
        await expect.poll(() => composer.inputValue()).toBe("");
        expect(await attachment.isVisible()).toBe(true);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(downloads).toEqual([]);
      });
    },
  );

  it("downloads a populated conversation as Markdown without sending a chat request", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const question = "What can you export?";
      const answer = "A readable conversation.";
      const gateway = await installMockGateway(page, {
        historyMessages: [
          { role: "user", content: question },
          { role: "assistant", content: answer },
        ],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await page.locator(".chat-thread-inner").getByText(answer, { exact: true }).waitFor({
        state: "visible",
      });

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("/export");
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Send message" }).click();
      const download = await downloadPromise;

      expect(download.suggestedFilename()).toMatch(/^chat-OpenClaw-.+\.md$/);
      const stream = await download.createReadStream();
      if (!stream) {
        throw new Error("chat export did not provide a readable download");
      }
      const markdown = await text(stream);
      expect(markdown).toContain("# Chat with OpenClaw");
      expect(markdown).toContain("## You");
      expect(markdown).toContain(question);
      expect(markdown).toContain("## OpenClaw");
      expect(markdown).toContain(answer);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("keeps visible search results and keyboard selection in relevance order", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        ...(artifactDir
          ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        const commands = [
          {
            acceptsArgs: true,
            category: "tools",
            description: "Generate setup codes.",
            name: "pair",
            scope: "both",
            source: "plugin",
            textAliases: ["/pair"],
          },
          {
            acceptsArgs: true,
            category: "session",
            description: "Pair a specific device.",
            name: "pair-device",
            scope: "both",
            source: "plugin",
            textAliases: ["/pair-device"],
          },
        ];
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "chat.startup": {
              agentsList: {
                agents: [{ id: "main", name: "OpenClaw" }],
                defaultId: "main",
                mainKey: "main",
                scope: "agent",
              },
              messages: [],
              metadata: { commands, models: [] },
              sessionId: "slash-command-ranking-session",
              thinkingLevel: null,
            },
            "commands.list": { commands },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await composer.fill("/pair");

        const picker = page.locator(".slash-menu[role='listbox']");
        await picker.waitFor({ state: "visible" });
        const options = picker.getByRole("option");
        await expect
          .poll(
            async () =>
              await options
                .locator(".slash-menu-name")
                .evaluateAll((names) => names.slice(0, 3).map((name) => name.textContent?.trim())),
          )
          .toEqual(["/pair", "/pair-device", "/openclaw"]);

        await composer.press("ArrowDown");
        await expect.poll(() => options.nth(1).getAttribute("aria-selected")).toBe("true");
        await expect
          .poll(() => options.nth(1).locator(".slash-menu-name").textContent())
          .toContain("/pair-device");

        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, "slash-command-ranking-selected.png"),
            fullPage: true,
          });
        }

        await composer.press("Enter");
        await expect.poll(() => composer.inputValue()).toBe("/pair-device ");
        await expect.poll(() => picker.count()).toBe(0);
      },
    );
  });
});
