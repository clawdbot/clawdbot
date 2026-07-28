import { describe, expect, it } from "vitest";
// Tests mention detection and command trigger matching.
import type { MsgContext } from "../templating.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  stripMentions,
  stripStructuralPrefixes,
} from "./mentions.js";

describe("stripStructuralPrefixes", () => {
  it("returns empty string for undefined input at runtime", () => {
    expect(stripStructuralPrefixes(undefined as unknown as string)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(stripStructuralPrefixes("")).toBe("");
  });

  it("strips sender prefix labels", () => {
    expect(stripStructuralPrefixes("John: hello")).toBe("hello");
  });

  it("preserves colon-delimited slash commands", () => {
    expect(stripStructuralPrefixes("/config:json")).toBe("/config:json");
    expect(stripStructuralPrefixes("/reset: soft")).toBe("/reset: soft");
    expect(stripStructuralPrefixes("/compact: focus on decisions")).toBe(
      "/compact: focus on decisions",
    );
  });

  it("strips direct envelope display labels with handles", () => {
    expect(
      stripStructuralPrefixes("[Telegram Alice (@alice) id:123] Alice (@alice): /status"),
    ).toBe("/status");
  });

  it("strips direct envelope display labels with non-ascii characters", () => {
    expect(stripStructuralPrefixes("[Telegram Jörg] Jörg: /status")).toBe("/status");
    expect(stripStructuralPrefixes("[Telegram 山田] 山田: /status")).toBe("/status");
  });

  it("strips slash-like display labels only after an envelope", () => {
    expect(stripStructuralPrefixes("[Telegram /reset id:123] /reset: hello")).toBe("hello");
  });

  it("passes through plain text", () => {
    expect(stripStructuralPrefixes("just a message")).toBe("just a message");
  });

  it("preserves real line breaks in slash commands for downstream command parsing", () => {
    expect(stripStructuralPrefixes("/reset soft\nre-read persona files")).toBe(
      "/reset soft\nre-read persona files",
    );
    expect(stripStructuralPrefixes("/skill demo\nline two")).toBe("/skill demo\nline two");
    expect(stripStructuralPrefixes("/reset \\nsoft")).toBe("/reset soft");
  });
});

describe("derived Unicode mention matching", () => {
  function configForName(name: string) {
    return {
      agents: {
        list: [{ id: "unicode-agent", identity: { name } }],
      },
    } as Parameters<typeof buildMentionRegexes>[0];
  }

  it.each(["包", "苏苏", "あ", "김", "Jörg", "Б", "ع", "क"])(
    "matches standalone %s and rejects Unicode substrings",
    (name) => {
      const regexes = buildMentionRegexes(configForName(name), "unicode-agent");

      expect(matchesMentionPatterns(`@${name} 你好`, regexes)).toBe(true);
      expect(matchesMentionPatterns(`${name} 你好`, regexes)).toBe(true);
      expect(matchesMentionPatterns(`前${name}後`, regexes)).toBe(false);
    },
  );

  it("does not match a Han name inside mixed Han/kana words", () => {
    const regexes = buildMentionRegexes(configForName("包"), "unicode-agent");

    expect(matchesMentionPatterns("包みを開ける", regexes)).toBe(false);
    expect(matchesMentionPatterns("面包好吃", regexes)).toBe(false);
  });

  it("does not match a name inside a grapheme with combining marks", () => {
    expect(
      matchesMentionPatterns("कि", buildMentionRegexes(configForName("क"), "unicode-agent")),
    ).toBe(false);
    expect(
      matchesMentionPatterns("e\u0301", buildMentionRegexes(configForName("e"), "unicode-agent")),
    ).toBe(false);
  });

  it("uses the same Unicode boundaries when stripping derived mentions", () => {
    const cfg = configForName("包");

    expect(stripMentions("@包 你好", {} as MsgContext, cfg, "unicode-agent")).toBe("你好");
    expect(stripMentions("包みを開ける", {} as MsgContext, cfg, "unicode-agent")).toBe(
      "包みを開ける",
    );
  });

  it("keeps explicit configured patterns on their existing regex flags", () => {
    const regexes = buildMentionRegexes({
      messages: { groupChat: { mentionPatterns: [String.raw`\bopenclaw\b`] } },
    });

    expect(regexes[0]?.flags).toBe("i");
  });
});

describe("CJK single-char mention matching (regression #87303)", () => {
  const cfgWithCjkName = {
    agents: {
      list: [{ id: "cjk-agent", identity: { name: "包" } }],
    },
  } as Parameters<typeof buildMentionRegexes>[0];

  it("matches the reported standalone Han identity", () => {
    const regexes = buildMentionRegexes(cfgWithCjkName, "cjk-agent");
    expect(matchesMentionPatterns("@包 你好", regexes)).toBe(true);
  });
});
