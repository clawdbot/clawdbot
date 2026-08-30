// Line tests cover the postback encoding for ask_user question controls.
import { describe, expect, it } from "vitest";
import {
  buildLineQuestionPostbackData,
  parseLineQuestionPostbackData,
} from "./question-postback.js";

const QUESTION_ID = "ask_3d8dbe55be452a9a39add7c909beb119";

describe("LINE question postback data", () => {
  it("round-trips a chosen option", () => {
    const data = buildLineQuestionPostbackData({ questionId: QUESTION_ID, optionIndex: 2 });
    expect(data).toBe(`line.question=${QUESTION_ID}&line.option=2`);
    expect(parseLineQuestionPostbackData(data!)).toEqual({
      questionId: QUESTION_ID,
      optionIndex: 2,
    });
  });

  it("round-trips a custom-input choice", () => {
    const data = buildLineQuestionPostbackData({ questionId: QUESTION_ID, customInput: true });
    expect(parseLineQuestionPostbackData(data!)).toEqual({
      questionId: QUESTION_ID,
      customInput: true,
    });
  });

  it("renders no control when the option index is unresolved", () => {
    // -1 is what an unresolved Gateway option index looks like; a button that cannot
    // name its option must not be offered at all.
    expect(
      buildLineQuestionPostbackData({ questionId: QUESTION_ID, optionIndex: -1 }),
    ).toBeUndefined();
  });

  it("renders no control when the reference would exceed LINE's postback limit", () => {
    expect(
      buildLineQuestionPostbackData({ questionId: "a".repeat(400), optionIndex: 0 }),
    ).toBeUndefined();
  });

  it("ignores postback data that carries no question", () => {
    expect(parseLineQuestionPostbackData("line.action=play&line.device=tv")).toBeUndefined();
    expect(parseLineQuestionPostbackData("")).toBeUndefined();
  });

  it("ignores a question reference with no usable choice", () => {
    expect(parseLineQuestionPostbackData(`line.question=${QUESTION_ID}`)).toBeUndefined();
    expect(
      parseLineQuestionPostbackData(`line.question=${QUESTION_ID}&line.option=abc`),
    ).toBeUndefined();
  });
});
