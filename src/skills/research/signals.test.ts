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
    "Those scores should never have been invented without real market evidence behind them.",
    "I thought we were working on listening, not scoring — capture the signal first.",
  ])("captures a durable fix: %s", (content) => {
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
    "I don't wanna have to repeat myself about the sources block in every new script.",
  ])("ignores non-durable text or a complaint without a fix: %s", (content) => {
    expect(extractDurableInstructionProposals({ messages: [userMessage(content)] })).toHaveLength(
      0,
    );
  });

  it("ignores a reactive complaint with no concrete replacement", () => {
    expect(
      extractDurableInstructionProposals({
        messages: [userMessage("You're still using transcripts as tone references.")],
      }),
    ).toHaveLength(0);
  });

  it("keeps an explicit fix attached to repetition language", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("I don't want to repeat myself — always include a sources block.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Include a sources block.");
  });

  it("preserves comma-separated subjects before a corrective clause", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            "You're still using transcripts, recordings, and notes as tone references, cut that out.",
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain(
      "- Do not use transcripts, recordings, and notes as tone references.",
    );
  });

  it("preserves the scope of a cut-that-out correction", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            "You're still using the transcripts as tone references, cut that out of the drafts.",
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain(
      "- Do not use transcripts as tone references in the drafts.",
    );
  });

  it("preserves the reactive verb in a cut-that-out correction", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("You're still ignoring failed checks, cut that out.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Do not ignore failed checks.");
  });

  it("does not capture a descriptive first-person always statement", () => {
    expect(
      extractDurableInstructionProposals({
        messages: [userMessage("I always read incident reports.")],
      }),
    ).toHaveLength(0);
  });

  it.each([
    "You should always check CI before replying.",
    "Reports must always verify sources before publishing.",
    "We should always verify sources.",
    "Please always check CI before replying.",
    "You always use ISO dates.",
    "I need you to always check CI before replying.",
    "Could you always check CI before replying?",
    "Always include a sources block.",
    "When handling PRs, always link the issue.",
    "Make it a rule to always check CI before replying.",
    "Policy: always use ISO dates.",
  ])("captures a modal always instruction: %s", (content) => {
    expect(extractDurableInstructionProposals({ messages: [userMessage(content)] })).toHaveLength(
      1,
    );
  });

  it.each(["; ", ". "])("accepts a %sseparator before a reactive fix", (separator) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            `You're still using transcripts as tone references${separator}use recordings instead.`,
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use recordings instead.");
  });

  it("accepts an explicit export replacement", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("You're still using CSV, export JSON instead.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Export JSON instead.");
  });

  it.each([
    ["You're still using raw metadata; sanitize it before publishing.", "Sanitize it"],
    ["I don't want to repeat myself; export JSON.", "Export JSON"],
    ["Stop publishing unfinished drafts.", "Do not publish unfinished drafts"],
    ["Please stop using transcripts as tone references.", "Do not use transcripts"],
  ])("retains a supported reactive action: %s", (content, expected) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({ messages: [userMessage(content)] })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain(expected);
  });

  it.each([
    "That's not what I asked, use JSON instead.",
    "That's not what I asked! Use JSON instead.",
    "That's not what I asked? Use JSON instead.",
    "That's not what I asked, calculate the median instead.",
    "That's not what I asked: use JSON instead.",
    "I told you to check CI first.",
    "I told you not to publish drafts.",
    "Don't publish unfinished drafts again.",
    "I asked you to verify sources.",
    "I asked you not to publish drafts.",
    "I told you never to publish drafts.",
    "I asked you never to publish drafts.",
    "We told you to check CI first.",
    "We asked you not to publish drafts.",
    "I thought we would use JSON instead.",
  ])("retains a direct reactive fix: %s", (content) => {
    expect(extractDurableInstructionProposals({ messages: [userMessage(content)] })).toHaveLength(
      1,
    );
  });

  it("rejects a complaint follow-up question as a durable rule", () => {
    expect(
      extractDurableInstructionProposals({
        messages: [userMessage("That's not what I asked, why did you use CSV?")],
      }),
    ).toHaveLength(0);
  });

  it("rejects a declarative complaint replacement", () => {
    expect(
      extractDurableInstructionProposals({
        messages: [userMessage("That's not what I asked, the report contains private data.")],
      }),
    ).toHaveLength(0);
  });

  it("groups multiple corrections about one task class into a single proposal", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage("From now on, when working on GitHub PRs, always check CI before replying."),
        userMessage("Next time on a GitHub PR, make sure to link the issue in the description."),
      ],
    });
    expect(proposals).toHaveLength(1);
    expect(expectDefined(proposals[0], "proposals[0] test invariant")).toMatchObject({
      skillName: "github",
    });
    expect(expectDefined(proposals[0], "proposals[0] test invariant").content).toContain(
      "- For GitHub PRs: Check CI before replying.",
    );
    expect(expectDefined(proposals[0], "proposals[0] test invariant").content).toContain(
      "- For GitHub PR: Link the issue in the description.",
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

  it("preserves task scope when fuzzily routing to a broader existing skill", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("When handling customer invoices, always record the due date.")],
        existingSkills: [
          {
            name: "billing-operations",
            description: "Handle customer invoices and refunds.",
          },
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("billing-operations");
    expect(proposal.content).toContain("- For customer invoices: Record the due date.");
  });

  it("routes an exact single-token name to the existing skill", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("From now on, when working on GitHub PRs, always check CI before replying."),
        ],
        existingSkills: [{ name: "github", description: "Source hosting tasks." }],
      })[0],
      "proposal test invariant",
    );

    expect(proposal).toMatchObject({ skillName: "github", existingSkill: true });
  });

  it("routes a singular task class to an existing plural skill name", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("When handling an invoice, always record the due date.")],
        existingSkills: [{ name: "invoices" }],
      })[0],
      "proposal test invariant",
    );

    expect(proposal).toMatchObject({ skillName: "invoices", existingSkill: true });
  });

  it("routes a GitHub PR correction to an existing pull-request skill", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("From now on, when working on GitHub PRs, always check CI before replying."),
        ],
        existingSkills: [{ name: "pull-request", description: "Release checklist." }],
      })[0],
      "proposal test invariant",
    );

    expect(proposal).toMatchObject({ skillName: "pull-request", existingSkill: true });
  });

  it("normalizes capitalization in a stop correction", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("Stop Using transcripts as tone references.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Do not use transcripts as tone references.");
    expect(proposal.content).not.toContain("undefined");
  });

  it("derives a stop-correction task class without its rationale", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            "Stop building scorecards before we have any captured evidence in the ledger first.",
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("scorecards");
    expect(proposal.content).toContain(
      "- Do not build scorecards before we have any captured evidence in the ledger first.",
    );
  });

  it("derives a class-level name and trigger-first description without a topic bucket", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("When handling customer invoices, always record the payment due date."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal).toMatchObject({
      skillName: "customer-invoices",
      description: "Customer Invoices: Record the payment due date.",
    });
  });

  it("keeps the distinguishing fourth task-class token", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage("When handling monthly customer invoice exports, always use CSV output."),
        userMessage("When handling monthly customer invoice imports, always use JSON output."),
      ],
    });

    expect(proposals.map((proposal) => proposal.skillName)).toEqual([
      "monthly-customer-invoice-exports",
      "monthly-customer-invoice-imports",
    ]);
  });

  it("keeps distinguishing tokens after the fourth task-class token", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage(
          "When handling monthly enterprise customer invoice exports, always use CSV output.",
        ),
        userMessage(
          "When handling monthly enterprise customer invoice imports, always use JSON output.",
        ),
      ],
    });

    expect(proposals.map((proposal) => proposal.skillName)).toEqual([
      "monthly-enterprise-customer-invoice-exports",
      "monthly-enterprise-customer-invoice-imports",
    ]);
  });

  it("bounds long derived names while preserving uniqueness", () => {
    const prefix = Array.from({ length: 30 }, (_, index) => `topic${index}`).join(" ");
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage(`When handling ${prefix} alpha, always verify output.`),
        userMessage(`When handling ${prefix} beta, always verify output.`),
      ],
    });

    expect(proposals).toHaveLength(2);
    expect(proposals.every((proposal) => proposal.skillName.length <= 64)).toBe(true);
    expect(proposals[0]?.skillName).not.toBe(proposals[1]?.skillName);
  });

  it("derives the topic from the rule when a modal subject is only a pronoun", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, you should always check CI before replying.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("ci");
  });

  it("strips a conversational preface before a prospective marker", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("Okay — going forward, always check CI before replying.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal).toMatchObject({
      skillName: "ci",
      description: "CI: Check CI before replying.",
    });
  });

  it.each([
    ["Use JSON output from now on.", "json-output", "- Use JSON output."],
    ["Use JSON output, from now on.", "json-output", "- Use JSON output."],
    ["Use JSON from now on for reports.", "reports", "- Use JSON."],
    ["Use JSON from now on in reports.", "reports", "- Use JSON."],
    ["Use JSON from now on, when exporting reports.", "exporting-reports", "- Use JSON."],
    [
      "Use JSON output for reports next time.",
      "json-output-reports",
      "- Use JSON output for reports.",
    ],
    ["Use JSON next time you export reports.", "reports", "- Use JSON."],
    [
      "Always record the due date next time you handle customer invoices.",
      "customer-invoices",
      "- Record the due date.",
    ],
    ["Use JSON next time the report is generated.", "report-is-generated", "- Use JSON."],
    ["Use JSON from now on when exporting reports.", "exporting-reports", "- Use JSON."],
    [
      "Use JSON from now on when exporting reports, and verify sources.",
      "exporting-reports",
      "- Verify sources.",
    ],
    ["Use JSON from now on, and verify sources.", "json-sources", "- Use JSON and verify sources."],
  ])("preserves a directive before a postfix marker: %s", (content, skillName, rule) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({ messages: [userMessage(content)] })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe(skillName);
    expect(proposal.content).toContain(rule);
  });

  it("normalizes an event clause after next time", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("Next time you handle customer invoices, always record the due date."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal).toMatchObject({
      skillName: "customer-invoices",
      description: "Customer Invoices: Record the due date.",
    });
  });

  it("preserves task context before make sure to", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("When handling customer invoices, make sure to record the due date."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("customer-invoices");
  });

  it.each([
    "Please remember to check CI before replying.",
    "Could you make sure to check CI before replying.",
  ])("strips a polite wrapper before a prospective marker: %s", (content) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({ messages: [userMessage(content)] })[0],
      "proposal test invariant",
    );

    expect(proposal).toMatchObject({
      skillName: "ci",
      description: "CI: Check CI before replying.",
    });
  });

  it("normalizes a negative modal clause into a prohibition", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, reports should not include drafts.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- For reports: Do not include drafts.");
  });

  it("normalizes a no-output constraint as a prohibition", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, no CSV output.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Do not use CSV output.");
  });

  it("normalizes a no-gerund constraint without inventing use", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, no sending customer data to third parties.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Do not allow sending customer data to third parties.");
    expect(proposal.content).not.toContain("Do not use sending");
    expect(proposal.skillName).toBe("customer-data-third-parties");
  });

  it("abstains from an ambiguous no-noun constraint", () => {
    expect(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, no approvals without tests.")],
      }),
    ).toHaveLength(0);
  });

  it("does not duplicate an existing namespace scope", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, GitHub PRs should not merge failed CI.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- For GitHub PRs: Do not merge failed CI.");
    expect(proposal.content).not.toContain("For GitHub PRs: For GitHub PRs:");
  });

  it("preserves a scoped prohibition ending in output", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, reports should not include CSV output.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- For reports: Do not include CSV output.");
    expect(proposal.content).not.toContain("Use For reports");
  });

  it("omits pronoun scope from a negative modal", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, you should not publish drafts.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Do not publish drafts.");
    expect(proposal.content).not.toContain("For you:");
  });

  it("parses a scoped negative imperative", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, when handling invoices, don't publish drafts.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("invoices");
    expect(proposal.content).toContain("- Do not publish drafts.");
  });

  it("parses a scoped directive from the shared action set", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, when handling customer invoices, export JSON.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("customer-invoices");
    expect(proposal.content).toContain("- Export JSON.");
  });

  it("preserves an actor subject in a negative modal", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, agents should not delete user data.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- For agents: Do not delete user data.");
  });

  it("builds long descriptions from complete clauses", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            `From now on, when handling reports, always write ${"detailed evidence ".repeat(12)}before publishing.`,
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(Buffer.byteLength(proposal.description, "utf8")).toBeLessThanOrEqual(160);
    expect(proposal.description).toBe("Reports: Apply the captured instructions.");
    expect(proposal.description.endsWith(".")).toBe(true);
  });

  it.each([
    [
      "From now on, drafts should not be included in releases.",
      "- Do not allow drafts to be included in releases.",
    ],
    ["From now on, reports should be verified.", "- Require reports to be verified."],
    [
      "From now on, drafts should never be included in releases.",
      "- Do not allow drafts to be included in releases.",
    ],
    ["Drafts should never have been published.", "- Do not allow drafts to be published."],
    [
      "From now on, drafts should not have been published.",
      "- Do not allow drafts to be published.",
    ],
  ])("preserves the subject of a passive modal clause", (content, expected) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({ messages: [userMessage(content)] })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain(expected);
  });

  it("preserves commas inside a contextual task class", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            "When processing transcripts, recordings, and notes, always sanitize metadata.",
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Sanitize metadata.");
    expect(proposal.content).not.toContain("- Recordings.");
  });

  it.each([
    ["When you handle invoices, always record the due date.", "invoices"],
    ["When you're handling GitHub PRs, always check CI.", "github"],
    ["When reviewing invoices, always record the due date.", "invoices"],
    ["When writing reports, always verify sources.", "reports"],
    ["When asked for invoice exports, always use CSV.", "invoice-exports"],
  ])("strips a contextual task wrapper: %s", (content, skillName) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({ messages: [userMessage(content)] })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe(skillName);
  });

  it("parses a progressive event after next time", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("Next time you're handling invoices, always record the due date.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("invoices");
    expect(proposal.content).toContain("- Record the due date.");
  });

  it("parses a smart-quote progressive event after next time", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("Next time you’re handling invoices, always record the due date.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("invoices");
  });

  it("parses a supported action as a next-time event", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("Next time you export reports, use JSON.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("reports");
    expect(proposal.content).toContain("- Use JSON.");
  });

  it("preserves meaningful words in an explicit task class", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("When handling landing pages, always optimize images.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("landing-pages");
  });

  it("preserves landing as a fallback noun modifier", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("Always optimize landing pages before publishing them.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toContain("landing-pages");
  });

  it("normalizes the date-formatting example into routable proposal metadata and body", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            "From now on when I ask for date reformatting: ISO 8601 output, ISO week number in parentheses, sorted chronologically.",
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal).toMatchObject({
      skillName: "date-reformatting",
      description:
        "Date Reformatting: Use ISO 8601 output; Include ISO week number in parentheses; Sort chronologically.",
    });
    expect(proposal.content).toContain("- Use ISO 8601 output.");
    expect(proposal.content).toContain("- Include ISO week number in parentheses.");
    expect(proposal.content).toContain("- Sort chronologically.");
    expect(proposal.content).toContain("## Verification");
    expect(proposal.content).not.toContain("From now on");
  });

  it("keeps a comma-separated object list in one procedure step", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("From now on when writing metadata: include title, author, and date."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Include title, author, and date.");
    expect(proposal.content).not.toContain("- Author.");
  });

  it.each([
    ["always verify output", "- Verify output."],
    ["always put the week number in parentheses", "- Put the week number in parentheses."],
    ["always prefer JSON output", "- Prefer JSON output."],
  ])("preserves an imperative clause: %s", (rule, expected) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage(`From now on, ${rule}.`)],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain(expected);
  });

  it("does not copy a temporary run identifier into the derived skill name", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            "From now on, when processing run abc12345 results, always verify the output checksum.",
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).not.toContain("abc12345");
    expect(proposal.skillName).toContain("run");
  });

  it("retains the task class when the temporary identifier is the final topic token", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            "From now on, when processing run abc12345, always verify the output checksum.",
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("run");
  });

  it.each(["42", "deadbeef", "x7k9m2q8"])("strips temporary run identifier %s", (identifier) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            `From now on, when processing run ${identifier} results, always verify the checksum.`,
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).not.toContain(identifier);
    expect(proposal.skillName).toContain("run");
  });

  it("strips a single-character numeric run identifier", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("From now on, when processing run 7 results, always verify the checksum."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).not.toContain("7");
    expect(proposal.skillName).toContain("run");
  });

  it.each(["550e8400-e29b-41d4-a716-446655440000", "INC-1234"])(
    "strips temporary identifier shape %s",
    (identifier) => {
      const proposal = expectDefined(
        extractDurableInstructionProposals({
          messages: [
            userMessage(
              `From now on, when processing run ${identifier} results, always verify the checksum.`,
            ),
          ],
        })[0],
        "proposal test invariant",
      );

      expect(proposal.skillName).not.toContain(identifier.toLowerCase());
    },
  );

  it("preserves a stable digit-bearing token after an artifact-class noun", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            "From now on, when handling session 2FA cookies, always verify the signature.",
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("session-2fa-cookies");
  });

  it("preserves a stable OAuth2 task identifier after request", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            "From now on, when handling request OAuth2 callbacks, always verify the signature.",
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("request-oauth2-callbacks");
  });

  it("preserves a stable numeric request task class", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            "From now on, when handling request 404 responses, always record the response body.",
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("request-404-responses");
  });

  it("retains surrounding task tokens for an ordinary hub noun", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("From now on, when handling data hub exports, always verify the checksum."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("data-hub-exports");
  });

  it("groups a hub namespace consistently across capitalization", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage("From now on, when working on GitHub PRs, always check CI before replying."),
        userMessage("Next time on github PRs, make sure to link the issue."),
      ],
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.skillName).toBe("github");
  });

  it("preserves task qualifiers inside a grouped hub namespace", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("From now on, for GitHub PRs, always check CI before replying."),
          userMessage("Next time for GitHub releases, always verify the tag before publishing."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- For GitHub PRs: Check CI before replying.");
    expect(proposal.content).toContain("- For GitHub releases: Verify the tag before publishing.");
  });

  it("preserves every trailing directive in postfix scope", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(
            "Use JSON from now on when exporting reports, and verify sources, and sign output.",
          ),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use JSON.");
    expect(proposal.content).toContain("- Verify sources.");
    expect(proposal.content).toContain("- Sign output.");
  });

  it("preserves a postfix scope list without treating its final item as a directive", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("Use JSON from now on when exporting invoices, reports, and receipts."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toContain("receipts");
    expect(proposal.content).toContain("- Use JSON.");
    expect(proposal.content).not.toContain("Use JSON, receipts");
  });

  it("does not merge short tokens that only look plural", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage("When handling news articles, always verify sources."),
        userMessage("When handling new articles, always verify titles."),
      ],
    });

    expect(proposals.map((proposal) => proposal.skillName)).toEqual([
      "news-articles",
      "new-articles",
    ]);
  });

  it.each([
    ["animated GIF", "animated GIFs"],
    ["API", "APIs"],
  ])("groups genuine short plurals: %s / %s", (singular, plural) => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage(`When handling ${singular}, always verify output.`),
        userMessage(`When handling ${plural}, always verify sources.`),
      ],
    });

    expect(proposals).toHaveLength(1);
  });

  it("extracts a stop correction after a leading wrapper", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("We need to stop building scorecards before evidence is captured.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("scorecards");
    expect(proposal.content).toContain("- Do not build scorecards before evidence is captured.");
  });

  it("does not convert a first-person intention into an agent prohibition", () => {
    expect(
      extractDurableInstructionProposals({
        messages: [userMessage("I need to stop using this service permanently.")],
      }),
    ).toHaveLength(0);
  });

  it("does not reinterpret an embedded stop clause", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("Always record when workers stop sending telemetry.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Record when workers stop sending telemetry.");
    expect(proposal.content).not.toContain("Do not send telemetry");
  });

  it("preserves stable architecture task identifiers", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage("When handling build x86 artifacts, always verify checksums."),
        userMessage("When handling build x64 artifacts, always verify signatures."),
      ],
    });

    expect(proposals.map((proposal) => proposal.skillName)).toEqual([
      "build-x86-artifacts",
      "build-x64-artifacts",
    ]);
  });

  it.each(["aarch64", "riscv64"])("preserves stable architecture %s", (architecture) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(`When handling build ${architecture} artifacts, always verify checksums.`),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toContain(architecture);
  });

  it.each(["wasm32", "wasm64", "base64"])(
    "preserves stable digit-bearing build target %s",
    (target) => {
      const proposal = expectDefined(
        extractDurableInstructionProposals({
          messages: [
            userMessage(`When handling build ${target} artifacts, always verify checksums.`),
          ],
        })[0],
        "proposal test invariant",
      );

      expect(proposal.skillName).toContain(target);
    },
  );

  it.each([", ", "; ", ". "])(
    "accepts a %sseparator before an explicit repetition fix",
    (separator) => {
      const proposal = expectDefined(
        extractDurableInstructionProposals({
          messages: [
            userMessage(`I don't want to repeat myself${separator}always include a sources block.`),
          ],
        })[0],
        "proposal test invariant",
      );

      expect(proposal.content).toContain("- Include a sources block.");
    },
  );

  it("accepts a prohibition as an explicit repetition fix", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("I don't want to repeat myself; don't include private notes.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Do not include private notes.");
  });

  it("strips a standalone incident identifier", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, when handling INC-1234, always verify the checksum.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).not.toContain("inc-1234");
  });

  it("captures a contextual always rule without comma punctuation", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("When handling invoices always record the due date.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("invoices");
    expect(proposal.content).toContain("- Record the due date.");
  });

  it.each([
    ["OAuth2 callbacks", "oauth2-callbacks"],
    ["S3 objects", "s3-objects"],
  ])("keeps stable digit-bearing task identifiers in %s", (taskClass, skillName) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(`From now on, when handling ${taskClass}, always verify the signature.`),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe(skillName);
  });

  it.each([
    ["session cookies", "session-cookies"],
    ["request signing", "request-signing"],
    ["trace context", "trace-context"],
  ])("keeps stable task-class phrase %s", (taskClass, skillName) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage(`From now on, when handling ${taskClass}, always verify the signature.`),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe(skillName);
  });

  it("caps proposals by the most recently corrected task classes", () => {
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
      "qa-scenario",
      "animated-gif-exports",
    ]);
  });

  it("filters complaint-only messages before applying the instruction cap", () => {
    const messages = [
      userMessage("From now on, when handling invoices, always record the due date."),
      ...Array.from({ length: 8 }, (_, index) =>
        userMessage(`You're still using transcript ${index} as a tone reference.`),
      ),
    ];

    const proposals = extractDurableInstructionProposals({ messages });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.skillName).toBe("invoices");
  });

  it("filters unroutable corrections before applying the instruction cap", () => {
    const messages = [
      userMessage("From now on, when handling invoices, always record the due date."),
      ...Array.from({ length: 8 }, (_, index) =>
        userMessage(`${index % 2 === 0 ? "From now on" : "Going forward"}, always check.`),
      ),
    ];

    const proposals = extractDurableInstructionProposals({ messages });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.skillName).toBe("invoices");
  });

  it("limits normalization to the directive sentence", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, always use JSON. Can you rerun the report?")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use JSON.");
    expect(proposal.content).not.toContain("rerun the report");
    expect(proposal.skillName).not.toContain("rerun");
  });

  it("preserves additional durable directive sentences", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, always use JSON. Always verify sources.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use JSON.");
    expect(proposal.content).toContain("- Verify sources.");
  });

  it("preserves a later modal directive sentence", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, use JSON. Reports must always verify sources.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.skillName).toBe("reports");
    expect(proposal.content).toContain("- Verify sources.");
  });

  it("preserves a contextual follow-up directive", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage(
          "From now on, when handling invoices, record due dates. When publishing reports, always verify sources.",
        ),
      ],
    });

    expect(proposals.map((proposal) => proposal.skillName)).toEqual([
      "invoices",
      "publishing-reports",
    ]);
  });

  it("preserves a future-marker phrase inside the directive", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, always record the next time the job runs.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Record the next time the job runs.");
  });

  it("preserves an arbitrary explicit follow-up directive", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, use JSON. Scrub secrets before publishing.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Scrub secrets before publishing.");
  });

  it("preserves a stop follow-up directive", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, use JSON. Stop publishing CSV reports.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Do not publish CSV reports.");
  });

  it("rejects a declarative follow-up sentence", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("From now on, always use JSON. The current report contains private data."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).not.toContain("current report contains private data");
  });

  it("rejects a declarative follow-up without a leading article", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("From now on, always use JSON. Customer report contains private data."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).not.toContain("Customer report contains private data");
  });

  it("routes independently marked follow-up sentences separately", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage(
          "From now on, when handling invoices, record due dates. From now on, when publishing reports, verify sources.",
        ),
      ],
    });

    expect(proposals.map((proposal) => proposal.skillName)).toEqual([
      "invoices",
      "publishing-reports",
    ]);
  });

  it("routes later modal task classes separately", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage("Reports must always verify sources. Invoices must always record due dates."),
      ],
    });

    expect(proposals.map((proposal) => proposal.skillName)).toEqual(["reports", "invoices"]);
  });

  it("preserves split-candidate recency order", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage(
          "From now on, use JSON. When handling invoices, always record due dates. Always sign final reports.",
        ),
      ],
      maxProposals: 1,
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.skillName).toContain("reports");
  });

  it("preserves abbreviations inside a directive sentence", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, always include a source, e.g. the original report.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("e.g. the original report");
  });

  it("does not capture a contextual first-person habit", () => {
    expect(
      extractDurableInstructionProposals({
        messages: [userMessage("On Mondays, I always send a summary to my team.")],
      }),
    ).toHaveLength(0);
  });

  it("does not capture an unpunctuated contextual first-person habit", () => {
    expect(
      extractDurableInstructionProposals({
        messages: [userMessage("On Mondays I always send a summary to my team.")],
      }),
    ).toHaveLength(0);
  });

  it("keeps a later durable instruction after a first-person habit", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("On Mondays, I always send a summary. From now on, always use JSON."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use JSON.");
    expect(proposal.content).not.toContain("send a summary");
  });

  it("keeps a directive with an embedded first-person rationale", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("Always notify me when builds fail because I always investigate them."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain(
      "- Notify me when builds fail because I always investigate them.",
    );
  });

  it("keeps a contextual directive with a first-person rationale", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("When reports arrive, always verify sources because I always audit them."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("Verify sources because I always audit them");
  });

  it("keeps a same-sentence durable clause after a first-person habit", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("On Mondays, I always send a summary, but from now on, always use JSON."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use JSON.");
    expect(proposal.content).not.toContain("send a summary");
  });

  it("does not capture a prefixed first-person habit", () => {
    expect(
      extractDurableInstructionProposals({
        messages: [userMessage("FYI, on Mondays I always send a summary to my team.")],
      }),
    ).toHaveLength(0);
  });

  it("normalizes a direct polite request after a prospective marker", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, could you check CI before replying?")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Check CI before replying.");
  });

  it("preserves politely wrapped follow-up directives", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, use JSON. Please verify sources.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use JSON.");
    expect(proposal.content).toContain("- Verify sources.");
  });

  it("preserves a supported follow-up action", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, use JSON. Calculate the median.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Calculate the median.");
  });

  it("preserves a notify follow-up action", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, use JSON. Notify the owner before publishing.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Notify the owner before publishing.");
  });

  it("preserves an also-prefixed follow-up action", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, use JSON. Also verify sources.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Verify sources.");
  });

  it("preserves contain as an imperative before output shorthand", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, reports should always contain JSON output.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Contain JSON output.");
    expect(proposal.content).not.toContain("Use contain");
  });

  it("does not use a pronoun as fuzzy-match scope", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("You should always check CI before replying.")],
        existingSkills: [
          { name: "pull-request", description: "Check CI before pull request replies." },
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).not.toContain("For You:");
  });

  it("keeps a repeated task class when its latest correction is the most recent", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage("From now on, when working on GitHub PRs, always check CI before replying."),
        userMessage("Remember to always optimize screenshot assets before attaching them."),
        userMessage("Next time a QA scenario runs, make sure to record the failing seed value."),
        userMessage("Next time on a GitHub PR, make sure to link the issue in the description."),
      ],
      maxProposals: 2,
    });
    expect(proposals.map((proposal) => proposal.skillName)).toEqual(["qa-scenario", "github"]);
  });

  it("derives one fallback class across different recognized actions", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage("Always deploy production releases."),
        userMessage("Always verify production releases."),
      ],
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.skillName).toBe("production-releases");
  });

  it("normalizes never noun shorthand with an inferred verb", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, use JSON, never CSV.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Do not use CSV.");
    expect(proposal.content).toContain("- Use JSON.");
  });

  it("preserves both comma-separated positive directives", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, use JSON, verify sources.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use JSON, verify sources.");
  });

  it("normalizes lowercase single-token never shorthand", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, use JSON, never csv.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Do not use csv.");
  });

  it("abstains from ambiguous multiword never shorthand", () => {
    expect(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, never private notes.")],
      }),
    ).toHaveLength(0);
  });

  it("normalizes an unrestricted verb after never", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, reports should never contain PII.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Do not contain PII.");
    expect(proposal.content).not.toContain("Do not use contain");
  });

  it("normalizes disclose as an explicit never action", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, never disclose credentials.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Do not disclose credentials.");
  });

  it("normalizes share as an explicit never action", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, never share credentials.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Do not share credentials.");
  });

  it("keeps a later prospective rule after an unparseable leading signal", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [
          userMessage("The report is still using CSV. Always use JSON output for reports."),
        ],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use JSON output for reports.");
  });

  it("preserves a lowercase command token", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, git fetch before rebasing.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- git fetch before rebasing.");
    expect(proposal.content).not.toContain("- Git fetch");
  });

  it.each([
    ["From now on, open -a Safari.", "- open -a Safari."],
    ["From now on, export FOO=bar.", "- export FOO=bar."],
    ["From now on, open /tmp/report.", "- open /tmp/report."],
  ])("preserves lowercase command-shaped actions: %s", (content, expected) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({ messages: [userMessage(content)] })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain(expected);
  });

  it("preserves a standalone current-directory command argument", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, run git add . && git commit.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Run git add . && git commit.");
  });

  it("preserves a standalone dot before a positional flag", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, run find . -name '*.ts'.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Run find . -name '*.ts'.");
  });

  it("rejects declarative text after a prospective marker", () => {
    expect(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, the report contains private data.")],
      }),
    ).toHaveLength(0);
  });

  it.each([
    ["From now on: Mask sensitive output.", "- Mask sensitive output."],
    ["From now on: Wrap values in parentheses.", "- Wrap values in parentheses."],
  ])("preserves capitalized explicit unknown actions: %s", (content, expected) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({ messages: [userMessage(content)] })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain(expected);
  });

  it.each([
    ["From now on, never redact customer data.", "Do not redact customer data"],
    ["From now on, redact sensitive output.", "Redact sensitive output"],
    ["Stop deleting user data permanently.", "Stop deleting user data"],
  ])("preserves an explicit action outside the shared vocabulary: %s", (content, expected) => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({ messages: [userMessage(content)] })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain(expected);
  });

  it("preserves directives before a later prospective marker", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [userMessage("Always verify original sources. From now on, use JSON output.")],
    });

    expect(proposals).toHaveLength(2);
    expect(proposals[0]?.content).toContain("- Verify original sources.");
    expect(proposals[1]?.content).toContain("- Use JSON output.");
  });

  it("drops a superseded first-person habit before a prospective marker", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("I always use CSV for reports. From now on, use JSON output.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use JSON output.");
    expect(proposal.content).not.toContain("use CSV");
  });

  it("drops first-person present state before a prospective marker", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("I use CSV today, but from now on, use JSON output.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use JSON output.");
    expect(proposal.content).not.toContain("CSV today");
  });

  it("drops a declarative action-shaped noun before a prospective marker", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("The current export failed; from now on, always use JSON.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use JSON.");
    expect(proposal.content).not.toContain("current export failed");
  });

  it("drops a one-off command before a prospective marker", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("Use CSV for this report; from now on, always use JSON.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use JSON.");
    expect(proposal.content).not.toContain("Use CSV for this report");
  });

  it("captures an always directive after a status sentence", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("The report is ready. Always verify sources before publishing.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Verify sources before publishing.");
    expect(proposal.content).not.toContain("report is ready");
  });

  it("preserves initialism abbreviations in directive sentences", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, always use the U.S. date format.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Use the U.S. date format.");
  });

  it("preserves title abbreviations in directive sentences", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, always send the report to Dr. Smith for approval.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Send the report to Dr. Smith for approval.");
  });

  it("sentence-cases a do-not directive", () => {
    const proposal = expectDefined(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, do not publish drafts.")],
      })[0],
      "proposal test invariant",
    );

    expect(proposal.content).toContain("- Do not publish drafts.");
  });

  it("rejects a noun-led declarative after a prospective marker", () => {
    expect(
      extractDurableInstructionProposals({
        messages: [userMessage("From now on, customer report contains private data.")],
      }),
    ).toHaveLength(0);
  });

  it("attaches an unmarked follow-up to a later marker", () => {
    const proposals = extractDurableInstructionProposals({
      messages: [
        userMessage(
          "Always verify original sources. From now on, use JSON output. Scrub secrets before publishing.",
        ),
      ],
    });

    const json = proposals.find((proposal) => proposal.content.includes("Use JSON output"));
    expect(json?.content).toContain("- Scrub secrets before publishing.");
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
