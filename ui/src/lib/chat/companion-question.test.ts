import { describe, expect, it } from "vitest";
import {
  buildCompanionQuestionPrefill,
  buildMoreDetailsCompanionQuestion,
  extractCompanionCommandQuestion,
} from "./companion-question.ts";

describe("companion selection questions", () => {
  it("builds a bounded single-line details question", () => {
    expect(buildMoreDetailsCompanionQuestion("Let's Encrypt cert\nis valid")).toBe(
      'Explain "Let\'s Encrypt cert is valid" from this conversation in more detail.',
    );
  });

  it("builds a rail composer prefill without changing the main composer", () => {
    expect(buildCompanionQuestionPrefill("cron scan job")).toBe('Regarding "cron scan job": ');
  });

  it("extracts both Control UI command aliases", () => {
    expect(extractCompanionCommandQuestion("/btw what changed?")).toBe("what changed?");
    expect(extractCompanionCommandQuestion("/side: what changed?")).toBe("what changed?");
    expect(extractCompanionCommandQuestion("/btw")).toBe("");
  });
});
