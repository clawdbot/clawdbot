import { describe, expect, it } from "vitest";
import { isPollVoteEchoText } from "./poll-vote-echo.js";

describe("isPollVoteEchoText", () => {
  it.each([
    ["Lobster 🦞 ", "🦞 Lobster."],
    ["USA 🇺🇸 ", "🇺🇸 USA."],
    ["Scotland 🏴󠁧󠁢󠁳󠁣󠁴󠁿", "🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scotland."],
    ["Team 👍🏽", "👍🏽 Team."],
    ["Family 👨‍👩‍👧", "👨‍👩‍👧 Family."],
    ["Option 1️⃣", "1️⃣ Option."],
    ["1️⃣", "1️⃣"],
    ["Blue", "Blue!"],
    ["Blue", "🦞 Blue."],
    ["Lobster 🦞", "Lobster."],
    ["🍎", "🍎"],
  ])("matches the same label and emoji signature: %s", (option, outboundText) => {
    expect(isPollVoteEchoText(option, outboundText)).toBe(true);
  });

  it.each([
    ["Option 1️⃣", "2️⃣ Option."],
    ["1️⃣", "2️⃣"],
    ["1", "1️⃣"],
    ["Lobster 🦞", "🦀 Lobster."],
    ["C#", "C"],
    ["C++", "C"],
    ["Node.js", "Node js"],
    ["Blue", "Red"],
    ["", ""],
  ])("does not collapse distinct labels or emoji: %s / %s", (option, outboundText) => {
    expect(isPollVoteEchoText(option, outboundText)).toBe(false);
  });
});
