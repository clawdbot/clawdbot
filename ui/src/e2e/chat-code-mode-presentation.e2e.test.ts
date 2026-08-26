import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Code Mode presentation",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("presents Code Mode as child operations with source behind disclosure", async () => {
    const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      locale: "en-US",
      viewport: { height: 900, width: 1200 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1200 } } }
        : {}),
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:dashboard:code-mode-presentation";
    const code = [
      'const source = await read({ path: "src/agents/tool-display.ts" });',
      'return await apply_patch({ patch: "*** Begin Patch\\n*** End Patch" });',
    ].join("\n");
    await installMockGateway(page, {
      sessionKey,
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "code-mode-exec",
              name: "exec",
              arguments: { code, command: code, language: "javascript" },
            },
          ],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "code-mode-exec",
          toolName: "exec",
          content: [{ type: "text", text: '{"status":"completed"}' }],
          details: {
            openclawCodeModeControl: { kind: "exec", language: "javascript" },
          },
          timestamp: 2,
        },
        {
          role: "assistant",
          parentToolCallId: "code-mode-exec",
          openclawTranscriptArtifact: { kind: "nested-tool", version: 1 },
          content: [
            {
              type: "toolCall",
              id: "nested-read",
              name: "read",
              arguments: { path: "/repo/src/agents/tool-display.ts" },
            },
          ],
          timestamp: 3,
        },
        {
          role: "toolResult",
          parentToolCallId: "code-mode-exec",
          toolCallId: "nested-read",
          toolName: "read",
          openclawTranscriptArtifact: { kind: "nested-tool", version: 1 },
          isError: false,
          content: [{ type: "text", text: "source" }],
          timestamp: 3,
        },
        {
          role: "assistant",
          parentToolCallId: "code-mode-exec",
          openclawTranscriptArtifact: { kind: "nested-tool", version: 1 },
          content: [
            {
              type: "toolCall",
              id: "nested-patch",
              name: "apply_patch",
              arguments: {
                patch: [
                  "*** Begin Patch",
                  "*** Update File: src/agents/tool-display.ts",
                  "@@",
                  "-const before = true;",
                  "+const after = true;",
                  "*** End Patch",
                ].join("\n"),
              },
            },
          ],
          timestamp: 4,
        },
        {
          role: "toolResult",
          parentToolCallId: "code-mode-exec",
          toolCallId: "nested-patch",
          toolName: "apply_patch",
          openclawTranscriptArtifact: { kind: "nested-tool", version: 1 },
          isError: false,
          content: [{ type: "text", text: "Applied patch" }],
          timestamp: 4,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Code Mode work completed." }],
          timestamp: 5,
        },
      ],
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const work = page.locator(".chat-work-group > .chat-activity-group__summary");
    await work.waitFor();
    expect(await work.textContent()).toContain("Read a file, edited a file");
    expect(await work.textContent()).not.toContain("command");
    expect(await work.textContent()).not.toContain("code workflow");
    if (artifactDir) {
      await page.locator(".chat-main").screenshot({
        path: path.join(artifactDir, "code-mode-operations-collapsed.png"),
      });
    }
    await work.click();
    if (artifactDir) {
      await page.locator(".chat-main").screenshot({
        path: path.join(artifactDir, "code-mode-work-expanded.png"),
      });
    }
    const activity = page.locator(".chat-group--activity .chat-activity-group__summary");
    await activity.waitFor();
    await activity.click();

    const codeRow = page.locator(".chat-tool-msg-summary", {
      hasText: "Ran JavaScript workflow",
    });
    await codeRow.waitFor();
    expect(await page.getByText("JavaScript source", { exact: true }).count()).toBe(0);
    expect(await codeRow.locator(".chat-tool-row__prompt").count()).toBe(0);
    await codeRow.click();
    await page.getByText("JavaScript source", { exact: true }).waitFor();
    await page.getByText(code, { exact: true }).waitFor();

    if (artifactDir) {
      await page.locator(".chat-main").screenshot({
        path: path.join(artifactDir, "code-mode-operations-expanded.png"),
      });
      const video = page.video();
      await context.close();
      await video?.saveAs(path.join(artifactDir, "code-mode-operations.webm"));
    } else {
      await context.close();
    }
  });

  it("keeps a completed command source behind the work disclosure", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    const sessionKey = "agent:main:dashboard:command-work-summary";
    const command = "printf command-source-stays-hidden";
    await installMockGateway(page, {
      sessionKey,
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "command-call",
              name: "exec",
              arguments: { command },
            },
          ],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "command-call",
          toolName: "exec",
          content: [{ type: "text", text: "command-source-stays-hidden" }],
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Command completed." }],
          timestamp: 3,
        },
      ],
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const work = page.locator(".chat-work-group > .chat-activity-group__summary");
    await work.waitFor();
    expect(await work.textContent()).toContain("Ran a command");
    expect(await work.textContent()).not.toContain(command);
    await context.close();
  });
});
