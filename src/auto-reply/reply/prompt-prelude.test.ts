// Tests prompt prelude construction for sender, routing, and context metadata.
import { describe, expect, it } from "vitest";
import { MESSAGE_TOOL_ONLY_DELIVERY_HINT } from "../../plugin-sdk/message-tool-delivery-hints.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { buildReplyPromptEnvelope } from "./prompt-prelude.js";

function countOccurrences(text: string | undefined, needle: string): number {
  return (text?.split(needle).length ?? 1) - 1;
}

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
      inboundUserContext: "Conversation info:\nsender_id=telegram-user-1",
      isBareSessionReset: true,
      startupAction: "reset",
      startupContextPrelude: "Startup context",
    });

    expect(envelope.prefixedCommandBody).toContain("sender_id=telegram-user-1");
    expect(envelope.prefixedCommandBody).toContain("Startup context");
    expect(envelope.transcriptCommandBody).toBe("[OpenClaw session reset]");
    expect(envelope.currentInboundContext).toBeUndefined();
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
    expect(envelope.currentInboundContext).toEqual({
      text: "Current message:\nchat_id=C123",
      fragments: [{ kind: "conversation-data", text: "Current message:\nchat_id=C123" }],
      promptJoiner: " ",
    });
  });

  it("adds one message-tool delivery hint to user-request runtime context only", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "@bot what changed?",
      BodyStripped: "what changed?",
      Provider: "telegram",
      ChatType: "group",
      InboundEventKind: "user_request",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "what changed?",
      prefixedBody: "what changed?",
      hasUserBody: true,
      inboundUserContext: "Current message:\nchat_id=-100123",
      isBareSessionReset: false,
      startupAction: "new",
      inboundEventKind: "user_request",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(
      countOccurrences(envelope.currentInboundContext?.text, MESSAGE_TOOL_ONLY_DELIVERY_HINT),
    ).toBe(1);
    expect(envelope.prefixedCommandBody).toBe("what changed?");
    expect(envelope.transcriptCommandBody).toBe("what changed?");
    expect(envelope.transcriptCommandBody).not.toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT);
  });

  it.each([undefined, "automatic"] as const)(
    "omits user-request delivery hints for %s delivery",
    (sourceReplyDeliveryMode) => {
      const sessionCtx = finalizeInboundContext({
        Body: "@bot what changed?",
        BodyStripped: "what changed?",
        Provider: "telegram",
        ChatType: "group",
        InboundEventKind: "user_request",
      });

      const envelope = buildReplyPromptEnvelope({
        ctx: sessionCtx,
        sessionCtx,
        baseBody: "what changed?",
        prefixedBody: "what changed?",
        hasUserBody: true,
        inboundUserContext: "Current message:\nchat_id=-100123",
        isBareSessionReset: false,
        startupAction: "new",
        inboundEventKind: "user_request",
        sourceReplyDeliveryMode,
      });

      expect(envelope.currentInboundContext?.text).not.toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT);
    },
  );

  it("projects room events as context instead of user requests", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "No wtf",
      BodyStripped: "No wtf",
      Provider: "telegram",
      ChatType: "group",
      InboundEventKind: "room_event",
      MessageSid: "35676",
      SenderName: "Keśava",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "No wtf",
      hasUserBody: true,
      inboundUserContext: [
        "Conversation info:",
        "```json",
        JSON.stringify({ message_id: "35676", inbound_event_kind: "room_event" }, null, 2),
        "```",
        "",
        "Conversation context (chronological, selected for current message):",
        "#35674 Other: I wish I could enjoy 5.5",
        "#35675 User ->#35674: Are you fr fr",
      ].join("\n"),
      isBareSessionReset: false,
      startupAction: "new",
      inboundEventKind: "room_event",
      sourceReplyDeliveryMode: "message_tool_only",
      threadContextNote: "Thread note",
      systemEventBlocks: ["System event"],
    });

    // The active room-event prompt is the attributed transcript row itself, so
    // the turn replays byte-identically as history instead of swapping a
    // placeholder marker for the chat line on the next request.
    expect(envelope.prefixedCommandBody).toBe("#35676 Keśava: No wtf");
    expect(envelope.queuedBody).toBe("#35676 Keśava: No wtf");
    expect(envelope.transcriptCommandBody).toBe("#35676 Keśava: No wtf");
    expect(envelope.queuedBody).toBe(envelope.transcriptCommandBody);
    expect(envelope.currentInboundContext?.text).toBe(
      [
        "[OpenClaw room event]",
        [
          "Room context:",
          "Conversation info:",
          "```json",
          JSON.stringify({ message_id: "35676", inbound_event_kind: "room_event" }, null, 2),
          "```",
          "",
          "Conversation context (chronological, selected for current message):",
          "#35674 Other: I wish I could enjoy 5.5",
          "#35675 User ->#35674: Are you fr fr",
        ].join("\n"),
        "Treat this message as observed room activity, not a request. You were not explicitly tagged or mentioned in this room event. Default: stay silent. Only respond if you have something useful, substantial, or important to add. A previous mention or reply is not an invitation to keep talking. To respond visibly, use message(action=send); your final text here stays private either way.",
        "Thread note",
        "System event",
      ].join("\n\n"),
    );
    // Each room-event fact appears exactly once per request: kind lives in the
    // Conversation info JSON, the event line lives in the user turn body.
    expect(envelope.currentInboundContext?.text).not.toContain("inbound_event_kind: room_event\n");
    expect(envelope.currentInboundContext?.text).not.toContain("Current event:");
    expect(envelope.currentInboundContext?.resumableText).toBe(
      [
        "[OpenClaw room event]",
        [
          "Room context:",
          "Conversation info:",
          "```json",
          JSON.stringify({ message_id: "35676", inbound_event_kind: "room_event" }, null, 2),
          "```",
        ].join("\n"),
        "Treat this message as observed room activity, not a request. You were not explicitly tagged or mentioned in this room event. Default: stay silent. Only respond if you have something useful, substantial, or important to add. A previous mention or reply is not an invitation to keep talking. To respond visibly, use message(action=send); your final text here stays private either way.",
        "Thread note",
        "System event",
      ].join("\n\n"),
    );
    expect(envelope.currentInboundContext?.fragments).toEqual(
      expect.arrayContaining([
        { kind: "conversation-data", text: "Thread note" },
        { kind: "conversation-data", text: "System event" },
      ]),
    );
    expect(envelope.currentInboundContext?.resumableText).not.toContain(
      "Conversation context (chronological, selected for current message):",
    );
  });

  it("uses attributed coalesced room-event lines for current event and transcript", () => {
    const ambientTranscriptBody = ["#35676 Keśava: No wtf", "#35677 Ayaan: fr"].join("\n");
    const sessionCtx = finalizeInboundContext({
      Body: "No wtf\nfr",
      BodyStripped: "No wtf\nfr",
      Provider: "telegram",
      ChatType: "group",
      InboundEventKind: "room_event",
      MessageSid: "35677",
      SenderName: "Ayaan",
      AmbientTranscriptBody: ambientTranscriptBody,
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "No wtf\nfr",
      hasUserBody: true,
      inboundUserContext: "Conversation context:",
      isBareSessionReset: false,
      startupAction: "new",
      inboundEventKind: "room_event",
    });

    expect(envelope.transcriptCommandBody).toBe(ambientTranscriptBody);
    expect(envelope.queuedBody).toBe(ambientTranscriptBody);
    expect(envelope.currentInboundContext?.text).not.toContain(ambientTranscriptBody);
  });

  it("uses the raw current body for room-event current event text", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "[Chat history]\nAlice: old context\n\nBob: current note",
      BodyStripped: "[Chat history]\nAlice: old context\n\nBob: current note",
      RawBody: "current note",
      CommandBody: "current note",
      Provider: "telegram",
      ChatType: "group",
      InboundEventKind: "room_event",
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
      inboundEventKind: "room_event",
    });

    expect(envelope.currentInboundContext?.text).toContain("Room context:");
    expect(envelope.currentInboundContext?.text).toContain("Alice: old context");
    expect(envelope.queuedBody).toBe("#2002 Bob: current note");
    expect(envelope.currentInboundContext?.text).toContain(
      "Treat this message as observed room activity, not a request. You were not explicitly tagged or mentioned in this room event. Default: stay silent. Only respond if you have something useful, substantial, or important to add. A previous mention or reply is not an invitation to keep talking.",
    );
    expect(envelope.currentInboundContext?.text).not.toContain("message(action=send)");
    expect(envelope.currentInboundContext?.text).not.toContain(
      "your final text here stays private",
    );
    expect(envelope.queuedBody).not.toContain("[Chat history]");
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

  it("carries preprojected media without duplicating its model-facing bytes", () => {
    const body = "[media attached: /tmp/tlon.png (image/png) | /tmp/tlon.png]\ninspect this";
    const sessionCtx = finalizeInboundContext({
      Body: body,
      BodyForAgent: body,
      Provider: "tlon",
      ChatType: "direct",
    });
    const media = [{ path: "/tmp/tlon.png", contentType: "image/png", kind: "image" as const }];

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: body,
      hasUserBody: true,
      inboundUserContext: "",
      isBareSessionReset: false,
      startupAction: "new",
      media,
    });

    expect(envelope.prefixedCommandBody).toBe(body);
    expect(envelope.queuedBody).toBe(body);
    expect(envelope.transcriptCommandBody).toBe(body);
    expect(envelope.inboundMediaIndexes).toEqual([]);
    expect(envelope.media).toEqual([
      {
        path: "/tmp/tlon.png",
        url: undefined,
        contentType: "image/png",
        kind: "image",
        transcribed: false,
        messageId: undefined,
      },
    ]);
  });

  it("keeps sparse inbound positions separate from appended preprojected media", () => {
    const sharedPath = "/tmp/shared.png";
    const sessionCtx = finalizeInboundContext({
      Body: "inspect these",
      media: [
        {},
        { path: "/tmp/voice.ogg", contentType: "audio/ogg", transcribed: true },
        { path: sharedPath, contentType: "image/png" },
        { path: sharedPath, contentType: "image/png" },
      ],
    });
    const params = {
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "inspect these",
      hasUserBody: true,
      inboundUserContext: "",
      isBareSessionReset: false,
      startupAction: "new" as const,
      media: [{ path: "/tmp/preprojected.pdf", contentType: "application/pdf" }],
    };
    const first = buildReplyPromptEnvelope(params);
    const rebuilt = buildReplyPromptEnvelope({
      ...params,
      ctx: { ...sessionCtx, media: [...(sessionCtx.media ?? []), { path: "/tmp/later.png" }] },
      systemEventBlocks: ["context changed"],
    });

    expect(first.inboundMediaIndexes).toEqual([2, 3]);
    expect(first.media?.map((fact) => fact.path)).toEqual([
      sharedPath,
      sharedPath,
      "/tmp/preprojected.pdf",
    ]);
    expect(rebuilt.inboundMediaIndexes).toEqual([2, 3, 4]);
    expect(first.prefixedCommandBody).toBe(
      `[media attached: 2 files]\n[media attached 1/2: ${sharedPath} (image/png)]\n[media attached 2/2: ${sharedPath} (image/png)]\ninspect these`,
    );
    expect(first.queuedBody).toBe(first.prefixedCommandBody);
    expect(first.transcriptCommandBody).toBe(first.prefixedCommandBody);
    expect(sessionCtx.media?.map((fact) => fact.path)).toEqual([
      undefined,
      "/tmp/voice.ogg",
      sharedPath,
      sharedPath,
    ]);
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
      inboundUserContext: 'Conversation info:\n{"sender":{"id":"U123"}}',
      isBareSessionReset: true,
      startupAction: "reset",
      startupContextPrelude: "Startup context",
      softResetTail: "re-read persona files",
    });

    expect(envelope.prefixedCommandBody).toContain("Conversation info:");
    expect(envelope.prefixedCommandBody).toContain("Startup context");
    expect(envelope.prefixedCommandBody).toContain("re-read persona files");
    expect(envelope.transcriptCommandBody).toBe("re-read persona files");
    expect(envelope.transcriptCommandBody).not.toContain("Startup context");
  });
});
