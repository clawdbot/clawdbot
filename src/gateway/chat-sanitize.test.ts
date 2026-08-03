/**
 * Tests gateway chat sanitization helpers for model-visible payloads.
 */
import { describe, expect, test } from "vitest";
import { markInboundContextLabel } from "../auto-reply/reply/inbound-context-marker.js";
import { stripEnvelopeFromMessage } from "./chat-sanitize.js";

describe("stripEnvelopeFromMessage", () => {
  test("removes message_id hint lines from user messages", () => {
    const input = {
      role: "user",
      content: "[WhatsApp 2026-01-24 13:36] yolo\n[message_id: 7b8b]",
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("yolo");
  });

  test("removes message_id hint lines from text content arrays", () => {
    const input = {
      role: "user",
      content: [{ type: "text", text: "hi\n[message_id: abc123]" }],
    };
    const result = stripEnvelopeFromMessage(input) as {
      content?: Array<{ type: string; text?: string }>;
    };
    expect(result.content?.[0]?.text).toBe("hi");
  });

  test("strips role-appropriate Responses text blocks", () => {
    const user = stripEnvelopeFromMessage({
      role: "user",
      content: [{ type: "input_text", text: "hello\n[message_id: abc123]" }],
    }) as { content?: Array<{ text?: string }> };
    const assistant = stripEnvelopeFromMessage({
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"message_id":"123"}\n```\n\nAssistant body',
        },
      ],
    }) as { content?: Array<{ text?: string }> };

    expect(user.content?.[0]?.text).toBe("hello");
    expect(assistant.content?.[0]?.text).toBe("Assistant body");
  });

  test("strips internal metadata from assistant input_text blocks", () => {
    const assistant = stripEnvelopeFromMessage({
      role: "assistant",
      content: [
        {
          type: "input_text",
          text: 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"message_id":"123"}\n```\n\nAssistant body',
        },
      ],
    }) as { content?: Array<{ text?: string }> };

    expect(assistant.content?.[0]?.text).toBe("Assistant body");
  });

  test("does not strip inline message_id text that is part of a line", () => {
    const input = {
      role: "user",
      content: "I typed [message_id: 123] on purpose",
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("I typed [message_id: 123] on purpose");
  });

  test("does not strip assistant messages", () => {
    const input = {
      role: "assistant",
      content: "note\n[message_id: 123]",
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("note\n[message_id: 123]");
  });

  test("defensively strips inbound metadata blocks from non-user messages", () => {
    const input = {
      role: "assistant",
      content:
        'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"message_id":"123"}\n```\n\nAssistant body',
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("Assistant body");
  });

  test("removes inbound un-bracketed conversation info blocks from user messages", () => {
    const input = {
      role: "user",
      content:
        'Conversation info: ⟦openclaw:ctx⟧\n```json\n{\n  "message_id": "123"\n}\n```\n\nHello there',
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("Hello there");
  });

  test("removes all inbound metadata blocks before user text", () => {
    const input = {
      role: "user",
      content:
        'Thread starter: ⟦openclaw:ctx⟧\n```json\n{"seed": 1}\n```\n\nSender: ⟦openclaw:ctx⟧\n```json\n{"name": "alice"}\n```\n\nActual user message',
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string; senderLabel?: string };
    expect(result.content).toBe("Actual user message");
    expect(result.senderLabel).toBe("alice");
  });

  test("strips metadata-like blocks even when not a prefix", () => {
    const input = {
      role: "user",
      content:
        'Actual text\nConversation info: ⟦openclaw:ctx⟧\n```json\n{"message_id": "123"}\n```\n\nFollow-up',
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("Actual text\n\nFollow-up");
  });

  test("strips trailing untrusted context metadata suffix blocks", () => {
    const input = {
      role: "user",
      content: `hello\n\n${markInboundContextLabel("Context:")}\n<<<EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>\nSource: Channel metadata\n---\nChannel metadata (guildchat)\nSender labels:\nexample\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>`,
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("hello");
  });
});
