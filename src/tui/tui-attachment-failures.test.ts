import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { ChatLog } from "./components/chat-log.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import { extractTextFromMessage, extractTuiAbortedText } from "./tui-formatters.js";
import { getTuiSessionProjection, reduceTuiSessionProjection } from "./tui-session-projection.js";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";
import type { TuiStateAccess } from "./tui-types.js";

const audioFailure = {
  type: "attachment_error",
  attachment: { code: "delivery-failed", kind: "audio", label: "Generated audio 1" },
};
const audioReceipt = "⚠️ audio attachment: Delivery failed. Try sending this file again.";
const caption = { type: "text", text: "Your recording" };
const image = { type: "image", url: "file:///private/image.png" };
const assistant = (content: unknown[]) => ({ role: "assistant", content });

function createDisplayHarness() {
  const state: TuiStateAccess = {
    agentDefaultId: "main",
    sessionMainKey: "main",
    sessionScope: "per-sender",
    agents: [],
    currentAgentId: "main",
    currentSessionKey: "agent:main:main",
    currentSessionId: "session-1",
    activeChatRunId: null,
    pendingSubmit: null,
    historyLoaded: true,
    sessionInfo: {},
    initialSessionApplied: true,
    isConnected: true,
    autoMessageSent: false,
    toolsExpanded: false,
    showThinking: false,
    connectionStatus: "connected",
    activityStatus: "idle",
    statusTimeout: null,
    lastCtrlCAt: 0,
  };
  const chatLog = new ChatLog();
  const handlers = createEventHandlers({
    state,
    chatLog,
    tui: { requestRender: vi.fn() },
    btw: { clear: vi.fn(), showResult: vi.fn() },
    setActivityStatus: (value) => {
      state.activityStatus = value;
    },
    loadHistory: async () => ({ loaded: false }),
    streamingWatchdogMs: 0,
  });
  return {
    state,
    chatLog,
    ...handlers,
    visible: () =>
      chatLog
        .render(160)
        .map((line) => stripAnsi(line).trimEnd())
        .join("\n")
        .trim(),
  };
}

describe("TUI attachment failure presentation", () => {
  it.each([
    { name: "failure only", content: [audioFailure], expected: audioReceipt },
    {
      name: "caption and failure",
      content: [caption, audioFailure],
      expected: `Your recording\n${audioReceipt}`,
    },
    {
      name: "success and failure",
      content: [image, audioFailure],
      expected: `Attached image\n${audioReceipt}`,
    },
    {
      name: "caption, success and failure",
      content: [caption, image, audioFailure],
      expected: `Your recording\n${audioReceipt}`,
    },
    {
      name: "multiple failures",
      content: [audioFailure, audioFailure],
      expected: `${audioReceipt}\n${audioReceipt}`,
    },
  ])("keeps $name in history and final output", ({ content, expected }) => {
    const message = assistant(content);
    expect(extractTextFromMessage(message)).toBe(expected);
    expect(new TuiStreamAssembler().finalize("run-1", message, false)).toBe(expected);
  });

  it.each([
    {
      kind: "image",
      code: "file-not-found",
      expected: "⚠️ image attachment: File not found. Check the path and try again.",
    },
    {
      kind: "video",
      code: "unsupported-format",
      expected:
        "⚠️ video attachment: Rejected by the local attachment allowlist. Send a supported file type.",
    },
    {
      kind: "document",
      code: "delivery-failed",
      expected: "⚠️ file attachment: Delivery failed. Try sending this file again.",
    },
  ])(
    "renders actionable $kind/$code receipts without source metadata",
    ({ kind, code, expected }) => {
      const message = assistant([
        {
          type: "attachment_error",
          attachment: {
            kind,
            code,
            label: "\x1b]52;c;private-clipboard\x07file:///private/name",
            url: "https://private.invalid/file?ticket=private",
            mimeType: "private/type",
          },
        },
      ]);
      expect(extractTextFromMessage(message)).toBe(expected);
      expect(new TuiStreamAssembler().finalize("run-1", message, false)).toBe(expected);
    },
  );

  it.each([false, true])(
    "retains streamed captions and thinking visibility (%s) before a failure-only final",
    (showThinking) => {
      const assembler = new TuiStreamAssembler();
      assembler.ingestDelta(
        "run-1",
        assistant([caption, { type: "thinking", thinking: "Preparing" }]),
        showThinking,
      );
      expect(assembler.finalize("run-1", assistant([audioFailure]), showThinking)).toBe(
        `${showThinking ? "[thinking]\nPreparing\n\n" : ""}Your recording\n${audioReceipt}`,
      );
    },
  );

  it("keeps genuine errors ahead of success fallback while appending the failure receipt", () => {
    const message = {
      ...assistant([image, audioFailure]),
      stopReason: "error",
      errorMessage: "generation stopped",
    };
    expect(extractTextFromMessage(message)).toBe(`generation stopped\n${audioReceipt}`);
    expect(
      new TuiStreamAssembler().finalize(
        "run-1",
        assistant([image, audioFailure]),
        false,
        "generation stopped",
      ),
    ).toBe(`generation stopped\n${audioReceipt}`);
  });

  it.each([
    { name: "failure only", content: [audioFailure], streamed: false, expected: audioReceipt },
    {
      name: "mixed attachments",
      content: [image, audioFailure],
      streamed: false,
      expected: `Attached image\n${audioReceipt}`,
    },
    {
      name: "streamed caption",
      content: [image, audioFailure],
      streamed: true,
      expected: `Your recording\n${audioReceipt}`,
    },
  ])(
    "renders one receipt through optimistic and authoritative history: $name",
    ({ content, streamed, expected }) => {
      const harness = createDisplayHarness();
      const event = { runId: "run-1", sessionKey: harness.state.currentSessionKey };
      try {
        if (streamed) {
          harness.handleChatEvent({ ...event, state: "delta", message: assistant([caption]) });
          expect(harness.visible()).toBe("Your recording");
        }
        const message = assistant(content);
        harness.handleChatEvent({ ...event, state: "final", message });
        expect(harness.visible()).toBe(expected);
        expect(harness.state.activityStatus).toBe("idle");

        for (const messages of [
          [],
          [
            {
              ...assistant(streamed ? [caption, ...content] : content),
              __openclaw: { id: "assistant-1", seq: 1, runId: event.runId },
            },
          ],
        ]) {
          const projection = reduceTuiSessionProjection(harness.state, {
            type: "snapshotLoaded",
            messages,
          });
          expect(projection.messages).toHaveLength(1);
          harness.chatLog.clearAll();
          for (const row of projection.messages) {
            harness.chatLog.finalizeAssistant(extractTextFromMessage(row));
          }
          expect(harness.visible()).toBe(expected);
        }
      } finally {
        harness.dispose();
      }
    },
  );

  it("keeps failure-only aborts diagnostic and ignores a late attachment final", () => {
    const harness = createDisplayHarness();
    const event = {
      runId: "run-1",
      sessionKey: harness.state.currentSessionKey,
      message: assistant([audioFailure]),
    };
    try {
      expect(extractTuiAbortedText(event.message, false)).toBe("");
      harness.handleChatEvent({ ...event, state: "aborted" });
      harness.handleChatEvent({ ...event, state: "final" });
      expect(harness.visible()).toBe("run aborted");
      expect(getTuiSessionProjection(harness.state).messages).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it("does not invent failure output for empty or unsupported blocks", () => {
    for (const content of [
      [],
      [{ type: "tool_use", name: "search" }],
      [{ type: "attachment_error", attachment: { code: "unknown", kind: "audio" } }],
    ]) {
      const message = assistant(content);
      expect(extractTextFromMessage(message)).toBe("");
      expect(new TuiStreamAssembler().finalize("run-1", message, false)).toBe("(no output)");
    }
  });
});
