// Telegram tests cover reasoning lane coordinator plugin behavior.
import { describe, expect, it } from "vitest";
import { splitTelegramReasoningText } from "./reasoning-lane-coordinator.js";

describe("splitTelegramReasoningText", () => {
  it("keeps unflagged angle-bracket reasoning tags in the answer lane", () => {
    const text = "<think>example</think>Done";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });

  it("keeps unclosed unflagged reasoning-looking text in the answer lane", () => {
    const text = "Before <think>unclosed content after";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });

  it("formats tagged text when the payload is explicitly reasoning", () => {
    expect(splitTelegramReasoningText("<think>example</think>Done", true)).toEqual({
      reasoningText: "🧠 _example_",
    });
  });

  it("suppresses internal reflection from explicitly typed reasoning", () => {
    expect(splitTelegramReasoningText("<internal>private reflection</internal>", true)).toEqual({});
  });

  it("ignores literal think tags inside inline code", () => {
    const text = "Use `<think>example</think>` literally.";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });

  it("ignores literal think tags inside fenced code", () => {
    const text = "```xml\n<think>example</think>\n```";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });

  it.each([
    "  <thi",
    "  <int",
    "< internal",
    "<  internal",
    "</ internal",
    "< / internal",
    "<\u00a0internal",
  ])("does not emit partial reasoning tag prefix %j", (text) => {
    expect(splitTelegramReasoningText(text, true)).toStrictEqual({});
  });

  it("keeps unrelated partial tags visible", () => {
    expect(splitTelegramReasoningText("< interface", true)).toStrictEqual({
      reasoningText: "🧠 _< interface_",
    });
  });

  it("keeps visible Thinking-prefixed answers in the answer lane", () => {
    const text = "Thinking...\nI'll check that now";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });
});
