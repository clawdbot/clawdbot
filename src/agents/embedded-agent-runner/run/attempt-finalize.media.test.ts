import { describe, expect, it, vi } from "vitest";
import { finalizeEmbeddedAttempt } from "./attempt-finalize.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

describe("finalizeEmbeddedAttempt media trajectory capture", () => {
  it("records canonical message snapshots without reprojecting them", () => {
    const recordEvent = vi.fn();
    const result = {
      terminal: { kind: "ok" },
      assistantTexts: ["done"],
      toolMetas: [],
      didSendViaMessagingTool: false,
      didSendDeterministicApprovalPrompt: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      acceptedSessionSpawns: [],
      clientToolCalls: [],
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
      hasTerminalOutput: true,
    });

    const modelCompleted = recordEvent.mock.calls.find(
      ([type]) => type === "model.completed",
    )?.[1] as { messagesSnapshot?: Array<Record<string, unknown>> } | undefined;
    const captured = modelCompleted?.messagesSnapshot?.[0];
    expect(captured).not.toHaveProperty("MediaPath");
    expect(captured).not.toHaveProperty("MediaType");
    expect(captured?.["__openclaw"]).toMatchObject({
      media: [{ path: "/media/canonical.png", contentType: "image/png" }],
    });
  });
});
