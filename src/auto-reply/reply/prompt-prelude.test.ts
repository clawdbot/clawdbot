// Tests prompt prelude construction for sender, routing, and context metadata.
import { describe, expect, it } from "vitest";
import {
  buildCurrentInboundPrompt,
  buildCurrentInboundSystemPromptContext,
} from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
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
      countOccurrences(
        envelope.currentInboundContext?.trustedDeliveryDirective,
        MESSAGE_TOOL_ONLY_DELIVERY_HINT,
      ),
    ).toBe(1);
    expect(envelope.currentInboundContext?.text).not.toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT);
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

      expect(envelope.currentInboundContext?.trustedDeliveryDirective).toBeUndefined();
    },
  );

  it("carries Telegram forum reply metadata in current-turn runtime context", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "Sean, answer this old reply",
      BodyStripped: "Sean, answer this old reply",
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      MessageSid: "34974",
      MessageThreadId: 777,
      ReplyToId: "34971",
      ReplyToBody: "old target body",
      ReplyToSender: "Alice",
      ReplyChain: [
        {
          messageId: "34971",
          threadId: "777",
          sender: "Alice",
          body: "old target body",
        },
      ],
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "Sean, answer this old reply",
      prefixedBody: "Sean, answer this old reply",
      hasUserBody: true,
      inboundUserContext: "Conversation info:\nreply_to_id=34971",
      isBareSessionReset: false,
      startupAction: "new",
    });

    expect(envelope.currentInboundContext?.reply).toEqual({
      replyTargetPresent: true,
      quotePresent: false,
      replyChainPresent: true,
    });
    expect(envelope.currentInboundContext?.replyIdentifiers).toEqual({
      currentMessageId: "34974",
      threadId: "777",
      replyToId: "34971",
      replyChainMessageIds: ["34971"],
    });

    const runtimePrefix = buildCurrentInboundPrompt({
      context: envelope.currentInboundContext,
      prompt: "",
    });
    const systemContext = buildCurrentInboundSystemPromptContext(envelope.currentInboundContext);
    expect(systemContext).toContain("Current reply metadata (trusted OpenClaw runtime metadata):");
    expect(runtimePrefix).not.toContain("Current reply metadata");
    expect(runtimePrefix).toContain("Current reply identifiers (untrusted provider metadata):");
    expect(runtimePrefix).toContain("Conversation info");
  });

  it("retains at most 20 nearest generic reply-chain identifiers", () => {
    const replyChain = Array.from({ length: 25 }, (_, index) => ({
      messageId: `generic-reply-${index}`,
    }));
    const sessionCtx = finalizeInboundContext({
      Body: "inspect the reply chain",
      BodyStripped: "inspect the reply chain",
      Provider: "generic-test-channel",
      ChatType: "group",
      ReplyChain: replyChain,
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "inspect the reply chain",
      hasUserBody: true,
      inboundUserContext: "",
      isBareSessionReset: false,
      startupAction: "new",
    });

    expect(envelope.currentInboundContext?.replyIdentifiers?.replyChainMessageIds).toEqual(
      replyChain.slice(0, 20).map((entry) => entry.messageId),
    );
    expect(envelope.currentInboundContext?.reply).toMatchObject({
      replyTargetPresent: true,
      replyChainPresent: true,
    });
  });

  it("bounds exact reply identifiers and their pretty-serialized untrusted aggregate", () => {
    const oversizedId = `oversized-${"x".repeat(256)}`;
    const escapedId = (index: number) =>
      `chain-${index.toString().padStart(2, "0")}-${'\\"'.repeat(120)}`;
    const chainIds = [
      escapedId(0),
      oversizedId,
      ...Array.from({ length: 18 }, (_, index) => escapedId(index + 1)),
    ];
    const sessionCtx = finalizeInboundContext({
      Body: "inspect oversized reply metadata",
      BodyStripped: "inspect oversized reply metadata",
      Provider: "generic-test-channel",
      ChatType: "group",
      MessageSid: oversizedId,
      MessageSidFull: "current-message-full",
      MessageThreadId: escapedId(90),
      ReplyToId: oversizedId,
      ReplyToIdFull: escapedId(91),
      ReplyChain: chainIds.map((messageId) => ({ messageId })),
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "inspect oversized reply metadata",
      hasUserBody: true,
      inboundUserContext: "",
      isBareSessionReset: false,
      startupAction: "new",
    });

    const reply = envelope.currentInboundContext?.reply;
    const replyIdentifiers = envelope.currentInboundContext?.replyIdentifiers;
    expect(replyIdentifiers).toMatchObject({
      currentMessageId: "current-message-full",
    });
    expect(reply).toMatchObject({
      replyTargetPresent: true,
      replyChainPresent: true,
    });
    expect(replyIdentifiers?.replyToId).toBeUndefined();
    expect(replyIdentifiers?.replyToIdFull).toBeUndefined();
    expect(replyIdentifiers?.replyChainMessageIds).toBeUndefined();
    expect(JSON.stringify(replyIdentifiers, null, 2).length).toBeLessThanOrEqual(4_096);

    const runtimePrefix = buildCurrentInboundPrompt({
      context: envelope.currentInboundContext,
      prompt: "",
    });
    expect(runtimePrefix).toContain("current-message-full");
    expect(runtimePrefix).not.toContain(oversizedId);
  });

  it("retains the reply anchor first when scalar metadata reaches the aggregate budget", () => {
    const escapedControlId = (prefix: string) => `${prefix}${"\u0001".repeat(256 - prefix.length)}`;
    const sessionCtx = finalizeInboundContext({
      Body: "inspect scalar reply metadata",
      BodyStripped: "inspect scalar reply metadata",
      Provider: "generic-test-channel",
      ChatType: "group",
      MessageSid: escapedControlId("current-"),
      MessageThreadId: escapedControlId("thread-"),
      ReplyToId: "reply-anchor",
      ReplyToIdFull: escapedControlId("reply-full-"),
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "inspect scalar reply metadata",
      hasUserBody: true,
      inboundUserContext: "",
      isBareSessionReset: false,
      startupAction: "new",
    });

    const replyIdentifiers = envelope.currentInboundContext?.replyIdentifiers;
    expect(replyIdentifiers?.replyToId).toBe("reply-anchor");
    expect(replyIdentifiers?.currentMessageId).toBeUndefined();
    expect(replyIdentifiers?.threadId).toBeUndefined();
    expect(replyIdentifiers?.replyToIdFull).toBeUndefined();
    expect(
      Buffer.byteLength(JSON.stringify(replyIdentifiers ?? {}, null, 2), "utf8"),
    ).toBeLessThanOrEqual(880);
  });

  it.each([
    {
      label: "escaped control",
      buildId: (index: number) =>
        `control-${index.toString().padStart(2, "0")}-${"\u0001".repeat(100)}`,
    },
    {
      label: "CJK",
      buildId: (index: number) => `cjk-${index.toString().padStart(2, "0")}-${"漢".repeat(240)}`,
    },
    {
      label: "high-entropy ASCII",
      buildId: (index: number) =>
        `random-${index.toString().padStart(2, "0")}-${Array.from({ length: 240 }, (_, offset) =>
          String.fromCharCode(33 + ((index * 53 + offset * 47) % 94)),
        ).join("")}`,
    },
  ])("bounds $label reply chains by conservative serialized token pressure", ({ buildId }) => {
    const chainIds = Array.from({ length: 20 }, (_, index) => buildId(index));
    const sessionCtx = finalizeInboundContext({
      Body: "inspect adversarial reply metadata",
      BodyStripped: "inspect adversarial reply metadata",
      Provider: "generic-test-channel",
      ChatType: "group",
      ReplyChain: chainIds.map((messageId) => ({ messageId })),
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "inspect adversarial reply metadata",
      hasUserBody: true,
      inboundUserContext: "",
      isBareSessionReset: false,
      startupAction: "new",
    });

    const replyIdentifiers = envelope.currentInboundContext?.replyIdentifiers;
    const retainedIds = replyIdentifiers?.replyChainMessageIds ?? [];
    const serialized = JSON.stringify(replyIdentifiers ?? {}, null, 2);
    expect(retainedIds.length).toBeGreaterThan(0);
    expect(retainedIds.length).toBeLessThan(chainIds.length);
    expect(retainedIds).toEqual(chainIds.slice(0, retainedIds.length));
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(880);
    expect(envelope.currentInboundContext?.reply).toEqual({
      replyTargetPresent: true,
      quotePresent: false,
      replyChainPresent: true,
    });
  });

  it("keeps reply-presence facts when every opaque identifier is oversized", () => {
    const oversizedId = "x".repeat(257);
    const sessionCtx = finalizeInboundContext({
      Body: "inspect the reply",
      BodyStripped: "inspect the reply",
      Provider: "generic-test-channel",
      ChatType: "group",
      ReplyToId: oversizedId,
      ReplyChain: [{ messageId: oversizedId }],
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "inspect the reply",
      hasUserBody: true,
      inboundUserContext: "",
      isBareSessionReset: false,
      startupAction: "new",
    });

    expect(envelope.currentInboundContext?.reply).toEqual({
      replyTargetPresent: true,
      quotePresent: false,
      replyChainPresent: true,
    });
  });

  it("marks selected quote presence separately from reply target presence", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "Sean, answer this quote",
      BodyStripped: "Sean, answer this quote",
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      MessageSid: "34974",
      MessageThreadId: 777,
      ReplyToId: "34971",
      ReplyToBody: "whole replied-to message",
      ReplyToQuoteText: "selected quoted slice",
      ReplyToIsQuote: true,
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "Sean, answer this quote",
      hasUserBody: true,
      inboundUserContext: "",
      isBareSessionReset: false,
      startupAction: "new",
    });

    expect(envelope.currentInboundContext?.text).toBe("");
    expect(envelope.currentInboundContext?.reply).toMatchObject({
      replyTargetPresent: true,
      quotePresent: true,
      replyChainPresent: false,
    });
    expect(envelope.currentInboundContext?.replyIdentifiers).toMatchObject({
      currentMessageId: "34974",
      threadId: "777",
      replyToId: "34971",
    });
  });

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
      ].join("\n\n"),
    );
    expect(envelope.currentInboundContext?.trustedDeliveryDirective).toBe(
      "Treat this message as observed room activity, not a request. You were not explicitly tagged or mentioned in this room event. Default: stay silent. Only respond if you have something useful, substantial, or important to add. A previous mention or reply is not an invitation to keep talking. To respond visibly, use message(action=send); your final text here stays private either way.",
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
      ].join("\n\n"),
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
    expect(envelope.currentInboundContext?.trustedDeliveryDirective).toBe(
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
