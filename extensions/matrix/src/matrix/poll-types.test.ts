import { describe, expect, it } from "vitest";

import { parsePollStartContent } from "./poll-types.js";

describe("parsePollStartContent", () => {
  it("parses legacy m.poll payloads", () => {
    const summary = parsePollStartContent({
      "m.poll": {
        question: { "m.text": "Lunch?" },
        kind: "m.poll.disclosed",
        max_selections: 1,
        answers: [
          { id: "answer1", "m.text": "Yes" },
          { id: "answer2", "m.text": "No" },
        ],
      },
    });

    expect(summary?.question).toBe("Lunch?");
    expect(summary?.answers).toEqual(["Yes", "No"]);
  });
});
