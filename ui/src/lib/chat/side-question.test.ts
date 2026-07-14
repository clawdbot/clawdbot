import { describe, expect, it } from "vitest";
import {
  buildMoreDetailsSideCommand,
  buildSideChatFollowUpCommand,
  combineSideChatComposerDraft,
  extractSideQuestionDisplayText,
} from "./side-question.ts";

describe("side question builders", () => {
  it("builds a single-line /btw command quoting the selection", () => {
    expect(buildMoreDetailsSideCommand("Let's Encrypt cert\nis valid")).toBe(
      `/btw Explain "Let's Encrypt cert is valid" from this conversation in more detail.`,
    );
  });
});

describe("combineSideChatComposerDraft", () => {
  it("keeps an unsent prose draft as the question part", () => {
    expect(combineSideChatComposerDraft("cron scan job", "why does this run twice?")).toBe(
      `/btw Regarding "cron scan job": why does this run twice?`,
    );
  });

  it("collapses multiline drafts so the single-line /btw send loses nothing", () => {
    expect(combineSideChatComposerDraft("cron scan job", "first line\nsecond line")).toBe(
      `/btw Regarding "cron scan job": first line second line`,
    );
  });

  it("replaces slash-command drafts instead of embedding them", () => {
    expect(combineSideChatComposerDraft("cron scan job", "/compact")).toBe(
      `/btw Regarding "cron scan job": `,
    );
  });

  it("behaves like the plain prefill when the composer is empty", () => {
    expect(combineSideChatComposerDraft("cron scan job", "")).toBe(
      `/btw Regarding "cron scan job": `,
    );
    expect(combineSideChatComposerDraft("cron scan job", undefined)).toBe(
      `/btw Regarding "cron scan job": `,
    );
  });
});

describe("buildSideChatFollowUpCommand", () => {
  it("sends a plain /btw when there is no previous turn", () => {
    expect(buildSideChatFollowUpCommand(null, "what about tests?")).toEqual({
      command: "/btw what about tests?",
      question: "what about tests?",
    });
  });

  it("carries the previous side question and answer as context", () => {
    expect(
      buildSideChatFollowUpCommand(
        { question: "Is cert A valid?", answer: "No,\nit expired." },
        "when did it expire?",
      ),
    ).toEqual({
      command:
        '/btw Context — the previous side question "Is cert A valid?" was answered: "No, it expired.". Follow-up question: when did it expire?',
      question: "when did it expire?",
    });
  });

  it("collapses multiline questions and rejects empty ones", () => {
    expect(buildSideChatFollowUpCommand(null, "first\nsecond")?.question).toBe("first second");
    expect(buildSideChatFollowUpCommand(null, "  \n ")).toBeNull();
  });
});

describe("extractSideQuestionDisplayText", () => {
  it("drops the /btw and /side prefixes", () => {
    expect(extractSideQuestionDisplayText("/btw what changed?")).toBe("what changed?");
    expect(extractSideQuestionDisplayText("/side: what changed?")).toBe("what changed?");
    expect(extractSideQuestionDisplayText("/btw")).toBe("");
  });

  it("never truncates questions that merely resemble follow-up context", () => {
    expect(
      extractSideQuestionDisplayText("/btw Why does this say Follow-up question: pending?"),
    ).toBe("Why does this say Follow-up question: pending?");
  });
});
