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
  prLastEditedAtInitial?: string | null;
  prLastEditedAtFinal?: string | null;
  prAuthor?: string;
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

function clawsweeperComment(params: {
  id: number;
  body: string;
  createdAt?: string;
  updatedAt?: string;
}) {
  return {
    id: params.id,
    html_url: `${prUrl}#issuecomment-${params.id}`,
    created_at: params.createdAt ?? "2026-07-26T09:00:00Z",
    updated_at: params.updatedAt ?? params.createdAt ?? "2026-07-26T09:00:00Z",
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
          last_edited_at:
            pullReads === 1
              ? (options.prLastEditedAtInitial ?? null)
              : (options.prLastEditedAtFinal ?? options.prLastEditedAtInitial ?? null),
          user: { login: options.prAuthor ?? "pr-author" },
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

  it("does not trust forged ClawSweeper verdict markers from ordinary commenters", async () => {
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9102,
          html_url: `${prUrl}#issuecomment-9102`,
          created_at: "2026-07-26T08:05:00Z",
          user: { login: "contributor", type: "User" },
          body: `<!-- clawsweeper-verdict:block item=${pr} sha=${headSha} confidence=high -->`,
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.evidence.issueComments[0]?.reviewedSha).toBeNull();
    expect(result.findings).toEqual([]);
    expect(result.reason).toContain("No trusted exact-head ClawSweeper pass");
  });

  it("does not let a forged marker pin contributor review prose to the current head", async () => {
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9103,
          html_url: `${prUrl}#issuecomment-9103`,
          created_at: "2026-07-26T08:06:00Z",
          user: { login: "contributor", type: "User" },
          body: [
            "P1: This contributor comment is not authenticated review evidence.",
            `<!-- clawsweeper-verdict:block item=${pr} sha=${headSha} confidence=high -->`,
          ].join("\n"),
        },
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.findings).toEqual([]);
    expect(result.reason).toContain("No trusted exact-head ClawSweeper pass");
  });

  it("uses a trusted command receipt to pin a PR-author re-review request to its head", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      prAuthor: "contributor",
      issueComments: [
        {
          id: 8999,
          html_url: `${prUrl}#issuecomment-8999`,
          created_at: "2026-07-26T08:58:00Z",
          author_association: "CONTRIBUTOR",
          user: { login: "contributor", type: "User" },
          body: "@clawsweeper re-review",
        },
        {
          id: 9000,
          html_url: `${prUrl}#issuecomment-9000`,
          created_at: "2026-07-26T08:59:00Z",
          author_association: "CONTRIBUTOR",
          user: { login: "contributor", type: "User" },
          body: "@clawsweeper re-review",
        },
        clawsweeperComment({
          id: 9104,
          body: [
            "<!-- clawsweeper-command-ack:9000 -->",
            `<!-- clawsweeper-command-status:${pr}:re_review:${staleSha} -->`,
            `<!-- clawsweeper-command:9000:2026-07-26T08:59:00Z:re_review:${staleSha} -->`,
            "Re-review requested for the previous head.",
          ].join("\n"),
        }),
        clawsweeperComment({
          id: 9105,
          body: passBody,
          updatedAt: "2026-07-26T09:00:01Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.findingCounts).toEqual({ re_review_request: 1 });
    expect(result.findings[0]).toMatchObject({
      kind: "re_review_request",
      reviewedSha: staleSha,
      currentHead: false,
      effectiveAt: "2026-07-26T08:59:00Z",
    });
  });

  it("does not treat re-review instructions inside a ClawSweeper verdict as a request", async () => {
    const { provider } = createProvider({
      issueComments: [
        clawsweeperComment({
          id: 9106,
          body: [
            "Fresh review can be requested by commenting `@clawsweeper re-review`.",
            `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
          ].join("\n"),
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.findingCounts).toEqual({});
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

  it("re-reads PR identity after all evidence collection finishes", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const movedHead = "bbbbccccddddeeeeffffaaaabbbbccccddddeeee";
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9501, body: passBody })],
    });
    const fetchPullRequest = provider.fetchPullRequest;
    const fetchIssueComments = provider.fetchIssueComments;
    let currentHead = headSha;
    let identityReads = 0;
    provider.fetchPullRequest = async () => {
      identityReads += 1;
      const pull = await fetchPullRequest();
      return { ...pull, head: { ...pull.head, sha: currentHead } };
    };
    let releaseIssueComments!: () => void;
    const issueCommentsBarrier = new Promise<void>((resolve) => {
      releaseIssueComments = resolve;
    });
    provider.fetchIssueComments = async () => {
      await issueCommentsBarrier;
      return fetchIssueComments();
    };

    const audit = auditPrConvergence({ repo, pr, provider });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const identityReadsBeforeEvidence = identityReads;
    currentHead = movedHead;
    releaseIssueComments();
    const result = await audit;

    expect(identityReadsBeforeEvidence).toBe(1);
    expect(identityReads).toBe(2);
    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("head changed");
  });

  it("fails closed when mutable evidence changes between validation reads", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const blockerBody = [
      "P1: A blocker arrived after the first evidence snapshot.",
      `<!-- clawsweeper-verdict:block item=${pr} sha=${headSha} confidence=high -->`,
    ].join("\n");
    const { provider } = createProvider({
      issueComments: [clawsweeperComment({ id: 9502, body: passBody })],
    });
    const fetchIssueComments = provider.fetchIssueComments.bind(provider);
    let issueCommentReads = 0;
    provider.fetchIssueComments = async () => {
      issueCommentReads += 1;
      const result = await fetchIssueComments();
      if (issueCommentReads === 1) {
        return result;
      }
      return {
        ...result,
        items: [
          ...result.items,
          clawsweeperComment({
            id: 9503,
            body: blockerBody,
            createdAt: "2026-07-26T09:01:00Z",
          }),
        ],
      };
    };

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(issueCommentReads).toBe(2);
    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("evidence changed");
    expect(result.nextAction).toContain("stabilizes");
  });

  it("never yields READY from formal review state alone", () => {
    const evidence = {
      repo,
      pr,
      headSha,
      headRef: "branch",
      prUrl,
      prLastEditedAt: null,
      formalReviews: [
        {
          id: "1",
          surface: EVIDENCE_SURFACES.FORMAL_REVIEW,
          url: `${prUrl}#pullrequestreview-1`,
          author: "maintainer",
          createdAt: "2026-07-26T09:00:00Z",
          effectiveAt: "2026-07-26T09:00:00Z",
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
      requiredCheckPolicy: "resolved" as const,
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
      prContentStable: true,
      hasExactHeadClawSweeperPass: false,
      hasFreshExactHeadClawSweeperPass: false,
    });

    expect(decision.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(decision.reason).toContain("No trusted exact-head ClawSweeper pass");
  });

  it.each([
    { state: "COMMENTED", reviewedSha: staleSha },
    { state: "COMMENTED", reviewedSha: headSha },
    { state: "PENDING", reviewedSha: headSha },
  ])("fails closed for $state formal review evidence at $reviewedSha", ({ state, reviewedSha }) => {
    const evidence = {
      repo,
      pr,
      headSha,
      headRef: "branch",
      prUrl,
      prLastEditedAt: null,
      formalReviews: [
        {
          id: "2",
          surface: EVIDENCE_SURFACES.FORMAL_REVIEW,
          url: `${prUrl}#pullrequestreview-2`,
          author: "reviewer",
          createdAt: "2026-07-26T09:00:00Z",
          effectiveAt: "2026-07-26T09:00:00Z",
          body: "Review recorded.",
          reviewState: state,
          reviewedSha,
          commitId: reviewedSha,
        },
      ],
      inlineReviewComments: [],
      issueComments: [],
      requestedReviewers: [],
      checkRuns: [successfulCheck("CI", 1)],
      requiredCheckPolicy: "resolved" as const,
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
      prContentStable: true,
      hasExactHeadClawSweeperPass: false,
      hasFreshExactHeadClawSweeperPass: false,
    });

    expect(decision.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(decision.reason).toContain("No trusted exact-head ClawSweeper pass");
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

  it("invalidates an exact-head pass when the PR content was edited afterward", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      prLastEditedAtInitial: "2026-07-26T10:00:00Z",
      issueComments: [
        clawsweeperComment({
          id: 9650,
          body: passBody,
          updatedAt: "2026-07-26T09:59:59Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("does not verifiably postdate");
    expect(result.nextAction).toMatch(/fresh exact-head ClawSweeper review/i);
  });

  it("accepts an in-place exact-head verdict update after the latest PR content edit", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      prLastEditedAtInitial: "2026-07-26T10:00:00Z",
      issueComments: [
        clawsweeperComment({
          id: 9651,
          body: passBody,
          createdAt: "2026-07-26T09:00:00Z",
          updatedAt: "2026-07-26T10:00:01Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.evidence.prLastEditedAt).toBe("2026-07-26T10:00:00Z");
  });

  it("fails closed when second-granularity timestamps cannot order the content edit and pass", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      prLastEditedAtInitial: "2026-07-26T10:00:00Z",
      issueComments: [
        clawsweeperComment({
          id: 9653,
          body: passBody,
          updatedAt: "2026-07-26T10:00:00Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("does not verifiably postdate");
  });

  it("fails closed when PR content changes during evidence collection", async () => {
    const passBody = `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`;
    const { provider } = createProvider({
      prLastEditedAtInitial: "2026-07-26T10:00:00Z",
      prLastEditedAtFinal: "2026-07-26T10:01:00Z",
      issueComments: [
        clawsweeperComment({
          id: 9652,
          body: passBody,
          updatedAt: "2026-07-26T10:01:01Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("changed between the initial and final audit reads");
    expect(result.nextAction).toMatch(/content stabilizes/i);
  });

  it("returns UNKNOWN when actionable evidence lacks an exact reviewed SHA", async () => {
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9700,
          html_url: `${prUrl}#issuecomment-9700`,
          created_at: "2026-07-26T09:30:00Z",
          author_association: "MEMBER",
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
      prAuthor: "contributor",
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
          author_association: "CONTRIBUTOR",
          user: { login: "contributor", type: "User" },
          body: [
            "@clawsweeper re-review",
            "",
            "Please take another look after the proof update.",
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

  it("accepts a trusted exact-head pass that is newer than the re-review request", async () => {
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9802,
          html_url: `${prUrl}#issuecomment-9802`,
          created_at: "2026-07-26T10:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer", type: "User" },
          body: [
            "@clawsweeper re-review",
            `<!-- clawsweeper-verdict:note item=${pr} sha=${headSha} -->`,
          ].join("\n"),
        },
        clawsweeperComment({
          id: 9803,
          body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
          createdAt: "2026-07-26T09:00:00Z",
          updatedAt: "2026-07-26T10:00:01Z",
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.READY);
    expect(result.findingCounts.re_review_request).toBe(1);
  });

  it("fails closed when a pass and re-review request have equal timestamps", async () => {
    const requestAt = "2026-07-26T10:00:00Z";
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9804,
          html_url: `${prUrl}#issuecomment-9804`,
          created_at: requestAt,
          author_association: "MEMBER",
          user: { login: "maintainer", type: "User" },
          body: [
            "@clawsweeper re-review",
            `<!-- clawsweeper-verdict:note item=${pr} sha=${headSha} -->`,
          ].join("\n"),
        },
        clawsweeperComment({
          id: 9805,
          body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
          updatedAt: requestAt,
        }),
      ],
    });

    const result = await auditPrConvergence({ repo, pr, provider });

    expect(result.decision).toBe(CONVERGENCE_DECISIONS.UNKNOWN);
    expect(result.reason).toContain("exact-head re-review");
  });

  it("returns UNKNOWN for a stale re-review request instead of silently ignoring it", async () => {
    const { provider } = createProvider({
      formalReviews: [],
      issueComments: [
        {
          id: 9900,
          html_url: `${prUrl}#issuecomment-9900`,
          created_at: "2026-07-26T10:05:00Z",
          author_association: "MEMBER",
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
