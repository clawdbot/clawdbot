import { describe, expect, it, vi } from "vitest";
import { finalizeEmbeddedAttempt } from "./attempt-finalize.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

describe("finalizeEmbeddedAttempt trajectory capture", () => {
  it.each([
    {
      name: "prefers the completed assistant for normal completion",
      terminal: { kind: "ok" },
      currentStopReason: "length",
      completedStopReason: "stop",
      expectedStopReason: "stop",
      expectedFinalStatus: "success",
    },
    {
      name: "uses the current assistant for length truncation",
      terminal: { kind: "ok" },
      currentStopReason: "length",
      expectedStopReason: "length",
      expectedFinalStatus: "error",
    },
    {
      name: "does not publish an assistant reason for a prompt timeout",
      terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
      currentStopReason: "stop",
      expectedStopReason: undefined,
      expectedFinalStatus: "interrupted",
    },
    {
      name: "keeps external abort ownership ahead of assistant metadata",
      terminal: { kind: "aborted", source: "external" },
      currentStopReason: "stop",
      expectedStopReason: "aborted",
      expectedFinalStatus: "interrupted",
    },
    {
      name: "publishes the current provider assistant error",
      terminal: { kind: "ok" },
      currentStopReason: "error",
      expectedStopReason: "error",
      expectedFinalStatus: "error",
    },
    {
      name: "does not inherit assistant metadata for a prompt error",
      terminal: { kind: "failed", source: "prompt", error: new Error("prompt failed") },
      currentStopReason: "error",
      expectedStopReason: undefined,
      expectedFinalStatus: "error",
    },
  ])(
    "$name",
    ({
      terminal,
      currentStopReason,
      completedStopReason,
      expectedStopReason,
      expectedFinalStatus,
    }) => {
      const recordEvent = vi.fn();
      const assistant = (stopReason: string, text?: string) => ({
        stopReason,
        content: text ? [{ type: "text", text }] : [],
        ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
      });
      const result = {
        terminal,
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: false,
        didSendDeterministicApprovalPrompt: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        acceptedSessionSpawns: [],
        clientToolCalls: [],
        lastAssistant: assistant("toolUse"),
        currentAttemptAssistant: assistant(currentStopReason, "current attempt fallback"),
        ...(completedStopReason
          ? {
              currentAttemptCompletedAssistant: assistant(
                completedStopReason,
                "completed attempt fallback",
              ),
            }
          : {}),
        messagesSnapshot: [
          {
            role: "user",
            content: "inspect",
            __openclaw: {
              media: [{ path: "/media/canonical.png", contentType: "image/png" }],
            },
          },
        ],
      } as unknown as EmbeddedRunAttemptResult;

      finalizeEmbeddedAttempt({
        result,
        trajectoryRecorder: { recordEvent } as never,
        synthesizedPayloadCount: 0,
        emptyAssistantReplyIsSilent: false,
        hasTerminalOutput: false,
      });

      const modelCompleted = recordEvent.mock.calls.find(
        ([type]) => type === "model.completed",
      )?.[1] as Record<string, unknown> | undefined;
      const artifacts = recordEvent.mock.calls.find(([type]) => type === "trace.artifacts")?.[1] as
        | Record<string, unknown>
        | undefined;
      const captured = (modelCompleted?.messagesSnapshot as Array<Record<string, unknown>>)?.[0];
      expect(modelCompleted).toHaveProperty("stopReason", expectedStopReason);
      expect(artifacts).toHaveProperty("stopReason", expectedStopReason);
      expect(artifacts).toHaveProperty("finalStatus", expectedFinalStatus);
      expect(captured).not.toHaveProperty("MediaPath");
      expect(captured).not.toHaveProperty("MediaType");
      expect(captured?.["__openclaw"]).toMatchObject({
        media: [{ path: "/media/canonical.png", contentType: "image/png" }],
      });
    },
  );
});
