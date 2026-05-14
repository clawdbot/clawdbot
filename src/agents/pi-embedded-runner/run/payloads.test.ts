import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import type { InteractiveReply, MessagePresentation } from "../../../interactive/payload.js";
import {
  buildPayloads,
  expectSinglePayloadText,
  expectSingleToolErrorPayload,
} from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads tool-error warnings", () => {
  function expectNoPayloads(params: Parameters<typeof buildPayloads>[0]) {
    const payloads = buildPayloads(params);
    expect(payloads).toHaveLength(0);
  }

  it("does not fall back to commentary-only assistant text when streamed text was suppressed", () => {
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "text",
            text: "Need update cron messages to use finalBrief/briefPath.",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_commentary",
              phase: "commentary",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expect(payloads).toStrictEqual([]);
  });

  it("falls back to final-answer assistant text when streamed text is unavailable", () => {
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "Need inspect.",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_commentary",
              phase: "commentary",
            }),
          },
          {
            type: "text",
            text: "Done.",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expectSinglePayloadText(payloads, "Done.");
  });

  it("falls back to final-answer assistant text when streamed text only contains blanks", () => {
    const payloads = buildPayloads({
      assistantTexts: ["   "],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "Fixed.",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expectSinglePayloadText(payloads, "Fixed.");
  });

  it("delivers only the final assistant answer when accumulated text includes pre-tool progress", () => {
    const payloads = buildPayloads({
      assistantTexts: ["I'll inspect that first.", "Done."],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "Done.",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expectSinglePayloadText(payloads, "Done.");
  });

  it("does not replay raw-looking accumulated tool output when final answer text is available", () => {
    const payloads = buildPayloads({
      assistantTexts: [
        "/root/openclaw/src/gateway/protocol/schema/protocol-schemas.ts:181:  PluginControlUiDescriptorSchema,",
        "The schema export is fixed.",
      ],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "The schema export is fixed.",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expectSinglePayloadText(payloads, "The schema export is fixed.");
  });

  it("turns internal message-tool source replies into suppression-safe final payloads", () => {
    const payloads = buildPayloads({
      assistantTexts: ["ordinary final should stay private"],
      didSendViaMessagingTool: true,
      messagingToolSourceReplyPayloads: [
        {
          text: "sent through message tool",
          mediaUrls: ["/tmp/reply.png"],
        },
      ],
      sourceReplyDeliveryMode: "message_tool_only",
      sessionKey: "agent:main",
      agentId: "main",
      runId: "run-1",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      text: "sent through message tool",
      mediaUrl: "/tmp/reply.png",
      mediaUrls: ["/tmp/reply.png"],
    });
    expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main",
        agentId: "main",
        text: "sent through message tool",
        mediaUrls: ["/tmp/reply.png"],
        idempotencyKey: "run-1:internal-source-reply:0",
      },
    });
  });

  it("preserves rich-only internal message-tool source replies", () => {
    const presentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Approve", value: "approve" }],
        },
      ],
    } satisfies MessagePresentation;
    const interactive = {
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Open", value: "open" }],
        },
      ],
    } satisfies InteractiveReply;

    const payloads = buildPayloads({
      assistantTexts: ["ordinary final should stay private"],
      didSendViaMessagingTool: true,
      messagingToolSourceReplyPayloads: [
        {
          presentation,
        },
        {
          interactive,
        },
      ],
      sourceReplyDeliveryMode: "message_tool_only",
      sessionKey: "agent:main",
      agentId: "main",
      runId: "run-1",
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ presentation });
    expect(payloads[0]?.text).toBeUndefined();
    expect(payloads[1]).toMatchObject({ interactive });
    expect(payloads[1]?.text).toBeUndefined();
    expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main",
        agentId: "main",
        idempotencyKey: "run-1:internal-source-reply:0",
      },
    });
    expect(getReplyPayloadMetadata(payloads[1] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main",
        agentId: "main",
        idempotencyKey: "run-1:internal-source-reply:1",
      },
    });
  });

  it("ignores accumulated internal/status text after the final answer", () => {
    const payloads = buildPayloads({
      assistantTexts: [
        "Done.",
        "Background task done: Context engine turn maintenance. Rewrote 0 transcript entries and freed 0 bytes.",
      ],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "Done.",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expectSinglePayloadText(payloads, "Done.");
  });

  it("surfaces concise exec tool errors when verbose mode is off", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      absentDetail: "command failed",
    });
  });

  it("surfaces concise bash tool errors when verbose mode is off", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "bash", error: "command failed" },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Bash",
      absentDetail: "command failed",
    });
  });

  it("surfaces exec tool errors for cron sessions even when verbose mode is off", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        timedOut: true,
        error:
          "Command timed out after 1800 seconds. If this command is expected to take longer, re-run with a higher timeout (e.g., exec timeout=300).",
      },
      sessionKey: "agent:main:cron:job-1",
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      detail:
        "Command timed out after 1800 seconds. If this command is expected to take longer, re-run with a higher timeout (e.g., exec timeout=300).",
    });
  });

  it("surfaces timed-out exec tool errors for cron-triggered custom session keys", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        timedOut: true,
        error: "Command timed out after 1800 seconds.",
      },
      sessionKey: "agent:main:project-alpha",
      isCronTrigger: true,
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      detail: "Command timed out after 1800 seconds.",
    });
  });

  it("surfaces non-timeout exec tool errors for cron sessions without raw details", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "exec", error: "Command not found" },
      sessionKey: "agent:main:cron:job-1",
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      absentDetail: "Command not found",
    });
  });

  it("shows exec tool errors when verbose mode is on", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "on",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      detail: "command failed",
    });
  });

  it("keeps non-exec mutating tool failures visible", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      absentDetail: "permission denied",
    });
  });

  it.each([
    {
      name: "includes details for mutating tool failures when verbose is on",
      verboseLevel: "on" as const,
      detail: "permission denied",
      absentDetail: undefined,
    },
    {
      name: "includes details for mutating tool failures when verbose is full",
      verboseLevel: "full" as const,
      detail: "permission denied",
      absentDetail: undefined,
    },
  ])("$name", ({ verboseLevel, detail, absentDetail }) => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel,
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      detail,
      absentDetail,
    });
  });

  it.each([
    {
      name: "default relay failure",
      lastToolError: { toolName: "sessions_send", error: "delivery timeout" },
    },
    {
      name: "mutating relay failure",
      lastToolError: {
        toolName: "sessions_send",
        error: "delivery timeout",
        mutatingAction: true,
      },
    },
  ])("suppresses sessions_send errors for $name", ({ lastToolError }) => {
    expectNoPayloads({
      lastToolError,
      verboseLevel: "on",
    });
  });

  it("suppresses assistant text when a deterministic exec approval prompt was already delivered", () => {
    expectNoPayloads({
      assistantTexts: ["Approval is needed. Please run /approve abc allow-once"],
      didSendDeterministicApprovalPrompt: true,
    });
  });

  it("suppresses JSON NO_REPLY assistant payloads", () => {
    expectNoPayloads({
      assistantTexts: ['{"action":"NO_REPLY"}'],
    });
  });

  it("strips NO_REPLY text but keeps voice media directives", () => {
    const payloads = buildPayloads({
      assistantTexts: ["NO_REPLY\nMEDIA:/tmp/openclaw/tts-a/voice-a.opus\n[[audio_as_voice]]"],
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.mediaUrl).toBe("/tmp/openclaw/tts-a/voice-a.opus");
    expect(payloads[0]?.mediaUrls).toEqual(["/tmp/openclaw/tts-a/voice-a.opus"]);
    expect(payloads[0]?.audioAsVoice).toBe(true);
    expect(payloads[0]?.text).toBeUndefined();
  });

  it("preserves media directives when stored assistant text was reduced to visible text only", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Attached image"],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "MEDIA:/tmp/reply-image.png\nAttached image",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Attached image");
    expect(payloads[0]?.mediaUrl).toBe("/tmp/reply-image.png");
    expect(payloads[0]?.mediaUrls).toEqual(["/tmp/reply-image.png"]);
  });

  it("keeps media directives when collapsing accumulated pre-tool text to the final answer", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Preparing the image...", "Attached image"],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "MEDIA:/tmp/reply-image.png\nAttached image",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Attached image");
    expect(payloads[0]?.mediaUrl).toBe("/tmp/reply-image.png");
    expect(payloads[0]?.mediaUrls).toEqual(["/tmp/reply-image.png"]);
  });

  it("uses raw final assistant text when visible-text extraction removed a media-only directive line", () => {
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "MEDIA:/tmp/reply-image.png\nAttached image",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Attached image");
    expect(payloads[0]?.mediaUrl).toBe("/tmp/reply-image.png");
    expect(payloads[0]?.mediaUrls).toEqual(["/tmp/reply-image.png"]);
  });

  it("suppresses native reasoning payloads when thinking is disabled", () => {
    const payloads = buildPayloads({
      reasoningLevel: "on",
      thinkingLevel: "off",
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "thinking",
            thinking: "",
            thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_live", summary: [] }),
          },
          { type: "text", text: "THINKING-OFF-OK" },
        ],
      } as AssistantMessage,
    });

    expectSinglePayloadText(payloads, "THINKING-OFF-OK");
  });
});
