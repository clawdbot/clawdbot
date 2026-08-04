import { describe, expect, it } from "vitest";
import {
  CURRENT_MESSAGE_MARKER,
  extractCurrentMessageBody,
  matchesMentionWithExplicit,
} from "./mentions.js";

describe("extractCurrentMessageBody", () => {
  it("returns the text unchanged when there is no marker", () => {
    expect(extractCurrentMessageBody("just a message")).toBe("just a message");
  });

  it("drops batched context ahead of the marker", () => {
    const body = `[10:00] alice: an earlier long message about deployments\n${CURRENT_MESSAGE_MARKER}\nthanks`;
    expect(extractCurrentMessageBody(body)).toBe("thanks");
  });

  it("keeps the current message intact when it spans lines", () => {
    const body = `context here\n${CURRENT_MESSAGE_MARKER}\nline one\nline two`;
    expect(extractCurrentMessageBody(body)).toBe("line one\nline two");
  });
});

describe("matchesMentionWithExplicit", () => {
  const mentionRegexes = [/\bopenclaw\b/i];

  it("checks mentionPatterns even when explicit mention is available", () => {
    const result = matchesMentionWithExplicit({
      text: "@openclaw hello",
      mentionRegexes,
      explicit: {
        hasAnyMention: true,
        isExplicitlyMentioned: false,
        canResolveExplicit: true,
      },
    });
    expect(result).toBe(true);
  });

  it("returns false when explicit is false and no regex match", () => {
    const result = matchesMentionWithExplicit({
      text: "<@999999> hello",
      mentionRegexes,
      explicit: {
        hasAnyMention: true,
        isExplicitlyMentioned: false,
        canResolveExplicit: true,
      },
    });
    expect(result).toBe(false);
  });

  it("returns true when explicitly mentioned even if regexes do not match", () => {
    const result = matchesMentionWithExplicit({
      text: "<@123456>",
      mentionRegexes: [],
      explicit: {
        hasAnyMention: true,
        isExplicitlyMentioned: true,
        canResolveExplicit: true,
      },
    });
    expect(result).toBe(true);
  });

  it("falls back to regex matching when explicit mention cannot be resolved", () => {
    const result = matchesMentionWithExplicit({
      text: "openclaw please",
      mentionRegexes,
      explicit: {
        hasAnyMention: true,
        isExplicitlyMentioned: false,
        canResolveExplicit: false,
      },
    });
    expect(result).toBe(true);
  });
});
