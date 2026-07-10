import { describe, expect, it } from "vitest";
import {
  contributionRecordFor,
  ledgerChecks,
  ledgerFor,
  renderContributionRecordEntry,
} from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";

describe("renderContributionRecordEntry", () => {
  it("keeps source and linked issue references without repeating PR titles", () => {
    expect(
      renderContributionRecordEntry({
        number: 123,
        title: "Fix local openclaw/openclaw#45 and openclaw/imsg#141",
        linkedIssues: [{ number: 45 }, { number: 67 }],
        thanks: ["alice", "bob"],
      }),
    ).toBe("- **PR #123** Related #45, openclaw/imsg#141, #67. Thanks @alice and @bob.");
  });

  it("deduplicates title references and retains seeded cross-repository references", () => {
    expect(
      renderContributionRecordEntry({
        number: 124,
        title: "Fix #45, #45, and OpenClaw/imsg#141",
        externalReferences: ["openclaw/imsg#141"],
        priorReferences: [67],
        linkedIssues: [{ number: 45 }],
        thanks: [],
      }),
    ).toBe("- **PR #124** Related #45, OpenClaw/imsg#141, #67.");
  });

  it("renders every source PR even without issue references or credits", () => {
    expect(
      renderContributionRecordEntry({
        number: 456,
        title: "Internal cleanup",
        linkedIssues: [],
        thanks: [],
      }),
    ).toBe("- **PR #456**");
  });

  it("retains references and credits when a compact record is seeded again", () => {
    const line = "- **PR #125** Related #45, openclaw/imsg#141. Thanks @alice and @bob.";
    const record = contributionRecordFor({
      source: [
        "## 2026.7.1",
        "",
        "### Complete contribution record",
        "",
        "#### Pull requests",
        "",
        line,
      ].join("\n"),
    });
    const seeded = record.pullRequests.get(125);

    expect(seeded).toEqual({
      externalReferences: ["openclaw/imsg#141"],
      references: [45],
      thanks: ["alice", "bob"],
    });
    expect(
      renderContributionRecordEntry({
        number: 125,
        title: "Title changed after release",
        priorReferences: seeded?.references,
        externalReferences: seeded?.externalReferences,
        linkedIssues: [],
        thanks: seeded?.thanks ?? [],
      }),
    ).toBe(line);
  });

  it("retains seeded credits when the production ledger is rebuilt", () => {
    const priorRecord = contributionRecordFor({
      source: [
        "## 2026.7.1",
        "",
        "### Complete contribution record",
        "",
        "#### Pull requests",
        "",
        "- **PR #125** Thanks @alice and @bob.",
      ].join("\n"),
    });
    const nodes = new Map([
      [
        125,
        {
          __typename: "PullRequest",
          author: { __typename: "User", login: "carol" },
          closingIssuesReferences: { nodes: [] },
          mergedAt: "2026-07-08T00:00:00Z",
          title: "fix: keep release credits",
        },
      ],
    ]);

    const result = ledgerFor(
      "v2026.6.11",
      "HEAD",
      [125],
      nodes,
      new Map(),
      new Map(),
      { issuesByPullRequest: new Map() },
      priorRecord,
      new Set([125]),
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      [],
      Date.parse("2026-07-09T00:00:00Z"),
    );

    expect(result.ledger).toContain("- **PR #125** Thanks @carol and @alice and @bob.");
  });

  it("retains references from a verbose record when the source title changes", () => {
    const record = contributionRecordFor({
      source: [
        "## 2026.7.1",
        "",
        "### Complete contribution record",
        "",
        "#### Pull requests",
        "",
        "- **PR #126** Fix #46 and openclaw/imsg#142. Related #68. Thanks @alice.",
      ].join("\n"),
    });
    const seeded = record.pullRequests.get(126);

    expect(seeded).toEqual({
      externalReferences: ["openclaw/imsg#142"],
      references: [46, 68],
      thanks: ["alice"],
    });
  });

  it("requires complete reference tokens rather than matching substrings", () => {
    const source = [
      "## 2026.7.1",
      "",
      "### Highlights",
      "",
      "- Highlight one.",
      "- Highlight two.",
      "- Highlight three.",
      "- Highlight four.",
      "- Highlight five.",
      "",
      "### Changes",
      "",
      "### Fixes",
      "",
      "### Complete contribution record",
      "",
      "#### Pull requests",
      "",
      "- **PR #456** Related openclaw/imsg#141.",
    ].join("\n");
    const entry = {
      number: 456,
      title: "Internal cleanup",
      editorialEligible: false,
      priorReferences: [45, 141],
      externalReferences: [],
      linkedIssues: [],
      thanks: [],
    };

    expect(
      ledgerChecks({ source }, [entry], new Map([[456, { __typename: "PullRequest" }]]), []),
    ).toEqual([
      "missing #45 on contribution record for PR #456",
      "missing #141 on contribution record for PR #456",
    ]);
  });

  it("accepts case-only differences in cross-repository references", () => {
    const line = "- **PR #127** Related OpenClaw/imsg#143.";
    const source = [
      "## 2026.7.1",
      "",
      "### Highlights",
      "",
      "- Highlight one.",
      "- Highlight two.",
      "- Highlight three.",
      "- Highlight four.",
      "- Highlight five.",
      "",
      "### Changes",
      "",
      "### Fixes",
      "",
      "### Complete contribution record",
      "",
      "#### Pull requests",
      "",
      line,
    ].join("\n");
    const entry = {
      number: 127,
      title: "Internal cleanup",
      editorialEligible: false,
      priorReferences: [],
      externalReferences: ["openclaw/imsg#143"],
      linkedIssues: [],
      thanks: [],
    };

    expect(
      ledgerChecks({ source }, [entry], new Map([[127, { __typename: "PullRequest" }]]), []),
    ).toEqual([]);
  });
});
