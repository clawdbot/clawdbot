// Discord question custom-id envelope tests.
import { describe, expect, it } from "vitest";
import { parseCustomId } from "./internal/discord.js";
import { buildDiscordQuestionCustomId, parseDiscordQuestionData } from "./question-custom-id.js";

describe("question custom id", () => {
  const questionId = "ask_0123456789abcdef0123456789abcdef";

  it("round-trips a compact option index within Discord's character limit", () => {
    const customId = buildDiscordQuestionCustomId({ questionId, optionIndex: 3 });

    expect(customId).toBe(`ocq:id=${questionId};i=3`);
    expect(customId).toHaveLength(47);
    expect(customId?.length).toBeLessThanOrEqual(100);
    const parsed = parseCustomId(customId ?? "");
    expect(parsed.key).toBe("ocq");
    expect(parseDiscordQuestionData(parsed.data)).toEqual({ questionId, optionIndex: 3 });
  });

  it("rejects malformed indices", () => {
    expect(parseDiscordQuestionData(parseCustomId(`ocq:id=${questionId};i=4`).data)).toBeNull();
  });
});
