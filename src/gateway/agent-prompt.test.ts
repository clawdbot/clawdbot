/**
 * Gateway agent prompt RPC regression tests.
 */
import { describe, expect, it } from "vitest";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import { buildHistoryContextFromEntries } from "../auto-reply/reply/history.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { buildAgentMessageFromConversationEntries } from "./agent-prompt.js";

describe("gateway agent prompt", () => {
  it("returns empty for no entries", () => {
    expect(buildAgentMessageFromConversationEntries([])).toBe("");
  });

  it("returns current body when there is no history", () => {
    expect(
      buildAgentMessageFromConversationEntries([
        { role: "user", entry: { sender: "User", body: "hi" } },
      ]),
    ).toBe("hi");
  });

  it("extracts text from content-array body when there is no history", () => {
    expect(
      buildAgentMessageFromConversationEntries([
        {
          role: "user",
          entry: {
            sender: "User",
            body: [
              { type: "text", text: "hi" },
              { type: "image", data: "base64-image", mimeType: "image/png" },
              { type: "text", text: "there" },
            ] as unknown as string,
          },
        },
      ]),
    ).toBe("hi there");
  });

  it("uses history context when there is history", () => {
    const entries = [
      { role: "assistant", entry: { sender: "Assistant", body: "prev" } },
      { role: "user", entry: { sender: "User", body: "next" } },
    ] as const;

    const expected = buildHistoryContextFromEntries({
      entries: entries.map((e) => e.entry),
      currentMessage: "User: next",
      formatEntry: (e) => `${e.sender}: ${e.body}`,
    });

    expect(buildAgentMessageFromConversationEntries([...entries])).toBe(expected);
  });

  it("prefers last tool entry over assistant for current message", () => {
    const entries = [
      { role: "user", entry: { sender: "User", body: "question" } },
      { role: "tool", entry: { sender: "Tool:x", body: "tool output" } },
      { role: "assistant", entry: { sender: "Assistant", body: "assistant text" } },
    ] as const;

    const expected = buildHistoryContextFromEntries({
      entries: [entries[0].entry, entries[1].entry],
      currentMessage: "Tool:x: tool output",
      formatEntry: (e) => `${e.sender}: ${e.body}`,
    });

    expect(buildAgentMessageFromConversationEntries([...entries])).toBe(expected);
  });

  it("normalizes content-array bodies in history and current message", () => {
    const entries = [
      {
        role: "assistant",
        entry: {
          sender: "Assistant",
          body: [{ type: "text", text: "prev" }] as unknown as string,
        },
      },
      {
        role: "user",
        entry: {
          sender: "User",
          body: [
            { type: "text", text: "next" },
            { type: "text", text: "step" },
          ] as unknown as string,
        },
      },
    ] as const;

    const expected = buildHistoryContextFromEntries({
      entries: entries.map((e) => e.entry),
      currentMessage: "User: next step",
      formatEntry: (e) => `${e.sender}: ${extractTextFromChatContent(e.body) ?? ""}`,
    });

    expect(buildAgentMessageFromConversationEntries([...entries])).toBe(expected);
  });
  it("omits internal stream-error placeholder text from replay history", () => {
    const entries = [
      { role: "user", entry: { sender: "User", body: "first" } },
      {
        role: "assistant",
        internalStreamError: true,
        entry: {
          sender: "Assistant",
          body: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }] as unknown as string,
        },
      },
      { role: "user", entry: { sender: "User", body: "retry" } },
    ] as const;

    const prompt = buildAgentMessageFromConversationEntries([...entries]);
    expect(prompt).not.toContain(STREAM_ERROR_FALLBACK_TEXT);
    expect(prompt).not.toContain("Assistant:");
    expect(prompt).toContain("User: first");
    expect(prompt).toContain("User: retry");
  });

  it("preserves ordinary assistant text that merely mentions the stream-error placeholder", () => {
    const mention = `Diagnostic note: ${STREAM_ERROR_FALLBACK_TEXT}`;
    const entries = [
      { role: "assistant", entry: { sender: "Assistant", body: mention } },
      { role: "user", entry: { sender: "User", body: "next" } },
    ] as const;

    const prompt = buildAgentMessageFromConversationEntries([...entries]);
    expect(prompt).toContain(mention);
  });

  it("preserves exact stream-error placeholder text from user history", () => {
    const entries = [
      { role: "user", entry: { sender: "User", body: STREAM_ERROR_FALLBACK_TEXT } },
      { role: "user", entry: { sender: "User", body: "next" } },
    ] as const;

    const prompt = buildAgentMessageFromConversationEntries([...entries]);
    expect(prompt).toContain(`User: ${STREAM_ERROR_FALLBACK_TEXT}`);
  });

  it("preserves exact stream-error placeholder text from assistant history without provenance", () => {
    const entries = [
      { role: "assistant", entry: { sender: "Assistant", body: STREAM_ERROR_FALLBACK_TEXT } },
      { role: "user", entry: { sender: "User", body: "next" } },
    ] as const;

    const prompt = buildAgentMessageFromConversationEntries([...entries]);
    expect(prompt).toContain(`Assistant: ${STREAM_ERROR_FALLBACK_TEXT}`);
  });

  it("preserves empty tool outputs in replay history", () => {
    const entries = [
      { role: "user", entry: { sender: "User", body: "lookup" } },
      { role: "tool", entry: { sender: "Tool:call_1", body: "" } },
      { role: "user", entry: { sender: "User", body: "continue" } },
    ] as const;

    const prompt = buildAgentMessageFromConversationEntries([...entries]);
    expect(prompt).toContain("Tool:call_1: ");
    expect(prompt).toContain("User: continue");
  });

  it("preserves current user text that looks like internal display metadata", () => {
    const body = "[Thu 2026-03-12 07:00 UTC] what happened then?";
    expect(
      buildAgentMessageFromConversationEntries([{ role: "user", entry: { sender: "User", body } }]),
    ).toBe(body);
  });
});
