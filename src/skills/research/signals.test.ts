import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { extractDurableInstructions, groupDurableInstructionProposals } from "./signals.js";

const user = (content: string) => ({ role: "user", content });
function proposals(
  messages: unknown[],
  existingSkills?: Array<{ name: string; description?: string }>,
) {
  return groupDurableInstructionProposals({
    instructions: extractDurableInstructions(messages),
    existingSkills,
  });
}

describe("durable instruction signals", () => {
  it.each([
    "From now on, when working on GitHub PRs, always check CI before final response.",
    "Going forward every draft should include the source links at the bottom for me.",
    "That's not what I asked for — only use the rule banks, never their delivery style.",
    "Remember to always optimize screenshot assets before attaching them.",
    "You're still using the transcripts as tone references — they should not be included as voice material at all.",
    "Stop building scorecards before we have any captured evidence in the ledger first.",
    "I thought we were working on listening — capture real market signals with quoted evidence before scoring anything.",
  ])("captures a durable instruction: %s", (content) => {
    const result = proposals([user(content)]);
    expect(result).toHaveLength(1);
    expect(result[0]?.evidence).toContain(content.slice(20, 40).trim());
  });

  it.each([
    "yo this script is bomb",
    "Can you just go ahead and build it?",
    "That looks great, thanks so much for the quick turnaround on this one today.",
    "What is the current state of the trends inbox and the reference library now?",
    "I don't wanna have to repeat myself about the sources block.",
    "I told you the raw scripts are all coach data, there is no creator data here yet.",
    "Those scores should never have been invented without real market evidence behind them.",
    "From now on, no server is available.",
    "Check whether the worker always exits cleanly.",
    "Export is still using the legacy format.",
    "From now on, private notes.",
    "Can you tell me the next time the job runs?",
    "I thought we were working on listening.",
  ])("ignores non-procedural text: %s", (content) => {
    expect(proposals([user(content)])).toHaveLength(0);
  });

  it("captures a direct correction as an imperative rule", () => {
    const proposal = expectDefined(proposals([user("I told you to check CI first.")])[0], "fix");
    expect(proposal.content).toContain("- Check CI first.");
    expect(proposal.content).not.toContain("I told you");
  });

  it("normalizes comma-separated use constraints without malformed noun rules", () => {
    const proposal = expectDefined(
      proposals([
        user("That's not what I asked for — only use the rule banks, never their delivery style."),
      ])[0],
      "use constraint",
    );
    expect(proposal.content).toContain("- Use only the rule banks.");
    expect(proposal.content).toContain("- Do not use their delivery style.");
  });

  it.each([
    ["From now on, redact sensitive output.", "Redact sensitive output."],
    ["Reports should always contain JSON output.", "Contain JSON output."],
    ["From now on, Json output.", "Use Json output."],
  ])("does not rewrite an action as output shorthand: %s", (content, expected) => {
    const proposal = expectDefined(proposals([user(content)])[0], "output rule");
    expect(proposal.content).toContain(`- ${expected}`);
  });

  it.each([
    ["From now on, use JSON.", "Use JSON."],
    ["Use JSON from now on.", "Use JSON."],
    ["Always publish final reports.", "Publish final reports."],
    ["Always sanitize private metadata.", "Sanitize private metadata."],
  ])("keeps marker-qualified and generic always rules: %s", (content, expected) => {
    const proposal = expectDefined(proposals([user(content)])[0], "prospective rule");
    expect(proposal.content).toContain(`- ${expected}`);
  });

  it("isolates an embedded marker-scoped directive", () => {
    const proposal = expectDefined(
      proposals([user("The current export failed; from now on, always use JSON.")])[0],
      "embedded marker",
    );
    expect(proposal.content).toContain("- Use JSON.");
    expect(proposal.content).not.toContain("current export failed");
  });

  it("parses durable sentences independently from surrounding transcript text", () => {
    const result = proposals([
      user(
        "From now on, always use JSON. customer report contains private data. Reports must always verify sources. Invoices must always record due dates.",
      ),
    ]);
    expect(result.map((proposal) => proposal.skillName)).toEqual(["json", "reports", "invoices"]);
    expect(result[0]?.content).toContain("- Use JSON.");
  });

  it("joins a bare complaint to the following fix without splitting abbreviations", () => {
    const result = proposals([
      user("That's not what I asked. Use JSON instead."),
      user("From now on, address reports to Dr. Smith before publishing."),
    ]);
    expect(result[0]?.content).toContain("- Use JSON instead.");
    expect(result[1]?.content).toContain("- Address reports to Dr. Smith before publishing.");
  });

  it("keeps supported location abbreviations in one sentence", () => {
    const proposal = expectDefined(
      proposals([user("From now on, always send reports to St. Louis.")])[0],
      "location abbreviation",
    );
    expect(proposal.content).toContain("- Send reports to St. Louis.");
  });

  it("keeps unmarked directive follow-ups under the active durable scope", () => {
    const result = proposals([
      user("From now on, use JSON. Scrub secrets before publishing."),
      user("I don't want to repeat myself. Export JSON."),
    ]);
    expect(
      result.some((proposal) => proposal.content.includes("Scrub secrets before publishing")),
    ).toBe(true);
    expect(result.some((proposal) => proposal.content.includes("Export JSON"))).toBe(true);
  });

  it("recognizes a supported action in an unmarked follow-up", () => {
    const result = proposals([user("From now on, use JSON. Notify the owner before publishing.")]);
    expect(result.some((proposal) => proposal.content.includes("Notify the owner"))).toBe(true);
  });

  it("captures generic stop corrections", () => {
    const proposal = expectDefined(
      proposals([user("Stop publishing unfinished drafts.")])[0],
      "stop correction",
    );
    expect(proposal.content).toContain("- Stop publishing unfinished drafts.");
  });

  it.each([
    "From now on, the report contains private data.",
    "From now on, customer report contains private data.",
    "On Mondays, I always send a summary.",
    "On Mondays I always send a summary.",
  ])("rejects declarative text as a procedure: %s", (content) => {
    expect(proposals([user(content)])).toHaveLength(0);
  });

  it("derives the requested date proposal deterministically", () => {
    const proposal = expectDefined(
      proposals([
        user(
          "From now on when I ask for date reformatting: ISO 8601 output, ISO week number in parentheses, sorted chronologically.",
        ),
      ])[0],
      "date proposal",
    );
    expect(proposal).toMatchObject({
      skillName: "date-reformatting",
      description:
        "Date Reformatting: Use ISO 8601 output; Include ISO week number in parentheses; Sort chronologically.",
    });
    expect(proposal.content).toContain("- Use ISO 8601 output.");
    expect(proposal.content).toContain("- Include ISO week number in parentheses.");
    expect(proposal.content).toContain("- Sort chronologically.");
    expect(proposal.content).not.toContain("From now on");
  });

  it("keeps comma-separated objects in one procedure step", () => {
    const proposal = expectDefined(
      proposals([user("From now on when writing metadata: include title, author, and date.")])[0],
      "metadata proposal",
    );
    expect(proposal.content).toContain("- Include title, author, and date.");
    expect(proposal.content).not.toContain("- Author.");
  });

  it.each([
    ["Next time you handle customer invoices, always record the due date.", "customer-invoices"],
    ["Next time you export reports, use JSON.", "reports"],
  ])("keeps actor-event task scope: %s", (content, skillName) => {
    expect(proposals([user(content)])[0]?.skillName).toBe(skillName);
  });

  it("parses a postfix actor-event marker", () => {
    const proposal = expectDefined(
      proposals([user("Use JSON next time you export reports.")])[0],
      "postfix actor event",
    );
    expect(proposal).toMatchObject({ skillName: "reports", description: "Reports: Use JSON." });
  });

  it("finds the directive after a comma-bearing task class", () => {
    const proposal = expectDefined(
      proposals([
        user("When processing transcripts, recordings, and notes, always sanitize metadata."),
      ])[0],
      "comma task class",
    );
    expect(proposal.skillName).toBe("transcripts-recordings-notes");
    expect(proposal.content).toContain("- Sanitize metadata.");
  });

  it("groups related GitHub corrections and preserves their task scopes", () => {
    const result = proposals([
      user("From now on, when working on GitHub PRs, always check CI before replying."),
      user("Next time on a GitHub PR, make sure to link the issue in the description."),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.skillName).toBe("github");
    expect(result[0]?.content).toContain("For GitHub PRs: Check CI before replying.");
    expect(result[0]?.content).toContain("For GitHub PR: Link the issue in the description.");
  });

  it("routes a GitHub PR correction to an existing pull-request skill", () => {
    const result = proposals(
      [user("From now on, when working on GitHub PRs, always check CI before replying.")],
      [{ name: "pull-request", description: "Release checklist." }],
    );
    expect(result[0]).toMatchObject({ skillName: "pull-request", existingSkill: true });
  });

  it("routes shared vocabulary to an existing skill", () => {
    const result = proposals(
      [
        user(
          "I thought we were working on listening — capture real market signals with quoted evidence before scoring anything.",
        ),
      ],
      [{ name: "signal-scout", description: "Mine market signals before drafting." }],
    );
    expect(result[0]?.skillName).toBe("signal-scout");
  });

  it("keeps task scope when routing to a broader existing skill", () => {
    const result = proposals(
      [user("When handling customer invoices, always record the due date.")],
      [{ name: "billing-operations", description: "Handle customer invoices and refunds." }],
    );
    expect(result[0]).toMatchObject({ skillName: "billing-operations", existingSkill: true });
    expect(result[0]?.content).toContain("- For customer invoices: Record the due date.");
  });

  it("accepts an unpunctuated contextual always rule", () => {
    const proposal = proposals(
      [user("When handling invoice always record the due date.")],
      [{ name: "invoices" }],
    )[0];
    expect(proposal).toMatchObject({
      skillName: "invoices",
      description: "Invoices: Record the due date.",
    });
  });

  it("preserves the subject of a positive passive modal", () => {
    const proposal = expectDefined(
      proposals([user("From now on, reports should be verified.")])[0],
      "passive modal",
    );
    expect(proposal.content).toContain("- Require reports to be verified.");
  });

  it.each([
    [
      "You're still using transcripts, recordings, and notes as tone references, cut that out of the drafts.",
      "Do not use transcripts, recordings, and notes as tone references in the drafts.",
    ],
    ["You're still ignoring failed checks, cut that out.", "Do not ignore failed checks."],
  ])("normalizes a reactive still correction: %s", (content, expected) => {
    const proposal = expectDefined(proposals([user(content)])[0], "reactive proposal");
    expect(proposal.content).toContain(`- ${expected}`);
  });

  it("uses the shared action matcher for reactive replacements", () => {
    const proposal = expectDefined(
      proposals([user("You're still using raw metadata; sanitize it before publishing.")])[0],
      "sanitize correction",
    );
    expect(proposal.content).toContain("- Sanitize it before publishing.");
  });

  it("keeps a concrete fix attached to repetition language", () => {
    const proposal = expectDefined(
      proposals([user("I don't want to repeat myself; always include a sources block.")])[0],
      "repetition fix",
    );
    expect(proposal.content).toContain("- Include a sources block.");
  });

  it("keeps stable numeric task classes distinct", () => {
    const result = proposals([
      user("When handling request 404 responses, always record the body."),
      user("When handling request 500 responses, always record the body."),
    ]);
    expect(result.map((proposal) => proposal.skillName)).toEqual([
      "request-404-responses",
      "request-500-responses",
    ]);
  });

  it("normalizes format shorthand and generic never-action rules", () => {
    const csv = expectDefined(proposals([user("From now on, never CSV output.")])[0], "csv");
    expect(csv.content).toContain("- Do not use CSV output.");
    const credentials = expectDefined(
      proposals([user("From now on, never disclose credentials.")])[0],
      "credentials",
    );
    expect(credentials.content).toContain("- Do not disclose credentials.");
  });

  it("accepts a marker-qualified polite directive", () => {
    const proposal = expectDefined(
      proposals([user("From now on, could you check CI before replying?")])[0],
      "polite directive",
    );
    expect(proposal.content).toContain("- Check CI before replying.");
  });

  it("accepts an explicit polite always request without another marker", () => {
    const proposal = expectDefined(
      proposals([user("Could you always check CI before replying?")])[0],
      "polite always request",
    );
    expect(proposal.content).toContain("- Check CI before replying.");
  });

  it("parses a postfix marker with task scope", () => {
    const proposal = expectDefined(
      proposals([user("Use JSON from now on for reports.")])[0],
      "postfix marker",
    );
    expect(proposal).toMatchObject({
      skillName: "reports",
      description: "Reports: Use JSON.",
    });
  });

  it.each([
    ["Use JSON from now on, and verify sources.", undefined, ["Use JSON.", "Verify sources."]],
    [
      "Use JSON from now on when exporting reports, and verify sources.",
      "exporting-reports",
      ["Use JSON.", "Verify sources."],
    ],
  ])("parses a postfix marker continuation: %s", (content, skillName, rules) => {
    const proposal = expectDefined(proposals([user(content)])[0], "postfix continuation");
    if (skillName) {
      expect(proposal.skillName).toBe(skillName);
    }
    for (const rule of rules) {
      expect(proposal.content).toContain(`- ${rule}`);
    }
    expect(proposal.content).not.toContain("from now on");
  });

  it("keeps a coordinated list inside postfix task scope", () => {
    const proposal = expectDefined(
      proposals([user("Use JSON from now on when exporting invoices, reports, and receipts.")])[0],
      "postfix list scope",
    );
    expect(proposal.skillName).toBe("exporting-invoices-reports-receipts");
    expect(proposal.content).not.toContain("- Receipts.");
  });

  it.each(["I need you to always check CI before replying.", "You always use ISO dates."])(
    "normalizes an actor-prefixed always request: %s",
    (content) => {
      expect(proposals([user(content)])).toHaveLength(1);
    },
  );

  it.each([
    ["From now on, git fetch before rebasing.", "- git fetch before rebasing."],
    ["From now on, export FOO=bar.", "- export FOO=bar."],
    ["Remember to run git add .", "- Run git add ."],
    [
      "Remember to call the release webhook before publishing.",
      "- Call the release webhook before publishing.",
    ],
  ])("preserves explicit directive syntax: %s", (content, expected) => {
    expect(proposals([user(content)])[0]?.content).toContain(expected);
  });

  it("rejects an ambiguous noun phrase after never", () => {
    expect(proposals([user("From now on, never private notes.")])).toHaveLength(0);
  });

  it("keeps a comma-separated repetition fix", () => {
    const proposal = expectDefined(
      proposals([user("I don't want to repeat myself, always include a sources block.")])[0],
      "comma repetition fix",
    );
    expect(proposal.content).toContain("- Include a sources block.");
  });

  it("caps only routable instructions", () => {
    const unroutable = Array.from({ length: 8 }, () => user("From now on, always check."));
    const result = proposals([
      user("When handling invoices, always record the due date."),
      ...unroutable,
    ]);
    expect(result.map((proposal) => proposal.skillName)).toEqual(["invoices"]);
  });

  it("keeps ordinary nouns following artifact words", () => {
    const result = proposals([
      user("When handling session cookies, always record their expiry."),
      user("When handling session records, always record their owner."),
    ]);
    expect(result.map((proposal) => proposal.skillName)).toEqual([
      "session-cookies",
      "session-records",
    ]);
  });

  it("groups rule-derived topics independently of the leading action", () => {
    const result = proposals([
      user("Always deploy production releases."),
      user("Always verify production releases before publishing them."),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.skillName).toBe("production-releases");
    expect(result[0]?.content).toContain("Deploy production releases");
    expect(result[0]?.content).toContain("Verify production releases before publishing them");
  });

  it.each(["run 7", "run 42", "run x7k9m2q8"])(
    "strips a transient %s identifier from the task class",
    (run) => {
      const proposal = expectDefined(
        proposals([user(`When handling ${run} results, always record the summary.`)])[0],
        "run result",
      );
      expect(proposal.skillName).toBe("run-results");
    },
  );

  it("falls back to a derived task class when no existing skill matches", () => {
    const result = proposals(
      [user("Remember to always optimize screenshot assets before attaching them.")],
      [{ name: "signal-scout", description: "Mine market signals before drafting." }],
    );
    expect(result[0]).toMatchObject({
      skillName: "screenshot-assets",
      description: "Screenshot Assets: Optimize screenshot assets before attaching them.",
      existingSkill: false,
    });
  });

  it("keeps recent task groups under the proposal cap", () => {
    const instructions = extractDurableInstructions([
      user("From now on, when working on GitHub PRs, always check CI before replying."),
      user("Remember to always optimize screenshot assets before attaching them."),
      user("Going forward, always write a QA scenario before testing this workflow."),
      user("Next time, always verify animated GIF output before replying."),
    ]);
    const result = groupDurableInstructionProposals({ instructions, maxProposals: 2 });
    expect(result.map((proposal) => proposal.skillName)).toEqual([
      "qa-scenario",
      "animated-gif-output",
    ]);
  });

  it("ranks a repeated task class by its latest correction", () => {
    const instructions = extractDurableInstructions([
      user("From now on, when working on GitHub PRs, always check CI before replying."),
      user("Remember to always optimize screenshot assets before attaching them."),
      user("Going forward, always write a QA scenario before testing this workflow."),
      user("Next time on a GitHub PR, make sure to link the issue in the description."),
    ]);
    const result = groupDurableInstructionProposals({ instructions, maxProposals: 2 });
    expect(result.map((proposal) => proposal.skillName)).toEqual(["qa-scenario", "github"]);
    expect(result[1]?.content).toContain("Check CI before replying");
    expect(result[1]?.content).toContain("Link the issue in the description");
  });

  it("trims a long description from the captured rule instead of using generic filler", () => {
    const detail = Array.from({ length: 30 }, (_, index) => `detail${index}`).join(" ");
    const proposal = expectDefined(
      proposals([user(`From now on, always verify invoice exports include ${detail}.`)])[0],
      "long description",
    );
    expect(Buffer.byteLength(proposal.description, "utf8")).toBeLessThanOrEqual(160);
    expect(proposal.description).toContain("Verify invoice exports");
    expect(proposal.description).not.toContain("captured instructions");
  });

  it("isolates a marker after a conjunction", () => {
    const proposal = expectDefined(
      proposals([user("I use CSV today, but from now on, use JSON output.")])[0],
      "conjunction marker",
    );
    expect(proposal.content).toContain("- Use JSON output.");
  });

  it("keeps an also-prefixed follow-up directive", () => {
    const result = proposals([user("From now on, use JSON. Also verify sources.")]);
    expect(result.some((proposal) => proposal.content.includes("Verify sources"))).toBe(true);
  });

  it("accepts punctuation after a postfix marker", () => {
    const proposal = expectDefined(
      proposals([user("Use JSON from now on, when exporting reports.")])[0],
      "punctuated postfix",
    );
    expect(proposal.skillName).toBe("exporting-reports");
    expect(proposal.content).toContain("- Use JSON.");
  });

  it("splits a lowercase command follow-up", () => {
    const result = proposals([user("From now on, use JSON. git fetch before rebasing.")]);
    expect(result.some((proposal) => proposal.content.includes("git fetch before rebasing"))).toBe(
      true,
    );
  });

  it.each(["Policy: always use ISO dates.", "Make it a rule to always check CI before replying."])(
    "parses an explicit policy wrapper: %s",
    (content) => {
      expect(proposals([user(content)])).toHaveLength(1);
    },
  );

  it("handles a team-scoped stop wrapper", () => {
    const proposal = expectDefined(
      proposals([user("We need to stop building scorecards before evidence is captured.")])[0],
      "team stop",
    );
    expect(proposal.content).toContain("- Stop building scorecards before evidence is captured.");
  });

  it("strips a standalone incident identifier", () => {
    const proposal = expectDefined(
      proposals([user("From now on, when handling INC-1234, always verify the checksum.")])[0],
      "incident identifier",
    );
    expect(proposal.skillName).toBe("checksum");
    expect(proposal.skillName).not.toContain("1234");
  });

  it("retains the full supported action vocabulary", () => {
    const followUps = proposals([user("From now on, use JSON. Generate a checksum.")]);
    expect(followUps.some((proposal) => proposal.content.includes("Generate a checksum"))).toBe(
      true,
    );
    const replacement = expectDefined(
      proposals([user("You're still using CSV; format it as JSON.")])[0],
      "format correction",
    );
    expect(replacement.content).toContain("- Format it as JSON.");
  });

  it("rejects a declarative clause inside a scoped marker", () => {
    expect(
      proposals([user("From now on, when handling invoices, the report contains private data.")]),
    ).toHaveLength(0);
  });

  it("does not activate follow-up scope from a rejected habit", () => {
    expect(
      proposals([user("On Mondays, I always send a summary. Delete today's draft.")]),
    ).toHaveLength(0);
  });

  it("accepts a contracted progressive next-time event", () => {
    const proposal = expectDefined(
      proposals([
        user("Next time you're handling customer invoices, always record the due date."),
      ])[0],
      "progressive event",
    );
    expect(proposal.skillName).toBe("customer-invoices");
  });

  it.each([
    "From now on, verify A vs. B before publishing.",
    "From now on, send U.S. reports before publishing.",
  ])("protects an abbreviation while splitting: %s", (content) => {
    expect(proposals([user(content)])[0]?.content.toLowerCase()).toContain(
      content.split(", ")[1]?.toLowerCase(),
    );
  });

  it("keeps a period-separated still correction with its following fix", () => {
    const proposal = expectDefined(
      proposals([
        user("You're still using transcripts as tone references. Use recordings instead."),
      ])[0],
      "period correction",
    );
    expect(proposal.content).toContain("- Use recordings instead.");
  });

  it("parses a passive postfix event as task scope", () => {
    const proposal = expectDefined(
      proposals([user("Use JSON next time reports are generated.")])[0],
      "passive postfix",
    );
    expect(proposal.skillName).toBe("reports-generated");
    expect(proposal.content).toContain("- Use JSON.");
  });

  it("uses the shared action vocabulary for next-time actor events", () => {
    const proposal = expectDefined(
      proposals([user("Next time you send reports, always encrypt attachments.")])[0],
      "send event",
    );
    expect(proposal.skillName).toBe("reports");
    expect(proposal.content).toContain("- Encrypt attachments.");
  });

  it("unwraps a polite marker request", () => {
    const proposal = expectDefined(
      proposals([user("Could you make sure to check CI before replying.")])[0],
      "polite marker",
    );
    expect(proposal.content).toContain("- Check CI before replying.");
  });

  it("parses every coordinated postfix directive", () => {
    const proposal = expectDefined(
      proposals([
        user("Use JSON from now on when exporting reports, and verify sources, and sign output."),
      ])[0],
      "coordinated postfix",
    );
    expect(proposal.skillName).toBe("exporting-reports");
    expect(proposal.content).toContain("- Verify sources.");
    expect(proposal.content).toContain("- Sign output.");
  });

  it("keeps action words that belong to explicit task classes", () => {
    const result = proposals([user("When handling testing workflow, always record the seed.")]);
    expect(result[0]?.skillName).toBe("testing-workflow");
  });

  it.each(["sent", "written"])("parses an irregular passive postfix event: %s", (participle) => {
    const proposal = expectDefined(
      proposals([user(`Use JSON next time the report is ${participle}.`)])[0],
      "irregular passive",
    );
    expect(proposal.skillName).toBe(`report-is-${participle}`);
    expect(proposal.content).toContain("- Use JSON.");
  });

  it("does not treat next time inside a polite question as durable", () => {
    expect(proposals([user("Can you check the next time the job runs?")])).toHaveLength(0);
  });

  it("preserves a comma-bearing next-time actor scope", () => {
    const proposal = expectDefined(
      proposals([
        user("Next time you process transcripts, recordings, and notes, always sanitize metadata."),
      ])[0],
      "comma actor scope",
    );
    expect(proposal.skillName).toBe("transcripts-recordings-notes");
    expect(proposal.content).toContain("- Sanitize metadata.");
  });

  it("rejects a bare noun fragment inside a scoped instruction", () => {
    expect(proposals([user("From now on, when handling invoices, private notes.")])).toHaveLength(
      0,
    );
  });

  it("accepts shared actions after comma-separated repetition complaints", () => {
    const proposal = expectDefined(
      proposals([user("I don't want to repeat myself, export JSON.")])[0],
      "export correction",
    );
    expect(proposal.content).toContain("- Export JSON.");
  });

  it("omits pronoun subjects from negative modal scope", () => {
    const proposal = expectDefined(
      proposals([user("From now on, you should not publish drafts.")])[0],
      "negative modal",
    );
    expect(proposal.content).toContain("- Do not publish drafts.");
    expect(proposal.content).not.toContain("For you");
  });

  it("excludes generated helper verbs from fallback topics", () => {
    const proposal = expectDefined(
      proposals([user("From now on, no sending customer data to third parties.")])[0],
      "negative shorthand",
    );
    expect(proposal.skillName).toBe("customer-data-third-parties");
  });

  it("parses a while-introduced postfix scope", () => {
    const proposal = expectDefined(
      proposals([user("Use JSON from now on while exporting reports.")])[0],
      "while scope",
    );
    expect(proposal.skillName).toBe("exporting-reports");
    expect(proposal.content).toContain("- Use JSON.");
  });

  it("preserves a durable clause before a later marker", () => {
    const result = proposals([
      user("Always verify original sources; from now on, use JSON output."),
    ]);
    expect(result.some((proposal) => proposal.content.includes("Verify original sources"))).toBe(
      true,
    );
    expect(result.some((proposal) => proposal.content.includes("Use JSON output"))).toBe(true);
  });

  it("preserves a directive before a terminal postfix marker", () => {
    const proposal = expectDefined(
      proposals([user("Use JSON output, from now on.")])[0],
      "terminal postfix",
    );
    expect(proposal.content).toContain("- Use JSON output.");
  });

  it("recognizes a terminal next-time directive", () => {
    const proposal = expectDefined(
      proposals([user("Use JSON output for reports next time.")])[0],
      "terminal next time",
    );
    expect(proposal.content).toContain("- Use JSON output for reports.");
  });

  it("normalizes a polite remember-to instruction", () => {
    const proposal = expectDefined(
      proposals([user("Please remember to check CI before replying.")])[0],
      "remember instruction",
    );
    expect(proposal.content).toContain("- Check CI before replying.");
  });

  it("keeps a negative replacement after still using", () => {
    const proposal = expectDefined(
      proposals([user("You're still using CSV; don't use it in reports.")])[0],
      "negative replacement",
    );
    expect(proposal.content).toContain("- Do not use it in reports.");
  });

  it("accepts an explicit generic shell command", () => {
    const proposal = expectDefined(
      proposals([user("From now on, run find . -name '*.ts'.")])[0],
      "generic shell command",
    );
    expect(proposal.content).toContain("- Run find . -name '*.ts'.");
  });

  it("preserves action words inside explicit task classes", () => {
    const result = proposals([
      user("When handling write permissions, always verify the owner."),
      user("When handling read permissions, always verify the owner."),
    ]);
    expect(result.map((proposal) => proposal.skillName)).toEqual([
      "write-permissions",
      "read-permissions",
    ]);
  });

  it.each(["I need you to stop publishing drafts.", "Please stop using transcripts."])(
    "restores a wrapped stop correction: %s",
    (content) => {
      expect(proposals([user(content)])).toHaveLength(1);
    },
  );

  it("accepts a postfix continuation without a comma", () => {
    const proposal = expectDefined(
      proposals([user("Use JSON from now on and verify sources.")])[0],
      "postfix continuation",
    );
    expect(proposal.content).toContain("- Use JSON.");
    expect(proposal.content).toContain("- Verify sources.");
  });

  it("keeps arbitrary command names in inferred topics", () => {
    const result = proposals([
      user("From now on, docker --version."),
      user("From now on, npm --version."),
    ]);
    expect(result.map((proposal) => proposal.skillName)).toEqual(["docker-version", "npm-version"]);
  });

  it.each(["build 1234", "execution x7k9m2q8"])("strips a transient %s identifier", (artifact) => {
    expect(
      proposals([user(`When processing ${artifact} results, always verify checksums.`)])[0]
        ?.skillName,
    ).not.toContain(artifact.split(" ")[1]);
  });

  it("does not duplicate punctuation in stop rules", () => {
    const proposal = expectDefined(
      proposals([user("Stop publishing unfinished drafts.")])[0],
      "stop punctuation",
    );
    expect(proposal.content).toContain("- Stop publishing unfinished drafts.");
    expect(proposal.content).not.toContain("drafts..");
  });

  it("keeps an active negative possession modal", () => {
    const proposal = expectDefined(
      proposals([user("From now on, reports should not have missing citations.")])[0],
      "negative possession",
    );
    expect(proposal.content).toContain("- Do not allow reports to have missing citations.");
  });

  it.each(["I told you to not publish drafts.", "I thought we would not publish drafts."])(
    "normalizes a raw not rule: %s",
    (content) => {
      expect(proposals([user(content)])[0]?.content).toContain("- Do not publish drafts.");
    },
  );

  it("retains a contraction-form direct prohibition", () => {
    const proposal = expectDefined(
      proposals([user("I told you don't publish drafts.")])[0],
      "contraction prohibition",
    );
    expect(proposal.content).toContain("- Do not publish drafts.");
  });

  it("groups progressive exporting with its direct actor-event scope", () => {
    const result = proposals([
      user("Next time you're exporting reports, always sign output."),
      user("Next time you export reports, always verify output."),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.skillName).toBe("reports");
  });

  it("recognizes a URL argument as command-shaped", () => {
    const proposal = expectDefined(
      proposals([user("From now on, curl https://api.example.com/health.")])[0],
      "URL command",
    );
    expect(proposal.content).toContain("- curl https://api.example.com/health.");
  });

  it("retains coordinated never constraints after a use rule", () => {
    const proposal = expectDefined(
      proposals([user("From now on, use Firefox, never Chrome.")])[0],
      "browser constraint",
    );
    expect(proposal.content).toContain("- Use Firefox.");
    expect(proposal.content).toContain("- Do not use Chrome.");
  });

  it("splits a lowercase action follow-up", () => {
    const result = proposals([user("From now on, use JSON. verify sources.")]);
    expect(result.some((proposal) => proposal.content.includes("Verify sources"))).toBe(true);
  });

  it("does not add a pronoun-only scope during fuzzy routing", () => {
    const result = proposals(
      [user("You should always check CI before replying.")],
      [{ name: "pull-request", description: "Check CI before landing pull requests." }],
    );
    expect(result[0]?.content).toContain("- Check CI before replying.");
    expect(result[0]?.content).not.toContain("For You");
  });

  it("preserves a durable clause before an em-dash marker", () => {
    const result = proposals([
      user("Always verify original sources — from now on, use JSON output."),
    ]);
    expect(result.some((proposal) => proposal.content.includes("Verify original sources"))).toBe(
      true,
    );
    expect(result.some((proposal) => proposal.content.includes("Use JSON output"))).toBe(true);
  });

  it("rejects an arbitrary noun phrase ending in output", () => {
    expect(proposals([user("From now on, private data output.")])).toHaveLength(0);
  });

  it("preserves case-sensitive modal task classes", () => {
    const proposal = expectDefined(
      proposals([user("From now on, GitHub PRs should not merge failed CI.")])[0],
      "case-sensitive modal",
    );
    expect(proposal.content).toContain("- For GitHub PRs: Do not merge failed CI.");
  });

  it("normalizes working-with task scopes", () => {
    const result = proposals([
      user("When working with customer invoices, always record the due date."),
      user("When handling customer invoices, always verify the total."),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.skillName).toBe("customer-invoices");
  });

  it("filters supported action gerunds from fallback topics", () => {
    const proposal = expectDefined(
      proposals([user("From now on, no uploading customer data to third parties.")])[0],
      "uploading shorthand",
    );
    expect(proposal.skillName).toBe("customer-data-third-parties");
  });

  it("splits an arbitrary lowercase command follow-up", () => {
    const result = proposals([user("From now on, use JSON. docker --version.")]);
    expect(result.some((proposal) => proposal.content.includes("docker --version"))).toBe(true);
    expect(result.some((proposal) => proposal.content.includes("Use JSON"))).toBe(true);
  });

  it("accepts punctuation after a leading next-time marker", () => {
    const proposal = expectDefined(
      proposals([user("Next time, you export reports, use JSON.")])[0],
      "punctuated next time",
    );
    expect(proposal.skillName).toBe("reports");
    expect(proposal.content).toContain("- Use JSON.");
  });

  it("preserves stable digit-bearing build targets", () => {
    const result = proposals([
      user("When processing build windows10 artifacts, always verify checksums."),
      user("When processing build windows11 artifacts, always verify signatures."),
    ]);
    expect(result.map((proposal) => proposal.skillName)).toEqual([
      "build-windows10-artifacts",
      "build-windows11-artifacts",
    ]);
  });

  it.each(["I should always read incident reports.", "I must always verify my sources."])(
    "rejects a first-person modal habit: %s",
    (content) => {
      expect(proposals([user(content)])).toHaveLength(0);
    },
  );

  it("strips a seven-character transient hash", () => {
    const proposal = expectDefined(
      proposals([user("When processing run abc1234 results, always verify checksums.")])[0],
      "short run hash",
    );
    expect(proposal.skillName).toBe("run-results");
  });

  it("keeps a collective always policy", () => {
    const proposal = expectDefined(
      proposals([user("From now on, we should always verify sources.")])[0],
      "collective policy",
    );
    expect(proposal.skillName).toBe("sources");
  });

  it("keeps a period-separated still correction attached to its scope", () => {
    const proposal = expectDefined(
      proposals([
        user("You're still using transcripts as tone references. Use recordings instead."),
      ])[0],
      "scoped still correction",
    );
    expect(proposal.evidence).toContain("transcripts as tone references");
    expect(proposal.content).toContain("- Use recordings instead.");
  });

  it("preserves task scope for an unmarked follow-up directive", () => {
    const result = proposals([
      user("From now on, when handling invoices, record due dates. Verify the total."),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.skillName).toBe("invoices");
    expect(result[0]?.content).toContain("- Verify the total.");
  });

  it("recognizes a marker after a colon-prefixed preface", () => {
    expect(proposals([user("Reminder: from now on, always use JSON.")])[0]?.content).toContain(
      "- Use JSON.",
    );
  });

  it.each([
    "From now on, please check CI before replying?",
    "When handling invoices, please record the due date?",
  ])("accepts a polite directive question: %s", (content) => {
    expect(proposals([user(content)])).toHaveLength(1);
  });

  it("falls back to a topic inside a temporal qualifier", () => {
    expect(
      proposals([user("From now on, always verify before publishing reports.")])[0]?.skillName,
    ).toBe("reports");
  });

  it("keeps a durable follow-up separate from an unparseable status complaint", () => {
    expect(
      proposals([user("The report is still using CSV. Always use JSON output for reports.")])[0]
        ?.content,
    ).toContain("- Use JSON output for reports.");
  });

  it("accepts a negative directive in a leading actor event", () => {
    const proposal = proposals([user("Next time you handle invoices, don't publish drafts.")])[0];
    expect(proposal?.skillName).toBe("invoices");
    expect(proposal?.content).toContain("- Do not publish drafts.");
  });

  it("parses a non-passive postfix event as task scope", () => {
    const proposal = proposals([user("Use JSON next time the report runs.")])[0];
    expect(proposal?.skillName).toBe("report-runs");
    expect(proposal?.content).toContain("- Use JSON.");
  });

  it("preserves next time as the object of an already-durable rule", () => {
    expect(proposals([user("Always record the next time the job runs.")])[0]?.content).toContain(
      "- Record the next time the job runs.",
    );
  });

  it("does not activate scope from a subject-led status report", () => {
    expect(
      proposals([user("The report is still using CSV. Archive the old report.")]),
    ).toHaveLength(0);
  });

  it("preserves semantic qualifiers in explicit task classes", () => {
    expect(
      proposals([user("When handling final reports, always sign output.")])[0]?.skillName,
    ).toBe("final-reports");
  });

  it("bounds unmarked follow-up instructions", () => {
    const oversized = "x".repeat(1300);
    const result = proposals([user(`From now on, use JSON. Write ${oversized}.`)]);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).not.toContain(oversized);
  });

  it.each([
    ["I told you to compress screenshots before attaching them.", "Compress screenshots"],
    ["I thought we agreed to watermark every image.", "Watermark every image"],
  ])("keeps an explicit correction with an unlisted verb: %s", (content, expected) => {
    expect(proposals([user(content)])[0]?.content).toContain(expected);
  });

  it("groups explicit corrections independently of an unlisted leading verb", () => {
    const result = proposals([
      user("I told you to compress image files before attaching them."),
      user("That's not what I asked—watermark every image file before sharing it."),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.skillName).toBe("image-files");
  });

  it("does not merge an independently scoped rule into a bare complaint", () => {
    const result = proposals([
      user("That's not what I asked. When handling invoices, always record due dates."),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.skillName).toBe("invoices");
    expect(result[0]?.content).toContain("- Record due dates.");
  });

  it("preserves a comma-bearing task scope before a negative directive", () => {
    const content =
      "From now on, when processing transcripts, recordings, and notes, don't publish drafts.";
    const proposal = proposals([user(content)])[0];
    expect(proposal?.skillName).toBe("transcripts-recordings-notes");
  });

  it("preserves object-level next time inside a leading marked directive", () => {
    expect(
      proposals([user("From now on, always record the next time the job runs.")])[0]?.content,
    ).toContain("- Record the next time the job runs.");
  });

  it("keeps whitelisted executable names in command topics", () => {
    const names = proposals([user("From now on, git fetch."), user("From now on, gh fetch.")]).map(
      (proposal) => proposal.skillName,
    );
    expect(names).toEqual(["git-fetch", "gh-fetch"]);
  });

  it("parses a prefixed marker actor event", () => {
    const proposal = proposals([
      user("Reminder: from now on, you handle invoices, always record due dates."),
    ])[0];
    expect(proposal?.skillName).toBe("invoices");
    expect(proposal?.content).toContain("- Record due dates.");
  });

  it("allows stop rules through nested normalization", () => {
    const proposal = proposals([user("Reports must always stop publishing unfinished drafts.")])[0];
    expect(proposal?.skillName).toBe("reports");
    expect(proposal?.content).toContain("- Stop publishing unfinished drafts.");
  });

  it.each([
    ["always verify sources.", "verify sources."],
    ["never publish drafts.", "do not publish drafts."],
    ["please check CI.", "check ci."],
  ])("splits a lowercase directive follow-up: %s", (followUp, expected) => {
    const result = proposals([user(`From now on, use JSON. ${followUp}`)]);
    expect(result.some((proposal) => proposal.content.toLowerCase().includes(expected))).toBe(true);
  });

  it.each([
    ["Always write a QA scenario.", "QA Scenario"],
    ["Always use ISO output.", "ISO Output"],
    ["Always check URL redirects.", "URL Redirects"],
  ])("preserves initialism casing for %s", (content, title) => {
    expect(proposals([user(content)])[0]?.description).toContain(title);
  });

  it("ignores assistant transcript entries", () => {
    expect(
      proposals([{ role: "assistant", content: "From now on, always check CI before replying." }]),
    ).toHaveLength(0);
  });
});
