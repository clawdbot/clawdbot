// Qa Lab tests cover typed reply failure markers and independent leak detection.
import { describe, expect, it } from "vitest";
import { extractQaFailureReplyText, extractQaVisibleReplyLeakText } from "./reply-failure.js";

describe("extractQaFailureReplyText", () => {
  it("returns undefined for normal assistant replies", () => {
    expect(
      extractQaFailureReplyText({
        text: "Yes, precious. The build is green and a little cursed.",
      }),
    ).toBe(undefined);
  });

  it("classifies marked failures without depending on copy wording", () => {
    const text = "Any future user-facing failure wording can go here.";
    expect(extractQaFailureReplyText({ text, isError: true })).toBe(text);
  });

  it("does not classify legacy failure-looking copy without the marker", () => {
    expect(
      extractQaFailureReplyText({
        text: "⚠️ Something went wrong while processing your request.",
      }),
    ).toBeUndefined();
  });

  it("classifies leaked harness coordination chatter independently", () => {
    const text = "checking thread context; then post a tight progress reply here.";
    expect(extractQaFailureReplyText({ text })).toContain("checking thread context");
  });
});

describe("extractQaVisibleReplyLeakText", () => {
  it("returns undefined for normal visible replies", () => {
    expect(extractQaVisibleReplyLeakText("QA_LEAK_OK")).toBe(undefined);
  });

  it("detects coordination-nudge leak text", () => {
    expect(
      extractQaVisibleReplyLeakText(
        "thread context thin; posting a coordination nudge, not inventing status.",
      ),
    ).toContain("thread context thin");
  });
});
