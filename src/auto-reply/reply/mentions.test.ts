import { describe, expect, it } from "vitest";

import {
  buildMentionRegexes,
  matchesMentionPatterns,
  normalizeMentionText,
} from "./mentions.js";

describe("mention helpers", () => {
  it("builds regexes and skips invalid patterns", () => {
    const regexes = buildMentionRegexes({
      routing: {
        groupChat: { mentionPatterns: ["\\bclawd\\b", "(invalid"] },
      },
    });
    expect(regexes).toHaveLength(1);
    expect(regexes[0]?.test("clawd")).toBe(true);
  });

  it("normalizes zero-width characters", () => {
    expect(normalizeMentionText("cl\u200bawd")).toBe("clawd");
  });

  it("matches patterns case-insensitively", () => {
    const regexes = buildMentionRegexes({
      routing: { groupChat: { mentionPatterns: ["\\bclawd\\b"] } },
    });
    expect(matchesMentionPatterns("CLAWD: hi", regexes)).toBe(true);
  });
});
