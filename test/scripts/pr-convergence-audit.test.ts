import { describe, expect, it } from "vitest";
import {
  CONVERGENCE_DECISIONS,
  EVIDENCE_SURFACES,
  auditPrConvergence,
  decidePrConvergence,
  extractFindingsFromEvidenceItem,
  normalizeIssueComment,
} from "../../scripts/pr-convergence-audit.mjs";

const repo = "openclaw/openclaw";
const pr = 113641;
const headSha = "aabbccddaabbccddaabbccddaabbccddaabbccdd";
const staleSha = "1111111111111111111111111111111111111111";
const prUrl = `https://github.com/${repo}/pull/${pr}`;

type ProviderOptions = {
  formalReviews?: Record<string, unknown>[];
  inlineReviewComments?: Record<string, unknown>[];
  issueComments?: Record<string, unknown>[];
  requestedReviewers?: string[];
  checkRuns?: Record<string, unknown>[];
  requiredCheckPolicy?: "resolved" | "unknown";
  completeness?: Partial<Record<string, boolean>>;
  headShaInitial?: string;
  headShaFinal?: string;
};

function successfulCheck(name: string, id: number) {
  return {
    id: String(id),
    name,
    status: "completed",
    conclusion: "success",
    headSha,
    url: `https://github.com/${repo}/actions/runs/${id}`,
    required: true,
  };
}

function clawsweeperComment(params: { id: number; body: string; createdAt?: string }) {
  return {
    id: params.id,
    html_url: `${prUrl}#issuecomment-${params.id}`,
    created_at: params.createdAt ?? "2026-07-26T09:00:00Z",
    user: {
      login: "clawsweeper[bot]",
      type: "Bot",
    },
    performed_via_github_app: {
      slug: "clawsweeper",
    },
    body: params.body,
  };
}

function createProvider(options: ProviderOptions = {}) {
  const initialHead = options.headShaInitial ?? headSha;
  const finalHead = options.headShaFinal ?? initialHead;
  let pullReads = 0;
  const completeness = {
    formal_reviews: true,
    inline_review_comments: true,
    issue_comments: true,
    requested_reviewers: true,
    check_runs: true,
    ...options.completeness,
  };

  return {
    provider: {
      async fetchPullRequest() {
        pullReads += 1;
        return {
          number: pr,
          html_url: prUrl,
          head: {
            sha: pullReads === 1 ? initialHead : finalHead,
            ref: "codex/pr-convergence-audit",
          },
        };
      },
      async fetchFormalReviews() {
        return {
          items: options.formalReviews ?? [],
          complete: completeness.formal_reviews,
        };
      },
      async fetchInlineReviewComments() {
        return {
          items: options.inlineReviewComments ?? [],
          complete: completeness.inline_review_comments,
        };
      },
      async fetchIssueComments() {
        return {
          items: options.issueComments ?? [],
          complete: completeness.issue_comments,
        };
      },
      async fetchRequestedReviewers() {
        return {
          logins: options.requestedReviewers ?? [],
          complete: completeness.requested_reviewers,
        };
      },
      async fetchCheckRuns() {
        return {
          items: options.checkRuns ?? [
            successfulCheck("CI", 1),
            successfulCheck("Workflow Sanity", 2),
          ],
          complete: completeness.check_runs,
          requiredPolicy: options.requiredCheckPolicy ?? "resolved",
        };
      },
    },
    getPullReads: () => pullReads,
  };
}

describe("pr-convergence-audit", () => {
  it("detects BLOCKED from an exact-head ClawSweeper issue comment when formal reviews are empty", async () => {
    const blockerBody = [
      "## ClawSweeper review",
      "",
      "P0: Missing focused regression proof for the changed gateway path.",
      "",
      "BLOCKED until the proof gap is closed.",
      `<!-- clawsweeper-verdict:block item=${pr} sha=${headSha} confidence=high -->`,
    ].join("\n");
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        clawsweeperComment({
          id: 9001,
          body: blockerBody,
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.BLOCKED);
    expect(result.headSha).toBe(headSha);
    expect(result.prUrl).toBe(prUrl);
    expect(result.evidence.formalReviews).toEqual([]);
    expect(result.evidence.issueComments).toHaveLength(1);
    expect(result.evidence.issueComments[0]?.surface).toBe(EVIDENCE_SURFACES.ISSUE_COMMENT);
    expect(result.evidence.issueComments[0]?.reviewedSha).toBe(headSha);
    expect(result.findingCounts.p0).toBe(1);
    expect(result.findingCounts.blocked).toBe(1);
    expect(result.findings.some((finding) => finding.currentHead && finding.blocking)).toBe(true);
    expect(result.findings[0]?.sourceUrl).toBe(`${prUrl}#issuecomment-9001`);
    expect(result.nextAction).toContain("blocking findings");
  });

  it("returns UNKNOWN for a stale-head ClawSweeper blocker instead of silently dismissing it", async () => {
    const blockerBody = [
      "P1: Proof is stale for the previous head.",
      `<!-- clawsweeper-verdict:block item=${pr} sha=${staleSha} confidence=high -->`,
    ].join("\n");
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        clawsweeperComment({
          id: 9002,
          body: blockerBody,
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.headSha).toBe(headSha);
    expect(result.findings.some((finding) => finding.blocking && !finding.currentHead)).toBe(true);
    expect(result.reason).toContain("Stale blocking review evidence");
    expect(result.nextAction).toMatch(/re-review/i);
  });

  it("ignores clean non-review contributor comments", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9100,
          html_url: `${prUrl}#issuecomment-9100`,
          created_at: "2026-07-26T08:00:00Z",
          user: { login: "contributor", type: "User" },
          body: "Thanks for the quick review!",
        },
        clawsweeperComment({
          id: 9101,
          body: passBody,
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.findingCounts).toEqual({});
    expect(result.evidence.issueComments).toHaveLength(2);
    expect(result.reason).toContain("no unresolved blockers");
  });

  it("returns UNKNOWN when target-branch required-check policy is unavailable", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9150, body: passBody })],
      requiredCheckPolicy: "unknown",
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toMatch(/target branch protection or ruleset policy/i);
    expect(result.nextAction).toMatch(/Resolve required checks/i);
  });

  it("returns UNKNOWN when a check run omits authoritative requiredness", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9160, body: passBody })],
      checkRuns: [
        {
          id: 1,
          name: "CI",
          status: "completed",
          conclusion: "success",
          head_sha: headSha,
          html_url: `${prUrl}/actions/runs/1`,
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toMatch(/ambiguous/i);
    expect(result.evidence.checkRuns[0]?.required).toBeNull();
  });

  it("returns BLOCKED when required checks failed on the exact head", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9200, body: passBody })],
      checkRuns: [
        successfulCheck("CI", 1),
        {
          id: 2,
          name: "Workflow Sanity",
          status: "completed",
          conclusion: "failure",
          head_sha: headSha,
          html_url: `https://github.com/${repo}/actions/runs/2`,
          required: true,
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.BLOCKED);
    expect(result.reason).toContain("Required checks failed");
    expect(result.evidence.checkRuns).toHaveLength(2);
    expect(result.evidence.checkRuns[1]?.conclusion).toBe("failure");
  });

  it("returns UNKNOWN when required checks are still pending", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9300, body: passBody })],
      checkRuns: [
        {
          id: 3,
          name: "CI",
          status: "in_progress",
          conclusion: null,
          head_sha: headSha,
          html_url: `https://github.com/${repo}/actions/runs/3`,
          required: true,
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("pending");
    expect(result.nextAction).toContain("required checks");
  });

  it("fails closed to UNKNOWN when evidence pagination is incomplete", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9400, body: passBody })],
      completeness: {
        issue_comments: false,
      },
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("incomplete");
    expect(result.evidence.surfaceCoverage.issue_comments).toEqual({
      complete: false,
      count: 1,
    });
    expect(result.nextAction).toContain("Paginate");
  });

  it("returns UNKNOWN when the PR head changes during the audit", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const movedHead = "bbbbccccddddeeeeffffaaaabbbbccccddddeeee";
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9500, body: passBody })],
      headShaInitial: headSha,
      headShaFinal: movedHead,
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("head changed");
    expect(result.nextAction).toContain("stabilizes");
  });

  it("never yields READY from formal review state alone", () => {
    const evidence = {
      repo,
      pr,
      headSha,
      headRef: "branch",
      prUrl,
      formalReviews: [
        {
          id: "1",
          surface: EVIDENCE_SURFACES.FORMAL_REVIEW,
          url: `${prUrl}#pullrequestreview-1`,
          author: "maintainer",
          createdAt: "2026-07-26T09:00:00Z",
          body: "Looks good.",
          reviewState: "APPROVED",
          reviewedSha: headSha,
          commitId: headSha,
        },
      ],
      inlineReviewComments: [],
      issueComments: [],
      requestedReviewers: [],
      checkRuns: [successfulCheck("CI", 1)],
      requiredCheckPolicy: "resolved",
      surfaceCoverage: {
        formal_reviews: { complete: true, count: 1 },
        inline_review_comments: { complete: true, count: 0 },
        issue_comments: { complete: true, count: 0 },
        requested_reviewers: { complete: true, count: 0 },
        check_runs: { complete: true, count: 1 },
      },
      errors: [],
    };

    const decision = decidePrConvergence({
      evidence,
      findings: [],
      headStable: true,
      hasExactHeadClawSweeperPass: false,
    });

    expect(decision.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(decision.reason).toContain("Formal review state alone");
  });

  it("returns UNKNOWN when a provider fetch throws instead of propagating the exception", async () => {
    const provider = {
      async fetchPullRequest() {
        throw new Error("GitHub API rate limit exceeded");
      },
      async fetchFormalReviews() {
        return { items: [], complete: true };
      },
      async fetchInlineReviewComments() {
        return { items: [], complete: true };
      },
      async fetchIssueComments() {
        return { items: [], complete: true };
      },
      async fetchRequestedReviewers() {
        return { logins: [], complete: true };
      },
      async fetchCheckRuns() {
        return { items: [], complete: true };
      },
    };

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("Provider or API error");
    expect(result.reason).toContain("rate limit");
    expect(result.nextAction).toMatch(/re-run the convergence audit/i);
    expect(result.evidence.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("rate limit")]),
    );
  });

  it("returns UNKNOWN when actionable evidence lacks an exact reviewed SHA", async () => {
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9700,
          html_url: `${prUrl}#issuecomment-9700`,
          created_at: "2026-07-26T09:30:00Z",
          user: { login: "maintainer", type: "User" },
          body: "P0: Missing regression proof for the changed gateway path.",
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("missing an exact reviewed SHA");
    expect(
      result.findings.some((finding) => finding.kind === "p0" && finding.reviewedSha === null),
    ).toBe(true);
    expect(result.findings.every((finding) => !finding.currentHead)).toBe(true);
    expect(result.nextAction).toMatch(/marker SHAs/i);
  });

  it("returns UNKNOWN for an exact-head re-review request instead of READY", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        clawsweeperComment({
          id: 9800,
          body: passBody,
        }),
        {
          id: 9801,
          html_url: `${prUrl}#issuecomment-9801`,
          created_at: "2026-07-26T10:00:00Z",
          user: { login: "maintainer", type: "User" },
          body: [
            "Please take another look after the proof update.",
            "@clawsweeper re-review",
            `<!-- clawsweeper-verdict:note item=${pr} sha=${headSha} -->`,
          ].join("\n"),
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("exact-head re-review");
    expect(result.findingCounts.re_review_request).toBe(1);
    expect(
      result.findings.some(
        (finding) => finding.kind === "re_review_request" && finding.currentHead,
      ),
    ).toBe(true);
    expect(result.nextAction).toMatch(/fresh exact-head/i);
  });

  it("returns UNKNOWN for a stale re-review request instead of silently ignoring it", async () => {
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9900,
          html_url: `${prUrl}#issuecomment-9900`,
          created_at: "2026-07-26T10:05:00Z",
          user: { login: "maintainer", type: "User" },
          body: [
            "@clawsweeper re-review",
            `<!-- clawsweeper-verdict:note item=${pr} sha=${staleSha} -->`,
          ].join("\n"),
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("Stale re-review requests");
    expect(result.findingCounts.re_review_request).toBe(1);
    expect(result.nextAction).toMatch(/fresh exact-head ClawSweeper re-review/i);
  });

  it("normalizes issue comment URLs and reviewed SHAs from ClawSweeper markers", () => {
    const normalized = normalizeIssueComment(
      clawsweeperComment({
        id: 9600,
        body: `<!-- clawsweeper-verdict:block item=${pr} sha=${headSha} -->`,
      }),
      repo,
      pr,
    );

    expect(normalized.url).toBe(`${prUrl}#issuecomment-9600`);
    expect(normalized.reviewedSha).toBe(headSha);
    expect(
      extractFindingsFromEvidenceItem(
        {
          ...normalized,
          performed_via_github_app: { slug: "clawsweeper" },
          user: { login: "clawsweeper[bot]", type: "Bot" },
        },
        headSha,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "clawsweeper_verdict_block",
          currentHead: true,
          sourceSurface: EVIDENCE_SURFACES.ISSUE_COMMENT,
        }),
      ]),
    );
  });
});
