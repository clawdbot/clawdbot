import { describe, expect, it } from "vitest";
import { finalizeInboundContext } from "./inbound-context.js";
import { buildReplyPromptEnvelope } from "./prompt-prelude.js";

describe("buildReplyPromptEnvelope", () => {
  it("keeps bare reset runtime context in the model prompt and out of transcript/current-turn context", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "",
      BodyStripped: "",
      Provider: "telegram",
      ChatType: "direct",
      SenderId: "telegram-user-1",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "A new session was started via /new or /reset.",
      hasUserBody: true,
      inboundUserContext: "Conversation info (untrusted metadata):\nsender_id=telegram-user-1",
      isBareSessionReset: true,
      startupAction: "reset",
      startupContextPrelude: "Startup context",
    });

    expect(envelope.prefixedCommandBody).toContain("sender_id=telegram-user-1");
    expect(envelope.prefixedCommandBody).toContain("Startup context");
    expect(envelope.transcriptCommandBody).toBe("[OpenClaw session reset]");
    expect(envelope.currentTurnContext).toBeUndefined();
  });

  it("keeps ordinary inbound context runtime-only while preserving transcript text", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "what changed?",
      BodyStripped: "what changed?",
      Provider: "slack",
      ChatType: "group",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "what changed?",
      prefixedBody: "what changed?",
      hasUserBody: true,
      inboundUserContext: "Current message:\nchat_id=C123",
      inboundUserContextPromptJoiner: " ",
      isBareSessionReset: false,
      startupAction: "new",
    });

    expect(envelope.prefixedCommandBody).toBe("what changed?");
    expect(envelope.transcriptCommandBody).toBe("what changed?");
    expect(envelope.currentTurnContext).toEqual({
      text: "Current message:\nchat_id=C123",
      promptJoiner: " ",
    });
  });

  it("projects room events as context instead of user requests", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "No wtf",
      BodyStripped: "No wtf",
      Provider: "telegram",
      ChatType: "group",
      InboundTurnKind: "room_event",
      MessageSid: "35676",
      SenderName: "Keśava",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "No wtf",
      hasUserBody: true,
      inboundUserContext: [
        "Conversation info (untrusted metadata):",
        "```json",
        JSON.stringify({ message_id: "35676", turn_kind: "room_event" }, null, 2),
        "```",
        "",
        "Conversation context (untrusted, chronological, selected for current message):",
        "#35674 Other: I wish I could enjoy 5.5",
        "#35675 User ->#35674: Are you fr fr",
      ].join("\n"),
      isBareSessionReset: false,
      startupAction: "new",
      turnKind: "room_event",
    });

    expect(envelope.prefixedCommandBody).toBe("[OpenClaw room event]");
    expect(envelope.queuedBody).toBe("[OpenClaw room event]");
    expect(envelope.transcriptCommandBody).toBe("");
    expect(envelope.currentTurnContext?.text).toBe(
      [
        "[OpenClaw turn]",
        "kind: room_event",
        "visible_reply_contract: message_tool_only",
        [
          "Room context:",
          "Conversation info (untrusted metadata):",
          "```json",
          JSON.stringify({ message_id: "35676", turn_kind: "room_event" }, null, 2),
          "```",
          "",
          "Conversation context (untrusted, chronological, selected for current message):",
          "#35674 Other: I wish I could enjoy 5.5",
          "#35675 User ->#35674: Are you fr fr",
        ].join("\n"),
        "Current event:\n#35676 Keśava: No wtf",
        "Treat this as observed room activity. Decide whether to act.",
      ].join("\n\n"),
    );
  });

  it("uses the raw current body for room-event current event text", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "[Chat history]\nAlice: old context\n\nBob: current note",
      BodyStripped: "[Chat history]\nAlice: old context\n\nBob: current note",
      RawBody: "current note",
      CommandBody: "current note",
      Provider: "telegram",
      ChatType: "group",
      InboundTurnKind: "room_event",
      MessageSid: "2002",
      SenderName: "Bob",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: sessionCtx.Body ?? "",
      hasUserBody: true,
      inboundUserContext: "Chat history since last reply:\nAlice: old context",
      isBareSessionReset: false,
      startupAction: "new",
      turnKind: "room_event",
    });

    expect(envelope.currentTurnContext?.text).toContain("Room context:");
    expect(envelope.currentTurnContext?.text).toContain("Alice: old context");
    expect(envelope.currentTurnContext?.text).toContain("Current event:\n#2002 Bob: current note");
    expect(envelope.currentTurnContext?.text).not.toContain(
      "Current event:\n#2002 Bob: [Chat history]",
    );
  });

  it("keeps media-only notes in ordinary user request transcripts", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "",
      BodyStripped: "",
      Provider: "telegram",
      ChatType: "group",
      MediaPaths: ["/tmp/openclaw-photo.jpg"],
      MediaUrls: ["https://example.com/photo.jpg"],
      InboundHistory: [{ sender: "Alice", timestamp: 1_700_000_000_000, body: "context" }],
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "",
      hasUserBody: true,
      inboundUserContext: "Current message:\nchat_id=G1",
      isBareSessionReset: false,
      startupAction: "new",
    });

    expect(envelope.transcriptCommandBody).toContain("[media attached");
    expect(envelope.transcriptCommandBody).toContain("https://example.com/photo.jpg");
  });

  it("keeps soft reset user notes visible without leaking startup context into transcripts", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "",
      BodyStripped: "",
      Provider: "slack",
      ChatType: "direct",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "",
      hasUserBody: true,
      inboundUserContext: "Sender (untrusted metadata):\nsender_id=U123",
      isBareSessionReset: true,
      startupAction: "reset",
      startupContextPrelude: "Startup context",
      softResetTail: "re-read persona files",
    });

    expect(envelope.prefixedCommandBody).toContain("Sender (untrusted metadata):");
    expect(envelope.prefixedCommandBody).toContain("Startup context");
    expect(envelope.prefixedCommandBody).toContain("re-read persona files");
    expect(envelope.transcriptCommandBody).toBe("re-read persona files");
    expect(envelope.transcriptCommandBody).not.toContain("Startup context");
  });
});
