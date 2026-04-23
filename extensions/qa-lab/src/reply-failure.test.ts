import { describe, expect, it } from "vitest";
import { extractQaFailureReplyText, extractQaVisibleReplyLeakText } from "./reply-failure.js";

describe("extractQaFailureReplyText", () => {
  it("returns undefined for normal assistant replies", () => {
    expect(
      extractQaFailureReplyText("Yes, precious. The build is green and a little cursed."),
    ).toBe(undefined);
  });

  it("classifies the generic external fallback reply as a failure", () => {
    expect(
      extractQaFailureReplyText(
        "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
      ),
    ).toContain("Something went wrong while processing your request.");
  });

  it("classifies explicit provider auth guidance as a failure", () => {
    expect(
      extractQaFailureReplyText(
        '⚠️ No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai/gpt-5.5 with the Codex OAuth profile, or set OPENAI_API_KEY for direct OpenAI API access.',
      ),
    ).toContain('No API key found for provider "openai".');
  });

  it("classifies curated missing-key guidance as a failure", () => {
    expect(
      extractQaFailureReplyText(
        "⚠️ Missing API key for OpenAI on the gateway. Use `openai/gpt-5.5` with the Codex OAuth profile, or set `OPENAI_API_KEY`, then try again.",
      ),
    ).toContain("Missing API key for OpenAI on the gateway.");
  });

  it("classifies leaked codex harness coordination chatter as a failure", () => {
    expect(
      extractQaFailureReplyText("checking thread context; then post a tight progress reply here."),
    ).toContain("checking thread context");
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
