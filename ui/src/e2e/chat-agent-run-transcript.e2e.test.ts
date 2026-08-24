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
    __openclaw: role === "user" ? { id, idempotencyKey: runId, seq } : { id, runId, seq },
  };
}

suite.define(() => {
  it("renders each run as one linear response with actions only on its terminal text", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1200 } });
    const page = await context.newPage();
    const firstRunId = "run-composed-first";
    const secondRunId = "run-composed-second";
    const toolOnlyRunId = "run-tool-only";
    const commentaryToolRunId = "run-commentary-tool-only";
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
        transcriptMessage("user", "Check without replying.", `${toolOnlyRunId}:user`, "user-3", 11),
        {
          ...transcriptMessage(
            "toolResult",
            [{ type: "text", text: "Tool-only result" }],
            toolOnlyRunId,
            "tool-result-3",
            12,
          ),
          toolCallId: "call-tool-only",
          toolName: "read",
        },
        transcriptMessage(
          "user",
          "Inspect and stop after the tool.",
          `${commentaryToolRunId}:user`,
          "user-4",
          13,
        ),
        transcriptMessage(
          "assistant",
          "I’ll inspect the current state first.",
          commentaryToolRunId,
          "assistant-5",
          14,
        ),
        {
          ...transcriptMessage(
            "toolResult",
            [{ type: "text", text: "Commentary-led tool-only result" }],
            commentaryToolRunId,
            "tool-result-4",
            15,
          ),
          toolCallId: "call-commentary-tool-only",
          toolName: "read",
        },
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const transcript = page.locator(".chat-thread-inner");
    await transcript.getByText("Caption ready for the second run.", { exact: true }).waitFor();

    const assistantGroups = page.locator(".chat-group.assistant");
    expect(await assistantGroups.count()).toBe(4);
    const firstRun = assistantGroups.filter({
      hasText: "I’ll create the launch card and check the existing style first.",
    });
    expect(await firstRun.count()).toBe(1);
    const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
      await firstRun.screenshot({ path: path.join(artifactDir, "agent-run-transcript.png") });
    }
    expect(await firstRun.locator(".chat-sender-name").count()).toBe(1);
    expect(await firstRun.locator(".chat-group-footer-actions").count()).toBe(1);
    expect(await firstRun.locator(".chat-message-actions-row").count()).toBe(0);
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
    const toolOnlyRun = page.locator(
      `.chat-group.assistant[data-chat-row-key*="${toolOnlyRunId}"]`,
    );
    expect(await toolOnlyRun.count()).toBe(1);
    expect(await toolOnlyRun.locator(".chat-group-footer-actions").count()).toBe(0);
    const commentaryToolRun = page.locator(
      `.chat-group.assistant[data-chat-row-key*="${commentaryToolRunId}"]`,
    );
    expect(await commentaryToolRun.count()).toBe(1);
    expect(
      await commentaryToolRun
        .getByText("I’ll inspect the current state first.", { exact: true })
        .count(),
    ).toBe(1);
    expect(await commentaryToolRun.locator(".chat-group-footer-actions").count()).toBe(0);

    await context.close();
  });

  it("keeps the run row identity when a hidden heartbeat boundary reaches history", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1200 } });
    const page = await context.newPage();
    const runId = "run-heartbeat-browser-handoff";
    const gateway = await installMockGateway(page, {
      historyMessages: [],
      inFlightRun: { runId, text: "" },
      sessionInfo: {
        activeRunIds: [runId],
        hasActiveRun: true,
        key: "main",
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const liveRow = page.locator(".chat-virtual-row", {
      has: page.locator(".chat-reading-indicator"),
    });
    await liveRow.waitFor();
    const liveKey = await liveRow.getAttribute("data-virtual-row-key");
    expect(liveKey).not.toBeNull();

    const finalText = "Heartbeat handoff complete.";
    const persistedMessage = {
      role: "assistant",
      api: "cli",
      content: finalText,
      idempotencyKey: `cli-assistant:${runId}`,
      timestamp: Date.UTC(2026, 7, 19, 12, 1),
      __openclaw: {
        id: "assistant-after-hidden-heartbeat",
        seq: 1,
        turnBoundary: true,
      },
    };
    await gateway.setHistoryMessages([persistedMessage]);
    const historyRequestsBeforeFinal = (await gateway.getRequests("chat.history")).length;
    await gateway.emitGatewayEvent("session.message", {
      activeRunIds: [],
      clientRunId: runId,
      hasActiveRun: false,
      message: persistedMessage,
      messageId: "assistant-after-hidden-heartbeat",
      messageSeq: 1,
      session: {
        activeRunIds: [],
        hasActiveRun: false,
        key: "main",
        kind: "direct",
        status: "done",
        updatedAt: Date.now(),
      },
      sessionKey: "main",
    });
    await expect
      .poll(async () => (await gateway.getRequests("chat.history")).length)
      .toBeGreaterThan(historyRequestsBeforeFinal);

    const settledRow = page.locator(".chat-virtual-row", {
      has: page.getByText(finalText, { exact: true }),
    });
    await settledRow.waitFor();
    await expect.poll(() => settledRow.getAttribute("data-virtual-row-key")).toBe(liveKey);
    expect(await settledRow.count()).toBe(1);

    await context.close();
  });
});
