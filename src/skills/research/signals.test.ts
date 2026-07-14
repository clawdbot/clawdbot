// Signal extraction tests cover reactive/prospective patterns, grouping, and skill routing.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { extractDurableInstructions, groupDurableInstructionProposals } from "./signals.js";

function userMessage(content: string): { role: string; content: string } {
  return { role: "user", content };
}

function extractDurableInstructionProposals(params: {
  messages: unknown[];
  existingSkills?: Array<{ name: string; description?: string }>;
  maxProposals?: number;
}) {
  return groupDurableInstructionProposals({
    instructions: extractDurableInstructions(params.messages),
    existingSkills: params.existingSkills,
    maxProposals: params.maxProposals,
  });
}

describe("extractDurableInstructionProposals", () => {
  it.each([
    "From now on, when working on GitHub PRs, always check CI before final response.",
    "Going forward every draft should include the source links at the bottom for me.",
    "That's not what I asked for — only use the rule banks, never their delivery style.",
    "You're still using the transcripts as tone references, cut that out of the drafts.",
    "Stop building scorecards before we have any captured evidence in the ledger first.",
    "I told you the raw scripts are all coach data, there is no creator data here yet.",
    "I don't wanna have to repeat myself about the sources block in every new script.",
    "Those scores should never have been invented without real market evidence behind them.",
    "I thought we were working on listening, not scoring — capture the signal first.",
  ])("captures: %s", (content) => {
    const proposals = extractDurableInstructionProposals({ messages: [userMessage(content)] });
    expect(proposals).toHaveLength(1);
    expect(expectDefined(proposals[0], "proposals[0] test invariant").evidence).toContain(
      content.slice(20, 40).trim(),
    );
  });

  it.each([
    "yo this script is bomb",
    "Can you just go ahead and build it?",
    "That looks great, thanks so much for the quick turnaround on this one today.",
    "What is the current state of the trends inbox and the reference library now?",
  ])("ignores: %s", (content) => {
    expect(extractDurableInstructionProposals({ messages: [userMessage(content)] })).toHaveLength(
      0,
    );
  });

  it("groups multiple corrections about one topic into a single proposal", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage("From now on, when working on GitHub PRs, always check CI before replying."),
        userMessage("Next time on a GitHub PR, make sure to link the issue in the description."),
      ],
    });
    expect(proposals).toHaveLength(1);
    expect(expectDefined(proposals[0], "proposals[0] test invariant").skillName).toBe(
      "github-pr-workflow",
    );
    expect(expectDefined(proposals[0], "proposals[0] test invariant").content).toContain(
      "always check CI",
    );
    expect(expectDefined(proposals[0], "proposals[0] test invariant").content).toContain(
      "link the issue",
    );
  });

  it("routes corrections to an existing skill by shared vocabulary", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage(
          "Stop building concept cards before the signal capture has real market evidence.",
        ),
      ],
      existingSkills: [
        { name: "signal-scout", description: "Mine the market for signals and validate them." },
        { name: "content-develop", description: "Draft scripts in the persona voice." },
      ],
    });
    expect(proposals).toHaveLength(1);
    expect(expectDefined(proposals[0], "proposals[0] test invariant").skillName).toBe(
      "signal-scout",
    );
  });

  it("falls back to inferred topics when no existing skill matches", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage("Remember to always optimize screenshot assets before attaching them."),
      ],
      existingSkills: [
        { name: "signal-scout", description: "Mine the market for signals and validate them." },
      ],
    });
    expect(proposals).toHaveLength(1);
    expect(expectDefined(proposals[0], "proposals[0] test invariant").skillName).toBe(
      "screenshot-asset-workflow",
    );
  });

  it("caps the number of proposals, keeping the most recent topics", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage("From now on, when working on GitHub PRs, always check CI before replying."),
        userMessage("Remember to always optimize screenshot assets before attaching them."),
        userMessage("Next time a QA scenario runs, make sure to record the failing seed value."),
        userMessage("From now on animated GIF exports must always use the two-pass palette."),
      ],
      maxProposals: 2,
    });
    expect(proposals.map((proposal) => proposal.skillName)).toEqual([
      "qa-scenario-workflow",
      "animated-gif-workflow",
    ]);
  });

  it("keeps a repeated topic when its latest correction is the most recent", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage("From now on, when working on GitHub PRs, always check CI before replying."),
        userMessage("Remember to always optimize screenshot assets before attaching them."),
        userMessage("Next time a QA scenario runs, make sure to record the failing seed value."),
        userMessage("Next time on a GitHub PR, make sure to link the issue in the description."),
      ],
      maxProposals: 2,
    });
    expect(proposals.map((proposal) => proposal.skillName)).toEqual([
      "qa-scenario-workflow",
      "github-pr-workflow",
    ]);
    const github = proposals.find((proposal) => proposal.skillName === "github-pr-workflow");
    expect(github?.content).toContain("always check CI");
    expect(github?.content).toContain("link the issue");
  });

  it("ignores non-user transcript entries", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        {
          role: "assistant",
          content: "From now on I will always check CI before the final response.",
        },
      ],
    });
    expect(proposals).toHaveLength(0);
  });
});
