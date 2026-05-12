import { describe, expect, it } from "vitest";
import { BtwInlineMessage } from "./btw-inline-message.js";

describe("btw inline message", () => {
  it("renders the BTW question, answer, and dismiss hint inline", () => {
    const message = new BtwInlineMessage({
      question: "what is 17 * 19?",
      text: "323",
    });

    expect(message.render(80)).toEqual([
      "",
      " BTW: what is 17 * 19?                                                          ",
      "",
      "323                                                                             ",
      " Press Enter or Esc to dismiss                                                  ",
    ]);
  });
});
