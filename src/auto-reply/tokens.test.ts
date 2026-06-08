/** Tests silent-reply and heartbeat token parsing helpers. */
import { describe, it, expect } from "vitest";
import {
  isInternalFormattingArtifact,
  isSilentReplyPrefixText,
  isSilentReplyPayloadText,
  isSilentReplyText,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "./tokens.js";

describe("isInternalFormattingArtifact", () => {
  it("matches Harmony channel markers (#88128)", () => {
    expect(isInternalFormattingArtifact("<channel|>")).toBe(true);
    expect(isInternalFormattingArtifact("  <channel|>  ")).toBe(true);
    expect(isInternalFormattingArtifact("\n<channel|>\n")).toBe(true);
    expect(isInternalFormattingArtifact("<channel|answer>")).toBe(true);
    expect(isInternalFormattingArtifact("<lane|reasoning>")).toBe(true);
    expect(isInternalFormattingArtifact("<|>")).toBe(true);
    expect(isInternalFormattingArtifact("<|channel|>")).toBe(true);
    expect(isInternalFormattingArtifact("<|message|>")).toBe(true);
    expect(isInternalFormattingArtifact("<|call|>")).toBe(true);
  });

  it("matches set-thought directives (#88128)", () => {
    expect(isInternalFormattingArtifact("set-thought <channel|>")).toBe(true);
    expect(isInternalFormattingArtifact("  set-thought <channel|>  ")).toBe(true);
    expect(isInternalFormattingArtifact("set-thought <lane|reasoning>")).toBe(true);
  });

  it("matches box-drawing HR separators (#88128)", () => {
    expect(isInternalFormattingArtifact("───")).toBe(true);
    expect(isInternalFormattingArtifact("─────────")).toBe(true);
    expect(isInternalFormattingArtifact("  ───  ")).toBe(true);
  });

  it("does NOT match generic markdown separators (avoids false positives)", () => {
    expect(isInternalFormattingArtifact("---")).toBe(false);
    expect(isInternalFormattingArtifact("___")).toBe(false);
    expect(isInternalFormattingArtifact("***")).toBe(false);
  });

  it("does NOT match generic XML-like tags (avoids false positives)", () => {
    expect(isInternalFormattingArtifact("<tag>")).toBe(false);
    expect(isInternalFormattingArtifact("</tag>")).toBe(false);
    expect(isInternalFormattingArtifact("<br/>")).toBe(false);
  });

  it("returns false for undefined/empty", () => {
    expect(isInternalFormattingArtifact(undefined)).toBe(false);
    expect(isInternalFormattingArtifact("")).toBe(false);
  });

  it("returns false for normal user-facing text", () => {
    expect(isInternalFormattingArtifact("Hello! How can I help?")).toBe(false);
    expect(isInternalFormattingArtifact("The answer is 42.")).toBe(false);
  });

  it("returns false for text that merely contains an artifact pattern", () => {
    expect(isInternalFormattingArtifact("Here are the options:\n───\n1. Option A")).toBe(false);
    expect(isInternalFormattingArtifact("Use <channel|> in your config.")).toBe(false);
    expect(isInternalFormattingArtifact("The set-thought mechanism works like this...")).toBe(
      false,
    );
  });

  it("returns false for code blocks and multi-line content", () => {
    expect(isInternalFormattingArtifact("```js\nconsole.log('hi')\n```")).toBe(false);
    expect(isInternalFormattingArtifact("**bold** and *italic* text")).toBe(false);
  });
});

describe("isSilentReplyText", () => {
  it("returns true for exact token", () => {
    expect(isSilentReplyText("NO_REPLY")).toBe(true);
  });

  it("returns true for token with surrounding whitespace", () => {
    expect(isSilentReplyText("  NO_REPLY  ")).toBe(true);
    expect(isSilentReplyText("\nNO_REPLY\n")).toBe(true);
  });

  it("returns true for mixed-case token", () => {
    expect(isSilentReplyText("no_reply")).toBe(true);
    expect(isSilentReplyText("  No_RePlY  ")).toBe(true);
  });

  it("returns true for repeated token-only text separated by whitespace", () => {
    expect(isSilentReplyText("NO_REPLY\n\nNO_REPLY")).toBe(true);
    expect(isSilentReplyText("  no_reply \t No_RePlY  ")).toBe(true);
  });

  it("returns false for undefined/empty", () => {
    expect(isSilentReplyText(undefined)).toBe(false);
    expect(isSilentReplyText("")).toBe(false);
  });

  it("returns false for substantive text ending with token (#19537)", () => {
    const text = "Here is a helpful response.\n\nNO_REPLY";
    expect(isSilentReplyText(text)).toBe(false);
  });

  it("returns false for substantive text starting with token", () => {
    const text = "NO_REPLY but here is more content";
    expect(isSilentReplyText(text)).toBe(false);
  });

  it("returns false for token embedded in text", () => {
    expect(isSilentReplyText("Please NO_REPLY to this")).toBe(false);
  });
});

describe("isSilentReplyPayloadText", () => {
  it("returns true when leaked reasoning text ends in NO_REPLY", () => {
    expect(
      isSilentReplyPayloadText(
        "think\nCav is talking about a follow-up conversation.\nI will stay quiet here.NO_REPLY",
      ),
    ).toBe(true);
    expect(isSilentReplyPayloadText("think\ninternal reasoning\nNO_REPLY")).toBe(true);
    expect(isSilentReplyPayloadText("<think>internal reasoning</think>\nNO_REPLY")).toBe(true);
    expect(
      isSilentReplyPayloadText(
        "<think>internal reasoning</think>\nI will stay quiet here.NO_REPLY",
      ),
    ).toBe(true);
    expect(isSilentReplyPayloadText("<think>I will stay quiet here.NO_REPLY")).toBe(true);
  });

  it("keeps substantive replies that also contain a trailing NO_REPLY token", () => {
    expect(isSilentReplyPayloadText("Here is a helpful response.\n\nNO_REPLY")).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "think\nHere is the actual answer.\nI will stay quiet here.NO_REPLY",
      ),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText("think\nCav is talking about a follow-up conversation.\nNO_REPLY"),
    ).toBe(false);
    expect(isSilentReplyPayloadText("analysis\nMeeting moved to 3 pm.\nNO_REPLY")).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "think\nThe user is asking whether the outage is resolved. Tell them the service is back up and they should retry.\nNO_REPLY",
      ),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText("<think>internal reasoning</think>\nHere is the answer.\nNO_REPLY"),
    ).toBe(false);
    expect(isSilentReplyPayloadText("think\nHere is the actual answer.\nNO_REPLY")).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "<think>internal reasoning</think>\nYou should not reply to that email.\nNO_REPLY",
      ),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText("<think>internal notes\nHere is the actual answer.\nNO_REPLY"),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "<think>internal reasoning</think>\nHere is the answer: I will stay quiet in the meeting, but you should still send the agenda.NO_REPLY",
      ),
    ).toBe(false);
  });
});

describe("stripSilentToken", () => {
  it("strips token from end of text", () => {
    expect(stripSilentToken("Done.\n\nNO_REPLY")).toBe("Done.");
  });

  it("does not strip token from start of text", () => {
    expect(stripSilentToken("NO_REPLY 👍")).toBe("NO_REPLY 👍");
  });

  it("strips token with emoji (#30916)", () => {
    expect(stripSilentToken("😄 NO_REPLY")).toBe("😄");
  });

  it("does not strip embedded token suffix without whitespace delimiter", () => {
    expect(stripSilentToken("interject.NO_REPLY")).toBe("interject.NO_REPLY");
  });

  it("strips only trailing occurrence", () => {
    expect(stripSilentToken("NO_REPLY ok NO_REPLY")).toBe("NO_REPLY ok");
  });

  it("returns empty string when only token remains", () => {
    expect(stripSilentToken("NO_REPLY")).toBe("");
    expect(stripSilentToken("  NO_REPLY  ")).toBe("");
  });

  it("strips token preceded by bold markdown formatting", () => {
    expect(stripSilentToken("**NO_REPLY")).toBe("");
    expect(stripSilentToken("some text **NO_REPLY")).toBe("some text");
    expect(stripSilentToken("reasoning**NO_REPLY")).toBe("reasoning");
  });
});

describe("custom silent tokens", () => {
  it.each([
    {
      name: "exact-token detection",
      check: () => isSilentReplyText("HEARTBEAT_OK", "HEARTBEAT_OK"),
      expected: true,
    },
    {
      name: "substantive text detection",
      check: () => isSilentReplyText("Checked inbox. HEARTBEAT_OK", "HEARTBEAT_OK"),
      expected: false,
    },
    {
      name: "repeated-token detection",
      check: () => isSilentReplyText("HEARTBEAT_OK\nHEARTBEAT_OK", "HEARTBEAT_OK"),
      expected: true,
    },
    {
      name: "trailing token stripping",
      check: () => stripSilentToken("done HEARTBEAT_OK", "HEARTBEAT_OK"),
      expected: "done",
    },
  ])("handles custom token for $name", ({ check, expected }) => {
    expect(check()).toBe(expected);
  });
});

describe("stripLeadingSilentToken", () => {
  it("strips glued leading token text", () => {
    expect(stripLeadingSilentToken("NO_REPLYThe user is saying")).toBe("The user is saying");
  });
});

describe("startsWithSilentToken", () => {
  it("matches leading glued silent tokens case-insensitively", () => {
    expect(startsWithSilentToken("NO_REPLYThe user is saying")).toBe(true);
    expect(startsWithSilentToken("No_RePlYThe user is saying")).toBe(true);
    expect(startsWithSilentToken("no_replyThe user is saying")).toBe(true);
  });

  it("rejects separated substantive prefixes and exact-token-only text", () => {
    expect(startsWithSilentToken("NO_REPLY -- nope")).toBe(false);
    expect(startsWithSilentToken("NO_REPLY: explanation")).toBe(false);
    expect(startsWithSilentToken("NO_REPLY—note")).toBe(false);
    expect(startsWithSilentToken("NO_REPLY")).toBe(false);
    expect(startsWithSilentToken("  NO_REPLY  ")).toBe(false);
  });
});

describe("isSilentReplyPrefixText", () => {
  it("matches uppercase token lead fragments", () => {
    expect(isSilentReplyPrefixText("NO")).toBe(true);
    expect(isSilentReplyPrefixText("NO_")).toBe(true);
    expect(isSilentReplyPrefixText("NO_RE")).toBe(true);
    expect(isSilentReplyPrefixText("NO_REPLY")).toBe(true);
    expect(isSilentReplyPrefixText("  HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects ambiguous natural-language prefixes", () => {
    expect(isSilentReplyPrefixText("N")).toBe(false);
    expect(isSilentReplyPrefixText("No")).toBe(false);
    expect(isSilentReplyPrefixText("no")).toBe(false);
    expect(isSilentReplyPrefixText("Hello")).toBe(false);
  });

  it("keeps underscore guard for non-NO_REPLY tokens", () => {
    expect(isSilentReplyPrefixText("HE", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEART", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEARTBEAT", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects non-prefixes and mixed characters", () => {
    expect(isSilentReplyPrefixText("NO_X")).toBe(false);
    expect(isSilentReplyPrefixText("NO_REPLY more")).toBe(false);
    expect(isSilentReplyPrefixText("NO-")).toBe(false);
  });
});
