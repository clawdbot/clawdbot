import { describe, expect, it } from "vitest";
import { stripMessageIdHints } from "./message-id-hints.js";

describe("shared/text/message-id-hints", () => {
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

  it("preserves message id examples in code", () => {
    expect(stripMessageIdHints("```text\n[message_id: abc123]\n```")).toBe(
      "```text\n[message_id: abc123]\n```",
    );
    expect(stripMessageIdHints("    [message_id: abc123]")).toBe("    [message_id: abc123]");
    expect(stripMessageIdHints("> ```text\n> [message_id: abc123]\n> ```")).toBe(
      "> ```text\n> [message_id: abc123]\n> ```",
    );
  });

  it("removes generated hints surrounding code examples", () => {
    expect(
      stripMessageIdHints("[message_id: generated]\n```text\n[message_id: literal]\n```"),
    ).toBe("```text\n[message_id: literal]\n```");
    expect(
      stripMessageIdHints("```text\n[message_id: literal]\n```\n[message_id: generated]"),
    ).toBe("```text\n[message_id: literal]\n```");
    expect(
      stripMessageIdHints("[message_id: generated]\r\n```text\r\n[message_id: literal]\r\n```"),
    ).toBe("```text\n[message_id: literal]\n```");
  });

  it("preserves CRLF code when no generated hint is removed", () => {
    expect(stripMessageIdHints("```text\r\n[message_id: literal]\r\n```")).toBe(
      "```text\r\n[message_id: literal]\r\n```",
    );
  });
});
