import { describe, expect, it } from "vitest";
import { stripEnvelope, stripMessageIdHints } from "./chat-envelope.js";

describe("shared/chat-envelope", () => {
  it("strips recognized channel and timestamp envelope prefixes only", () => {
    expect(stripEnvelope("[WhatsApp 2026-01-24 13:36] hello")).toBe("hello");
    expect(stripEnvelope("[Google Chat room] hello")).toBe("hello");
    expect(stripEnvelope("[2026-01-24T13:36Z] hello")).toBe("hello");
    expect(stripEnvelope("[2026-01-24 13:36] hello")).toBe("hello");
    expect(stripEnvelope("[Custom Sender] hello")).toBe("[Custom Sender] hello");
  });

  it("keeps non-envelope headers and preserves unmatched text", () => {
    expect(stripEnvelope("hello")).toBe("hello");
    expect(stripEnvelope("[note] hello")).toBe("[note] hello");
    expect(stripEnvelope("[2026/01/24 13:36] hello")).toBe("[2026/01/24 13:36] hello");
    expect(stripEnvelope("[Teams] hello")).toBe("[Teams] hello");
  });

  it("removes standalone message id hint lines but keeps inline mentions", () => {
    expect(stripMessageIdHints("hello\n[message_id: abc123]")).toBe("hello");
    expect(stripMessageIdHints("hello\n [message_id: abc123] \nworld")).toBe("hello\nworld");
    expect(stripMessageIdHints("[message_id: abc123]\nhello")).toBe("hello");
    expect(stripMessageIdHints("[message_id: abc123]")).toBe("");
    expect(stripMessageIdHints("hello\r\n[MESSAGE_ID: abc123]\r\nworld")).toBe("hello\nworld");
    expect(stripMessageIdHints("I typed [message_id: abc123] inline")).toBe(
      "I typed [message_id: abc123] inline",
    );
  });
});
