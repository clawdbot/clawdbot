// BTW inline message tests cover compact inline status message rendering.
import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
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

  it("sanitizes the question and successful Markdown result on every update", () => {
    const firstQuestionAttack = "\x1b[3Jquestion";
    const firstTextAttack = "\x1b]52;c;T08_BTW_CLIPBOARD\x07";
    const nextQuestionAttack = "\u009b3Jquestion";
    const nextTextAttack = "\u009d0;T08_BTW_TITLE\u009c";
    const url = "https://example.test/tui/btw?copy=caf%C3%A9";
    const message = new BtwInlineMessage({
      question: `first ${firstQuestionAttack}\r\nمرحبا\tשלום`,
      text: `${firstTextAttack}**first café**\nsecond body ${url}`,
    });

    let lines = message.render(140);
    let raw = lines.join("\n");
    let rendered = normalizeTestText(raw);
    expect(rendered).toContain("BTW: \u2067first question مرحبا שלום\u2069");
    expect(rendered).toContain("مرحبا שלום");
    expect(rendered).toContain("first café");
    expect(rendered).toContain("second body");
    expect(lines[1]).not.toMatch(/[\r\n\t]/u);
    expect(raw).toContain(`\x1b]8;;${url}\x07`);
    expect(raw).not.toContain(firstQuestionAttack);
    expect(raw).not.toContain(firstTextAttack);

    message.setResult({
      question: `next ${nextQuestionAttack}\r\nשלום\tمرحبا`,
      text: `${nextTextAttack}**next 東京** ${url}`,
    });

    lines = message.render(140);
    raw = lines.join("\n");
    rendered = normalizeTestText(raw);
    expect(rendered).toContain("BTW: \u2067next question שלום مرحبا\u2069");
    expect(rendered).toContain("שלום مرحبا");
    expect(rendered).toContain("next 東京");
    expect(rendered).not.toContain("first question");
    expect(rendered).not.toContain("first café");
    expect(raw).not.toContain(nextQuestionAttack);
    expect(raw).not.toContain(nextTextAttack);
    expect(lines[1]).not.toMatch(/[\r\n\t]/u);
  });

  it("passes sanitized RTL source through Markdown exactly once", () => {
    const message = new BtwInlineMessage({
      question: "structure proof",
      text: "\u202e# مرحبا\u202c\n\n\u200f> שלום\n\n\u2066- عنصر\u2069",
    });

    const lines = message.render(100);
    const normalized = lines
      .map((line) => normalizeTestText(line).replace(/[\u2067\u2069]/gu, ""))
      .join("\n");
    expect(normalized).toContain("مرحبا");
    expect(normalized).not.toContain("# مرحبا");
    expect(normalized).toContain("│ שלום");
    expect(normalized).toContain("- عنصر");
    for (const line of lines.filter((entry) => /[\u0590-\u08ff]/u.test(entry))) {
      expect(line.match(/\u2067/gu)).toHaveLength(1);
      expect(line.match(/\u2069/gu)).toHaveLength(1);
    }
  });

  it("sanitizes BTW error questions and text before applying trusted themes", () => {
    const questionAttack = "\x1b]0;T08_BTW_QUESTION_TITLE\x07";
    const errorAttack = "\u009b3Jretry";
    const message = new BtwInlineMessage({
      question: `why ${questionAttack}failed?\r\nمرحبا\tשלום`,
      text: `${errorAttack} **plain** safely café`,
      isError: true,
    });

    const raw = message.render(100).join("\n");
    const rendered = normalizeTestText(raw);
    expect(rendered).toContain("BTW: \u2067why failed? مرحبا שלום\u2069");
    expect(rendered).toContain("مرحبا שלום");
    expect(rendered).toContain("retry **plain** safely café");
    expect(raw).not.toContain(questionAttack);
    expect(raw).not.toContain(errorAttack);
  });

  it.each(["", " \x1b]0;hidden title\x07 "])(
    "renders a visible fallback when a BTW error sanitizes to empty",
    (text) => {
      const message = new BtwInlineMessage({
        question: "what failed?",
        text,
        isError: true,
      });

      expect(normalizeTestText(message.render(80).join("\n"))).toContain("(no output)");
    },
  );
});
