// Agent Core tests cover the short-reply anchor directive.
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  applyShortReplyAnchor,
  matchesShortSelectionReply,
  SHORT_REPLY_ANCHOR_DIRECTIVE,
  shouldApplyShortReplyAnchor,
} from "./short-reply-anchor.js";

function user(text: string, extra: Partial<UserMessage> = {}): UserMessage {
  return { role: "user", content: text, timestamp: 0, ...extra };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    },
    stopReason: "stop",
    timestamp: 0,
  } as AssistantMessage;
}

function toolResult(text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "test",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}

describe("matchesShortSelectionReply", () => {
  const truthy = [
    "2",
    " 2 ",
    "12",
    "2.",
    "yes",
    "YES",
    "yep",
    "no",
    "nah",
    "ok",
    "okay",
    "sure",
    "the second",
    "the second one",
    "second option",
    "that one",
    "this",
    "both",
    "neither",
    "a",
    "b.",
    "option c",
  ];
  for (const text of truthy) {
    it(`matches ${JSON.stringify(text)}`, () => {
      expect(matchesShortSelectionReply(text)).toBe(true);
    });
  }

  const falsy = [
    "",
    "   ",
    "please reset her password",
    "2 sounds good but let's also send a TAP",
    "yesterday we already did that",
    "no because she is locked out and we need to unblock her now",
    "123", // too many digits — not a plausible list index
  ];
  for (const text of falsy) {
    it(`does not match ${JSON.stringify(text)}`, () => {
      expect(matchesShortSelectionReply(text)).toBe(false);
    });
  }
});

describe("shouldApplyShortReplyAnchor", () => {
  it("fires when trailing user turn is a short selection following an assistant turn", () => {
    const messages: Message[] = [
      user("can you check if she is locked"),
      assistant(
        "Account is not disabled. Options:\n1. Wait it out\n2. Reset her password\n3. Issue a TAP",
      ),
      user("2"),
    ];
    expect(shouldApplyShortReplyAnchor(messages)).toBe(true);
  });

  it("skips volatile runtime-context carrier user messages when finding the trailing turn", () => {
    const messages: Message[] = [
      user("earlier"),
      assistant("1. do A\n2. do B"),
      user("2"),
      // Runtime-context carrier appended after the human's actual reply.
      user("<runtime>time=2026-09-02T14:06Z</runtime>", { runtimeContextCarrier: true }),
    ];
    expect(shouldApplyShortReplyAnchor(messages)).toBe(true);
  });

  it("does not fire when the user reply is substantive", () => {
    const messages: Message[] = [
      assistant("1. do A\n2. do B"),
      user("please reset her password via the entra admin center"),
    ];
    expect(shouldApplyShortReplyAnchor(messages)).toBe(false);
  });

  it("does not fire without a prior assistant turn", () => {
    const messages: Message[] = [user("2")];
    expect(shouldApplyShortReplyAnchor(messages)).toBe(false);
  });

  it("counts a prior assistant turn even across a tool result", () => {
    const messages: Message[] = [
      assistant("1. wait\n2. reset\n3. TAP"),
      toolResult("some tool output"),
      user("2"),
    ];
    expect(shouldApplyShortReplyAnchor(messages)).toBe(true);
  });
});

describe("applyShortReplyAnchor", () => {
  it("appends the anchor directive when the short-reply condition is met", () => {
    const messages: Message[] = [assistant("1. wait\n2. reset\n3. TAP"), user("2")];
    const anchored = applyShortReplyAnchor("You are DefCon.", messages);
    expect(anchored.startsWith("You are DefCon.")).toBe(true);
    expect(anchored).toContain(SHORT_REPLY_ANCHOR_DIRECTIVE);
  });

  it("is a no-op when the reply is not a short selection", () => {
    const messages: Message[] = [
      assistant("1. wait\n2. reset\n3. TAP"),
      user("please reset her password"),
    ];
    expect(applyShortReplyAnchor("You are DefCon.", messages)).toBe("You are DefCon.");
  });

  it("returns just the directive when the base system prompt is empty and anchor fires", () => {
    const messages: Message[] = [assistant("1. a\n2. b"), user("2")];
    expect(applyShortReplyAnchor("", messages)).toBe(SHORT_REPLY_ANCHOR_DIRECTIVE);
  });

  // Regression test for the 2026-09-02 "short reply hijacks stale list" bug.
  it("regression: short reply after fresh assistant list yields anchor even when older lists exist", () => {
    const messages: Message[] = [
      // Older, richer enumerated list (e.g. from a compaction summary or
      // earlier turn about a completely unrelated topic).
      assistant(
        "For the HelloRetriever review:\n1. Rotate Secrets Manager entries\n2. Update the Trello card\n3. Tighten IAM policies\n4. Add SCP guardrails",
      ),
      user("thanks, let's come back to that later"),
      assistant("Sounds good."),
      user("can you check if she is locked"),
      // Fresh assistant turn with the referent that MUST win.
      assistant(
        "Account is not disabled. Options:\n1. Wait it out\n2. Reset her password\n3. Issue a TAP",
      ),
      user("2"),
    ];
    const anchored = applyShortReplyAnchor("You are DefCon.", messages);
    expect(anchored).toContain(SHORT_REPLY_ANCHOR_DIRECTIVE);
    expect(anchored).toContain("MOST RECENT turn only");
  });
});
