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
  it("keeps restart-recovered live tool batches in one transcript row", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1200 } });
    const page = await context.newPage();
    const runId = "run-restart-recovery";
    const toolResult = (id: string, seq: number, name: string) => ({
      ...transcriptMessage(
        "toolResult",
        [{ type: "text", text: `${name} completed` }],
        runId,
        id,
        seq,
      ),
      toolCallId: id,
      toolName: name,
    });
    await installMockGateway(page, {
      historyMessages: [
        {
          ...transcriptMessage(
            "user",
            "[System] Continue the interrupted turn.",
            `${runId}:user`,
            "restart-recovery",
            1,
          ),
          provenance: {
            kind: "internal_system",
            sourceSessionKey: "main",
            sourceTool: "main_session_restart_recovery",
          },
        },
        toolResult("process-1", 2, "process"),
        toolResult("process-2", 3, "process"),
        transcriptMessage("assistant", "Checking the next batch.", runId, "gap-1", 4),
        toolResult("exec-1", 5, "exec"),
        toolResult("exec-2", 6, "exec"),
        transcriptMessage("assistant", "Checking the final batch.", runId, "gap-2", 7),
        toolResult("process-3", 8, "process"),
        toolResult("process-4", 9, "process"),
      ],
      inFlightRun: { runId, text: "" },
      sessionInfo: {
        activeRunIds: [runId],
        hasActiveRun: true,
        key: "main",
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const summaries = page.locator(".chat-activity-group__summary");
    await expect.poll(() => summaries.count()).toBe(3);
    const rowKeys = await summaries.evaluateAll((elements) =>
      elements.map(
        (element) => element.closest<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey,
      ),
    );

    expect(rowKeys[0]).toMatch(/^agent-run:/u);
    expect(rowKeys).toEqual([rowKeys[0], rowKeys[0], rowKeys[0]]);
    const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
      await page.locator(".chat-thread-inner").screenshot({
        path: path.join(artifactDir, "restart-recovery-run-frame.png"),
      });
    }

    await context.close();
  });

  it.each([
    { viewport: "desktop-dark", width: 1200, height: 900, theme: "dark" },
    { viewport: "mobile-dark", width: 390, height: 844, theme: "dark" },
    { viewport: "mobile-light", width: 390, height: 844, theme: "light" },
  ] as const)(
    "renders each run as one linear response on $viewport",
    async ({ viewport, width, height, theme }) => {
      const isMobile = viewport.startsWith("mobile");
      const context = await suite.browser.newContext({
        colorScheme: theme,
        hasTouch: isMobile,
        isMobile,
        viewport: { height, width },
      });
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
          transcriptMessage(
            "user",
            "Check without replying.",
            `${toolOnlyRunId}:user`,
            "user-3",
            11,
          ),
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
      const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await fs.mkdir(artifactDir, { recursive: true });
        const firstNarration = transcript.getByText(
          "I’ll create the launch card and check the existing style first.",
          { exact: true },
        );
        await firstNarration.scrollIntoViewIfNeeded();
        await firstNarration.click();
        await transcript.screenshot({ path: path.join(artifactDir, `transcript-${viewport}.png`) });
      }

      const assistantGroups = page.locator(".chat-group.assistant");
      expect(await assistantGroups.count()).toBe(4);
      const firstRun = assistantGroups.filter({
        hasText: "I’ll create the launch card and check the existing style first.",
      });
      expect(await firstRun.count()).toBe(1);
      if (artifactDir) {
        await firstRun.screenshot({
          path: path.join(artifactDir, `agent-run-transcript-${viewport}.png`),
        });
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
    },
  );

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

  it("keeps same-run events from another session out of the selected transcript", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1200 } });
    const page = await context.newPage();
    const runId = "run-shared-across-session-events";
    const selectedText = "Selected session stream stays in its own row.";
    const wrongSessionText = "Wrong session content must never enter this transcript. ".repeat(12);
    const gateway = await installMockGateway(page, {
      historyMessages: [
        transcriptMessage("user", "Earlier prompt", "run-earlier:user", "user-earlier", 1),
        transcriptMessage("assistant", "Earlier answer", "run-earlier", "assistant-earlier", 2),
      ],
      inFlightRun: { runId, text: selectedText },
      sessionInfo: {
        activeRunIds: [runId],
        hasActiveRun: true,
        key: "main",
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText(selectedText, { exact: true }).waitFor();
    const inactiveSessionKey = "agent:main:inactive-session";
    await gateway.emitGatewayEvent("chat", {
      deltaText: wrongSessionText,
      message: { role: "assistant", content: [{ type: "text", text: wrongSessionText }] },
      runId,
      sessionKey: inactiveSessionKey,
      state: "delta",
    });
    await gateway.emitGatewayEvent("chat", {
      message: { role: "assistant", content: [{ type: "text", text: wrongSessionText }] },
      runId,
      sessionKey: inactiveSessionKey,
      state: "final",
    });

    await expect.poll(() => page.getByText(wrongSessionText, { exact: true }).count()).toBe(0);
    await expect.poll(() => page.getByText(selectedText, { exact: true }).count()).toBe(1);
    const overlappingRows = await page.locator(".chat-virtual-row").evaluateAll((rows) => {
      const bounds = rows
        .map((row) => {
          const rect = row.getBoundingClientRect();
          return {
            bottom: rect.bottom,
            key: row.getAttribute("data-virtual-row-key"),
            top: rect.top,
          };
        })
        .filter((rect) => rect.bottom > rect.top)
        .toSorted((left, right) => left.top - right.top);
      return bounds.slice(1).flatMap((current, index) => {
        const previous = bounds[index];
        return previous && current.top < previous.bottom - 0.5
          ? [{ current: current.key, previous: previous.key }]
          : [];
      });
    });
    expect(overlappingRows).toEqual([]);

    const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
      await page.screenshot({
        path: path.join(artifactDir, "cross-session-run-isolation.png"),
        fullPage: true,
      });
    }

    await context.close();
  });
});
