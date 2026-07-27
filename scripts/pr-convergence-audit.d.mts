export type ConvergenceDecision = "READY" | "BLOCKED" | "UNKNOWN";

export type EvidenceSurface =
  | "formal_review"
  | "inline_review_comment"
  | "issue_comment"
  | "check_run";

export type NormalizedEvidenceItem = {
  id: string;
  surface: EvidenceSurface;
  url: string;
  author: string;
  createdAt: string;
  body: string;
  reviewState: string | null;
  reviewedSha: string | null;
  commitId: string | null;
};

export type NormalizedFinding = {
  id: string;
  kind: string;
  severity: string;
  blocking: boolean;
  currentHead: boolean;
  reason: string;
  sourceSurface: EvidenceSurface;
  sourceId: string;
  sourceUrl: string;
  reviewedSha: string | null;
};

export type NormalizedCheckRun = {
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  url: string;
  required: boolean | null;
};

export type EvidenceCollection = {
  repo: string;
  pr: number;
  headSha: string;
  headRef: string;
  prUrl: string;
  formalReviews: NormalizedEvidenceItem[];
  inlineReviewComments: NormalizedEvidenceItem[];
  issueComments: NormalizedEvidenceItem[];
  requestedReviewers: string[];
  checkRuns: NormalizedCheckRun[];
  requiredCheckPolicy: "resolved" | "unknown";
  surfaceCoverage: Record<string, { complete: boolean; count: number }>;
  errors: string[];
};

export type ConvergenceAuditResult = {
  decision: ConvergenceDecision;
  reason: string;
  nextAction: string | null;
  repo: string;
  pr: number;
  headSha: string;
  prUrl: string;
  evidence: EvidenceCollection;
  findings: NormalizedFinding[];
  findingCounts: Record<string, number>;
};

export type PrConvergenceProvider = {
  fetchPullRequest: (params: { repo: string; pr: number }) => Promise<{
    number: number;
    html_url: string;
    head: { sha: string; ref: string };
  }>;
  fetchFormalReviews: (params: { repo: string; pr: number }) => Promise<{
    items: Record<string, unknown>[];
    complete: boolean;
  }>;
  fetchInlineReviewComments: (params: { repo: string; pr: number }) => Promise<{
    items: Record<string, unknown>[];
    complete: boolean;
  }>;
  fetchIssueComments: (params: { repo: string; pr: number }) => Promise<{
    items: Record<string, unknown>[];
    complete: boolean;
  }>;
  fetchRequestedReviewers: (params: { repo: string; pr: number }) => Promise<{
    logins: string[];
    complete: boolean;
  }>;
  fetchCheckRuns: (params: { repo: string; headSha: string }) => Promise<{
    items: Record<string, unknown>[];
    complete: boolean;
    requiredPolicy?: "resolved" | "unknown";
  }>;
};

export const CONVERGENCE_DECISIONS: {
  readonly READY: "READY";
  readonly BLOCKED: "BLOCKED";
  readonly UNKNOWN: "UNKNOWN";
};

export const EVIDENCE_SURFACES: {
  readonly FORMAL_REVIEW: "formal_review";
  readonly INLINE_REVIEW_COMMENT: "inline_review_comment";
  readonly ISSUE_COMMENT: "issue_comment";
  readonly CHECK_RUN: "check_run";
};

export function normalizeIssueComment(
  comment: Record<string, unknown>,
  repo: string,
  pr: number,
): NormalizedEvidenceItem;

export function extractFindingsFromEvidenceItem(
  item: NormalizedEvidenceItem & {
    performed_via_github_app?: { slug?: string } | null;
    user?: { login?: string; type?: string } | null;
  },
  headSha: string,
): NormalizedFinding[];

export function decidePrConvergence(params: {
  evidence: EvidenceCollection;
  findings: NormalizedFinding[];
  headStable: boolean;
  hasExactHeadClawSweeperPass: boolean;
}): {
  decision: ConvergenceDecision;
  reason: string;
  nextAction: string | null;
};

export function auditPrConvergence(params: {
  repo: string;
  pr: number;
  provider: PrConvergenceProvider;
}): Promise<ConvergenceAuditResult>;
