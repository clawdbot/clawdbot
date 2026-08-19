import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent run transcript",
  startServerBeforeBrowser: true,
});

function transcriptMessage(
  role: "assistant" | "toolResult" | "user",
  content: unknown,
  runId: string,
  id: string,
  seq: number,
) {
  return {
    role,
    content,
    timestamp: Date.UTC(2026, 7, 19, 12, 0, seq),
    __openclaw: { id, idempotencyKey: runId, seq },
  };
}

suite.define(() => {
  it("renders each run as one linear response with actions only on its terminal text", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1200 } });
    const page = await context.newPage();
    const firstRunId = "run-composed-first";
    const secondRunId = "run-composed-second";
    await installMockGateway(page, {
      historyMessages: [
        transcriptMessage("user", "Create the launch card.", `${firstRunId}:user`, "user-1", 1),
        transcriptMessage(
          "assistant",
          "I’ll create the launch card and check the existing style first.",
          firstRunId,
          "assistant-1",
          2,
        ),
        {
          ...transcriptMessage(
            "assistant",
            [
              {
                type: "toolCall",
                id: "call-read",
                name: "read",
                arguments: { path: "ui/src/styles/chat.css" },
              },
            ],
            firstRunId,
            "tool-call-1",
            3,
          ),
        },
        {
          ...transcriptMessage(
            "toolResult",
            [{ type: "text", text: "Existing card styles loaded." }],
            firstRunId,
            "tool-result-1",
            4,
          ),
          toolCallId: "call-read",
          toolName: "read",
          runId: firstRunId,
        },
        transcriptMessage(
          "assistant",
          "The first draft matches the transcript rhythm. I’ll render the asset now.",
          firstRunId,
          "assistant-2",
          5,
        ),
        {
          ...transcriptMessage(
            "assistant",
            [
              {
                type: "toolCall",
                id: "call-render",
                name: "exec",
                arguments: { command: "render launch-card.svg" },
              },
            ],
            firstRunId,
            "tool-call-2",
            6,
          ),
        },
        {
          ...transcriptMessage(
            "toolResult",
            [{ type: "text", text: "Rendered launch-card.svg" }],
            firstRunId,
            "tool-result-2",
            7,
          ),
          toolCallId: "call-render",
          toolName: "exec",
          runId: firstRunId,
        },
        transcriptMessage(
          "assistant",
          "The launch card is ready: MEDIA:./launch-card.svg",
          firstRunId,
          "assistant-3",
          8,
        ),
        transcriptMessage("user", "Now write the caption.", `${secondRunId}:user`, "user-2", 9),
        transcriptMessage(
          "assistant",
          "Caption ready for the second run.",
          secondRunId,
          "assistant-4",
          10,
        ),
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText("Caption ready for the second run.", { exact: true }).waitFor();

    const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
      await page.screenshot({
        path: path.join(artifactDir, "agent-run-transcript.png"),
        fullPage: true,
      });
    }

    const assistantGroups = page.locator(".chat-group.assistant");
    expect(await assistantGroups.count()).toBe(2);
    const firstRun = assistantGroups.first();
    expect(await firstRun.locator(".chat-sender-name").count()).toBe(1);
    expect(await firstRun.locator(".chat-group-footer-actions").count()).toBe(1);
    expect(await firstRun.locator(".chat-group-footer-actions button").count()).toBe(2);
    expect(
      await firstRun
        .locator(".chat-group-footer-actions button")
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    ).toEqual(["Reply to message", "Copy as markdown"]);

    const orderedContent = await firstRun.locator(".chat-bubble").evaluateAll((bubbles) =>
      bubbles.map((bubble) => ({
        messageId: bubble.getAttribute("data-message-id"),
        text: bubble.textContent?.replace(/\s+/gu, " ").trim(),
      })),
    );
    expect(orderedContent).toEqual([
      expect.objectContaining({ text: expect.stringContaining("I’ll create the launch card") }),
      expect.objectContaining({ text: expect.stringContaining("Read") }),
      expect.objectContaining({ text: expect.stringContaining("The first draft matches") }),
      expect.objectContaining({ text: expect.stringContaining("render launch-card.svg") }),
      expect.objectContaining({ text: expect.stringContaining("The launch card is ready") }),
    ]);
    expect(
      await firstRun.getByText("Caption ready for the second run.", { exact: true }).count(),
    ).toBe(0);

    await context.close();
  });
});
