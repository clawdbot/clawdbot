import { describe, expect, it } from "vitest";
import { setupAnswerFromText } from "./setup-view.ts";

describe("setupAnswerFromText", () => {
  it("treats empty text fields as a cleared answer", () => {
    expect(setupAnswerFromText("", "string")).toBeUndefined();
    expect(setupAnswerFromText("", "multiline")).toBeUndefined();
    expect(setupAnswerFromText("", "integer")).toBeUndefined();
  });

  it("preserves non-empty text and parses integer input", () => {
    expect(setupAnswerFromText("brief", "string")).toBe("brief");
    expect(setupAnswerFromText("line one\nline two", "multiline")).toBe("line one\nline two");
    expect(setupAnswerFromText("12", "integer")).toBe(12);
  });
});
