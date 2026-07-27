// Read-only exact-head PR convergence audit for GitHub review evidence.
import { hasClawSweeperExactHeadProof } from "./github/real-behavior-proof-policy.mjs";

/** @typedef {"READY" | "BLOCKED" | "UNKNOWN"} ConvergenceDecision */

/** @typedef {"formal_review" | "inline_review_comment" | "issue_comment" | "check_run"} EvidenceSurface */

/**
 * @typedef {object} NormalizedEvidenceItem
 * @property {string} id
 * @property {EvidenceSurface} surface
 * @property {string} url
 * @property {string} author
 * @property {string} createdAt
 * @property {string} body
 * @property {string | null} reviewState
 * @property {string | null} reviewedSha
 * @property {string | null} commitId
 */

/**
 * @typedef {object} NormalizedFinding
 * @property {string} id
 * @property {string} kind
 * @property {string} severity
 * @property {boolean} blocking
 * @property {boolean} currentHead
 * @property {string} reason
 * @property {EvidenceSurface} sourceSurface
 * @property {string} sourceId
 * @property {string} sourceUrl
 * @property {string | null} reviewedSha
 */

/**
 * @typedef {object} NormalizedCheckRun
 * @property {string} id
 * @property {string} name
 * @property {string} status
 * @property {string | null} conclusion
 * @property {string} headSha
 * @property {string} url
 * @property {boolean | null} required
 */

/**
 * @typedef {object} EvidenceCollection
 * @property {string} repo
 * @property {number} pr
 * @property {string} headSha
 * @property {string} headRef
 * @property {string} prUrl
 * @property {NormalizedEvidenceItem[]} formalReviews
 * @property {NormalizedEvidenceItem[]} inlineReviewComments
 * @property {NormalizedEvidenceItem[]} issueComments
 * @property {string[]} requestedReviewers
 * @property {NormalizedCheckRun[]} checkRuns
 * @property {"resolved" | "unknown"} requiredCheckPolicy
 * @property {Record<string, { complete: boolean; count: number }>} surfaceCoverage
 * @property {string[]} errors
 */

/**
 * @typedef {object} ConvergenceAuditResult
 * @property {ConvergenceDecision} decision
 * @property {string} reason
 * @property {string | null} nextAction
 * @property {string} repo
 * @property {number} pr
 * @property {string} headSha
 * @property {string} prUrl
 * @property {EvidenceCollection} evidence
 * @property {NormalizedFinding[]} findings
 * @property {Record<string, number>} findingCounts
 */

/**
 * @typedef {object} PrConvergenceProvider
 * @property {(params: { repo: string; pr: number }) => Promise<{
 *   number: number;
 *   html_url: string;
 *   head: { sha: string; ref: string };
 * }>} fetchPullRequest
 * @property {(params: { repo: string; pr: number }) => Promise<{
 *   items: Record<string, unknown>[];
 *   complete: boolean;
 * }>} fetchFormalReviews
 * @property {(params: { repo: string; pr: number }) => Promise<{
 *   items: Record<string, unknown>[];
 *   complete: boolean;
 * }>} fetchInlineReviewComments
 * @property {(params: { repo: string; pr: number }) => Promise<{
 *   items: Record<string, unknown>[];
 *   complete: boolean;
 * }>} fetchIssueComments
 * @property {(params: { repo: string; pr: number }) => Promise<{
 *   logins: string[];
 *   complete: boolean;
 * }>} fetchRequestedReviewers
 * @property {(params: { repo: string; headSha: string }) => Promise<{
 *   items: Record<string, unknown>[];
 *   complete: boolean;
 *   requiredPolicy?: "resolved" | "unknown";
 * }>} fetchCheckRuns
 */

export const CONVERGENCE_DECISIONS = Object.freeze({
  READY: "READY",
  BLOCKED: "BLOCKED",
  UNKNOWN: "UNKNOWN",
});

export const EVIDENCE_SURFACES = Object.freeze({
  FORMAL_REVIEW: "formal_review",
  INLINE_REVIEW_COMMENT: "inline_review_comment",
  ISSUE_COMMENT: "issue_comment",
  CHECK_RUN: "check_run",
});

const CLAWSWEEPER_BOT_LOGINS = new Set(["clawsweeper[bot]", "openclaw-clawsweeper[bot]"]);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const FINDING_KIND_PATTERNS = [
  { kind: "p0", regex: /\bP0\b/i, severity: "P0", blocking: true },
  { kind: "p1", regex: /\bP1\b/i, severity: "P1", blocking: true },
  { kind: "p2", regex: /\bP2\b/i, severity: "P2", blocking: false },
  { kind: "blocked", regex: /\bBLOCKED\b/i, severity: "blocked", blocking: true },
  { kind: "needs_proof", regex: /\bneeds[\s-]?proof\b/i, severity: "needs_proof", blocking: true },
  {
    kind: "actionable_finding",
    regex: /\bactionable findings?\b/i,
    severity: "actionable",
    blocking: true,
  },
  {
    kind: "unchecked_finding",
    regex: /\bunchecked findings?\b/i,
    severity: "unchecked",
    blocking: true,
  },
  {
    kind: "changes_requested",
    regex: /\bchanges requested\b/i,
    severity: "changes_requested",
    blocking: true,
  },
  {
    kind: "re_review_request",
    regex: /(?:@clawsweeper\s+re-review\b|\bre-review requested\b)/i,
    severity: "re_review",
    blocking: true,
  },
];

const AMBIGUOUS_REVIEWED_SHA_KINDS = new Set([
  "p0",
  "p1",
  "p2",
  "blocked",
  "needs_proof",
  "actionable_finding",
  "unchecked_finding",
  "changes_requested",
  "re_review_request",
]);

function normalizeSha(value) {
  const sha = String(value ?? "").toLowerCase();
  return SHA_PATTERN.test(sha) ? sha : null;
}

function compareStrings(left, right) {
  return String(left).localeCompare(String(right));
}

function isTrustedClawSweeperActor(item = {}) {
  const appSlug = String(
    item?.performed_via_github_app?.slug ?? item?.performedViaGithubApp?.slug ?? "",
  ).toLowerCase();
  if (appSlug === "clawsweeper") {
    return true;
  }
  const login = String(item?.user?.login ?? "").toLowerCase();
  const userType = String(item?.user?.type ?? "");
  return CLAWSWEEPER_BOT_LOGINS.has(login) && userType === "Bot";
}

function extractMarkerField(marker, name) {
  const match = marker.match(new RegExp(`\\b${name}=([^\\s>]+)`, "i"));
  return match?.[1] ?? "";
}

function extractClawSweeperMarkerSha(body = "") {
  const markers = body.match(/<!--\s*clawsweeper-verdict:[^>]*-->/gi) ?? [];
  for (const marker of markers) {
    const sha = normalizeSha(extractMarkerField(marker, "sha"));
    if (sha) {
      return sha;
    }
  }
  return null;
}

function extractClawSweeperMarkerKinds(body = "") {
  const markers = body.match(/<!--\s*clawsweeper-verdict:([^>\s]+)[^>]*-->/gi) ?? [];
  return markers.map((marker) => {
    const match = marker.match(/clawsweeper-verdict:([^>\s]+)/i);
    return (match?.[1] ?? "").split(":")[0].toLowerCase();
  });
}

function normalizeFormalReview(review, repo, pr) {
  const id = String(review?.id ?? "");
  const commitId = normalizeSha(review?.commit_id ?? review?.commitId);
  return {
    id,
    surface: EVIDENCE_SURFACES.FORMAL_REVIEW,
    url:
      String(review?.html_url ?? "") ||
      `https://github.com/${repo}/pull/${pr}#pullrequestreview-${id}`,
    author: String(review?.user?.login ?? ""),
    createdAt: String(review?.submitted_at ?? review?.created_at ?? ""),
    body: String(review?.body ?? ""),
    reviewState: String(review?.state ?? "").toUpperCase() || null,
    reviewedSha: commitId,
    commitId,
  };
}

function normalizeInlineReviewComment(comment, repo, pr) {
  const id = String(comment?.id ?? "");
  const commitId = normalizeSha(comment?.commit_id ?? comment?.original_commit_id);
  return {
    id,
    surface: EVIDENCE_SURFACES.INLINE_REVIEW_COMMENT,
    url:
      String(comment?.html_url ?? "") || `https://github.com/${repo}/pull/${pr}#discussion_r${id}`,
    author: String(comment?.user?.login ?? ""),
    createdAt: String(comment?.created_at ?? ""),
    body: String(comment?.body ?? ""),
    reviewState: null,
    reviewedSha: commitId,
    commitId,
  };
}

export function normalizeIssueComment(comment, repo, pr) {
  const id = String(comment?.id ?? "");
  return {
    id,
    surface: EVIDENCE_SURFACES.ISSUE_COMMENT,
    url:
      String(comment?.html_url ?? "") ||
      `https://github.com/${repo}/issues/${pr}#issuecomment-${id}`,
    author: String(comment?.user?.login ?? ""),
    createdAt: String(comment?.created_at ?? ""),
    body: String(comment?.body ?? ""),
    reviewState: null,
    reviewedSha: extractClawSweeperMarkerSha(comment?.body),
    commitId: null,
  };
}

function normalizeCheckRun(check) {
  const id = String(check?.id ?? check?.name ?? "");
  const required = typeof check?.required === "boolean" ? check.required : null;
  return {
    id,
    name: String(check?.name ?? id),
    status: String(check?.status ?? "").toLowerCase(),
    conclusion: check?.conclusion == null ? null : String(check.conclusion).toLowerCase(),
    headSha: normalizeSha(check?.head_sha ?? check?.headSha) ?? "",
    url: check?.html_url ?? check?.details_url ?? "",
    required,
  };
}

function resolveReviewedSha(item) {
  return item.reviewedSha ?? item.commitId ?? extractClawSweeperMarkerSha(item.body) ?? null;
}

function isCurrentHeadFinding(item, headSha) {
  const reviewedSha = resolveReviewedSha(item);
  return reviewedSha !== null && reviewedSha === headSha;
}

function bodyLooksLikeReviewEvidence(body = "") {
  if (!body.trim()) {
    return false;
  }
  if (/<!--\s*clawsweeper-verdict:/i.test(body)) {
    return true;
  }
  return FINDING_KIND_PATTERNS.some((pattern) => pattern.regex.test(body));
}

export function extractFindingsFromEvidenceItem(item, headSha) {
  /** @type {NormalizedFinding[]} */
  const findings = [];
  const body = item.body ?? "";
  const reviewedSha = resolveReviewedSha(item);
  const currentHead = reviewedSha !== null && reviewedSha === headSha;
  const trustedClawSweeper =
    item.surface === EVIDENCE_SURFACES.ISSUE_COMMENT && isTrustedClawSweeperActor(item);
  const markerKinds = extractClawSweeperMarkerKinds(body);

  for (const markerKind of markerKinds) {
    if (markerKind === "pass") {
      continue;
    }
    const blocking = markerKind !== "note";
    findings.push({
      id: `${item.surface}:${item.id}:marker:${markerKind}`,
      kind: `clawsweeper_verdict_${markerKind}`,
      severity: markerKind,
      blocking,
      currentHead,
      reason: `ClawSweeper verdict marker ${markerKind} on ${item.surface}.`,
      sourceSurface: item.surface,
      sourceId: item.id,
      sourceUrl: item.url,
      reviewedSha,
    });
  }

  if (item.reviewState === "CHANGES_REQUESTED") {
    findings.push({
      id: `${item.surface}:${item.id}:changes_requested`,
      kind: "changes_requested",
      severity: "changes_requested",
      blocking: true,
      currentHead,
      reason: "Formal review requested changes.",
      sourceSurface: item.surface,
      sourceId: item.id,
      sourceUrl: item.url,
      reviewedSha,
    });
  }

  if (!bodyLooksLikeReviewEvidence(body) && item.reviewState !== "CHANGES_REQUESTED") {
    return findings;
  }

  for (const pattern of FINDING_KIND_PATTERNS) {
    if (!pattern.regex.test(body)) {
      continue;
    }
    if (
      pattern.kind === "blocked" &&
      !trustedClawSweeper &&
      item.surface !== EVIDENCE_SURFACES.FORMAL_REVIEW &&
      item.reviewState !== "CHANGES_REQUESTED"
    ) {
      continue;
    }
    findings.push({
      id: `${item.surface}:${item.id}:${pattern.kind}`,
      kind: pattern.kind,
      severity: pattern.severity,
      blocking: pattern.blocking,
      currentHead,
      reason: `Matched ${pattern.kind} in ${item.surface}.`,
      sourceSurface: item.surface,
      sourceId: item.id,
      sourceUrl: item.url,
      reviewedSha,
    });
  }

  return findings;
}

function withActorFields(normalized, raw) {
  return Object.assign({}, normalized, {
    performed_via_github_app: raw?.performed_via_github_app ?? null,
    user: raw?.user ?? null,
  });
}

function summarizeFindingCounts(findings) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const finding of findings) {
    counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  }
  return counts;
}

function requiredChecksSatisfied(checkRuns, headSha, requiredCheckPolicy) {
  if (requiredCheckPolicy !== "resolved") {
    return {
      ok: false,
      unknown: true,
      reason: "Required checks were not resolved from the target branch protection or ruleset policy.",
    };
  }
  const exactHeadChecks = checkRuns.filter((check) => check.headSha === headSha);
  if (exactHeadChecks.some((check) => check.required === null)) {
    return {
      ok: false,
      unknown: true,
      reason: "Required-check status is ambiguous for the exact head.",
    };
  }
  const required = exactHeadChecks.filter((check) => check.required === true);
  if (required.length === 0) {
    return { ok: true, reason: "The target branch policy resolved no required checks for the exact head." };
  }
  const pending = required.filter((check) => check.status !== "completed");
  if (pending.length > 0) {
    return {
      ok: false,
      pending: true,
      reason: `Required checks still pending for ${headSha}: ${pending.map((check) => check.name).join(", ")}.`,
    };
  }
  const failed = required.filter((check) => check.conclusion !== "success");
  if (failed.length > 0) {
    return {
      ok: false,
      pending: false,
      reason: `Required checks failed for ${headSha}: ${failed.map((check) => check.name).join(", ")}.`,
    };
  }
  return { ok: true, reason: "All required checks succeeded for the exact head." };
}

function hasFormalReviewOnlyReadySignal(formalReviews, findings, headSha) {
  const hasApprovedFormalReview = formalReviews.some(
    (review) => review.reviewState === "APPROVED" && isCurrentHeadFinding(review, headSha),
  );
  const hasNonFormalEvidence =
    findings.some((finding) => finding.sourceSurface !== EVIDENCE_SURFACES.FORMAL_REVIEW) ||
    formalReviews.length === 0;
  return hasApprovedFormalReview && !hasNonFormalEvidence;
}

/**
 * @param {object} params
 * @param {EvidenceCollection} params.evidence
 * @param {NormalizedFinding[]} params.findings
 * @param {boolean} params.headStable
 * @param {boolean} params.hasExactHeadClawSweeperPass
 */
export function decidePrConvergence({
  evidence,
  findings,
  headStable,
  hasExactHeadClawSweeperPass,
}) {
  const headSha = evidence.headSha;
  const incompleteSurfaces = Object.entries(evidence.surfaceCoverage)
    .filter(([, coverage]) => !coverage.complete)
    .map(([surface]) => surface);
  if (!headStable) {
    return {
      decision: CONVERGENCE_DECISIONS.UNKNOWN,
      reason: "PR head changed between the initial and final audit reads.",
      nextAction: "Re-run the convergence audit after the PR head stabilizes.",
    };
  }
  if (evidence.errors.length > 0) {
    return {
      decision: CONVERGENCE_DECISIONS.UNKNOWN,
      reason: evidence.errors.join(" "),
      nextAction: "Refresh GitHub evidence and re-run the convergence audit.",
    };
  }
  if (incompleteSurfaces.length > 0) {
    return {
      decision: CONVERGENCE_DECISIONS.UNKNOWN,
      reason: `Evidence collection is incomplete for: ${incompleteSurfaces.join(", ")}.`,
      nextAction:
        "Paginate or refresh the missing GitHub evidence surfaces, then re-run the audit.",
    };
  }
  if (!SHA_PATTERN.test(headSha)) {
    return {
      decision: CONVERGENCE_DECISIONS.UNKNOWN,
      reason: "PR head SHA is missing or ambiguous.",
      nextAction: "Refresh PR identity and re-run the convergence audit.",
    };
  }

  const ambiguousReviewedShaFindings = findings.filter(
    (finding) =>
      finding.reviewedSha === null &&
      (finding.blocking || AMBIGUOUS_REVIEWED_SHA_KINDS.has(finding.kind)),
  );
  if (ambiguousReviewedShaFindings.length > 0) {
    return {
      decision: CONVERGENCE_DECISIONS.UNKNOWN,
      reason: `Actionable review evidence is missing an exact reviewed SHA (${ambiguousReviewedShaFindings
        .map((finding) => finding.kind)
        .join(", ")}).`,
      nextAction:
        "Refresh GitHub evidence with commit or ClawSweeper marker SHAs, then re-run the audit.",
    };
  }

  const exactHeadReReviewFindings = findings.filter(
    (finding) => finding.kind === "re_review_request" && finding.currentHead,
  );
  if (exactHeadReReviewFindings.length > 0) {
    return {
      decision: CONVERGENCE_DECISIONS.UNKNOWN,
      reason:
        "An exact-head re-review has been requested but fresh review evidence is not available.",
      nextAction:
        "Obtain fresh exact-head ClawSweeper or maintainer review evidence, then re-run the audit.",
    };
  }

  const staleReReviewFindings = findings.filter(
    (finding) => finding.kind === "re_review_request" && !finding.currentHead,
  );
  if (staleReReviewFindings.length > 0) {
    return {
      decision: CONVERGENCE_DECISIONS.UNKNOWN,
      reason: `Stale re-review requests remain for older heads (${staleReReviewFindings
        .map((finding) => finding.reviewedSha ?? "unknown")
        .join(", ")}).`,
      nextAction:
        "Request a fresh exact-head ClawSweeper re-review after pushing the current head.",
    };
  }

  const staleBlockingFindings = findings.filter(
    (finding) => finding.blocking && !finding.currentHead,
  );
  if (staleBlockingFindings.length > 0) {
    return {
      decision: CONVERGENCE_DECISIONS.UNKNOWN,
      reason: `Stale blocking review evidence remains for older heads (${staleBlockingFindings
        .map((finding) => finding.reviewedSha ?? "unknown")
        .join(", ")}).`,
      nextAction: "Request a fresh ClawSweeper re-review after pushing the current head.",
    };
  }

  const currentHeadBlockingFindings = findings.filter(
    (finding) => finding.blocking && finding.currentHead,
  );
  if (currentHeadBlockingFindings.length > 0) {
    return {
      decision: CONVERGENCE_DECISIONS.BLOCKED,
      reason: `Unresolved current-head blockers remain (${currentHeadBlockingFindings
        .map((finding) => finding.kind)
        .join(", ")}).`,
      nextAction: "Address the blocking findings, refresh proof, and request re-review.",
    };
  }

  const checks = requiredChecksSatisfied(
    evidence.checkRuns,
    headSha,
    evidence.requiredCheckPolicy,
  );
  if (!checks.ok) {
    if (checks.unknown) {
      return {
        decision: CONVERGENCE_DECISIONS.UNKNOWN,
        reason: checks.reason,
        nextAction:
          "Resolve required checks from target-branch protection or rulesets, then re-run the convergence audit.",
      };
    }
    if (checks.pending) {
      return {
        decision: CONVERGENCE_DECISIONS.UNKNOWN,
        reason: checks.reason,
        nextAction: "Wait for required checks to finish, then re-run the convergence audit.",
      };
    }
    return {
      decision: CONVERGENCE_DECISIONS.BLOCKED,
      reason: checks.reason,
      nextAction:
        "Fix failing required checks or document an unrelated failure, then re-run the audit.",
    };
  }

  if (hasFormalReviewOnlyReadySignal(evidence.formalReviews, findings, headSha)) {
    return {
      decision: CONVERGENCE_DECISIONS.UNKNOWN,
      reason: "Formal review state alone is not sufficient for READY.",
      nextAction:
        "Collect issue/PR comment, inline review, and check-run evidence for the exact head.",
    };
  }

  if (
    evidence.formalReviews.length === 0 &&
    !hasExactHeadClawSweeperPass &&
    findings.length === 0
  ) {
    return {
      decision: CONVERGENCE_DECISIONS.UNKNOWN,
      reason: "No formal reviews or exact-head ClawSweeper pass were found.",
      nextAction: "Request ClawSweeper review or maintainer review before merge.",
    };
  }

  return {
    decision: CONVERGENCE_DECISIONS.READY,
    reason: "Exact-head evidence is complete, checks are green, and no unresolved blockers remain.",
    nextAction: null,
  };
}

function formatProviderFailureReason(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

/**
 * @param {object} params
 * @param {string} params.repo
 * @param {number} params.pr
 * @param {string} params.reason
 * @param {string} [params.headSha]
 * @param {string} [params.headRef]
 * @param {string} [params.prUrl]
 */
function buildProviderFailureAuditResult({
  repo,
  pr,
  reason,
  headSha = "",
  headRef = "",
  prUrl = `https://github.com/${repo}/pull/${pr}`,
}) {
  const failureReason = `Provider or API error during convergence audit: ${reason}`;
  return {
    decision: CONVERGENCE_DECISIONS.UNKNOWN,
    reason: failureReason,
    nextAction: "Refresh GitHub evidence and re-run the convergence audit.",
    repo,
    pr,
    headSha,
    prUrl,
    evidence: {
      repo,
      pr,
      headSha,
      headRef,
      prUrl,
      formalReviews: [],
      inlineReviewComments: [],
      issueComments: [],
      requestedReviewers: [],
      checkRuns: [],
      requiredCheckPolicy: "unknown",
      surfaceCoverage: {},
      errors: [failureReason],
    },
    findings: [],
    findingCounts: {},
  };
}

/**
 * @param {object} params
 * @param {string} params.repo
 * @param {number} params.pr
 * @param {PrConvergenceProvider} params.provider
 */
export async function auditPrConvergence({ repo, pr, provider }) {
  const fallbackPrUrl = `https://github.com/${repo}/pull/${pr}`;
  let initialPull;
  try {
    initialPull = await provider.fetchPullRequest({ repo, pr });
  } catch (error) {
    return buildProviderFailureAuditResult({
      repo,
      pr,
      reason: formatProviderFailureReason(error),
      prUrl: fallbackPrUrl,
    });
  }

  const initialHeadSha = normalizeSha(initialPull?.head?.sha);
  if (!initialHeadSha) {
    return {
      decision: CONVERGENCE_DECISIONS.UNKNOWN,
      reason: "Initial PR head SHA is missing or ambiguous.",
      nextAction: "Refresh PR identity and re-run the convergence audit.",
      repo,
      pr,
      headSha: "",
      prUrl: initialPull?.html_url ?? fallbackPrUrl,
      evidence: {
        repo,
        pr,
        headSha: "",
        headRef: initialPull?.head?.ref ?? "",
        prUrl: initialPull?.html_url ?? fallbackPrUrl,
        formalReviews: [],
        inlineReviewComments: [],
        issueComments: [],
        requestedReviewers: [],
        checkRuns: [],
        surfaceCoverage: {},
        errors: ["Initial PR head SHA is missing or ambiguous."],
      },
      findings: [],
      findingCounts: {},
    };
  }

  let formalReviewsResult;
  let inlineReviewCommentsResult;
  let issueCommentsResult;
  let requestedReviewersResult;
  let checkRunsResult;
  let finalPull;
  try {
    [
      formalReviewsResult,
      inlineReviewCommentsResult,
      issueCommentsResult,
      requestedReviewersResult,
      checkRunsResult,
      finalPull,
    ] = await Promise.all([
      provider.fetchFormalReviews({ repo, pr }),
      provider.fetchInlineReviewComments({ repo, pr }),
      provider.fetchIssueComments({ repo, pr }),
      provider.fetchRequestedReviewers({ repo, pr }),
      provider.fetchCheckRuns({ repo, headSha: initialHeadSha }),
      provider.fetchPullRequest({ repo, pr }),
    ]);
  } catch (error) {
    return buildProviderFailureAuditResult({
      repo,
      pr,
      reason: formatProviderFailureReason(error),
      headSha: initialHeadSha,
      headRef: initialPull?.head?.ref ?? "",
      prUrl: initialPull?.html_url ?? fallbackPrUrl,
    });
  }

  const finalHeadSha = normalizeSha(finalPull?.head?.sha) ?? "";
  const headStable = finalHeadSha === initialHeadSha;
  const prUrl =
    finalPull?.html_url ?? initialPull?.html_url ?? `https://github.com/${repo}/pull/${pr}`;

  const formalReviews = (formalReviewsResult.items ?? [])
    .map((item) => normalizeFormalReview(item, repo, pr))
    .toSorted((left, right) => compareStrings(left.createdAt, right.createdAt));
  const inlineReviewComments = (inlineReviewCommentsResult.items ?? [])
    .map((item) => normalizeInlineReviewComment(item, repo, pr))
    .toSorted((left, right) => compareStrings(left.createdAt, right.createdAt));
  const issueComments = (issueCommentsResult.items ?? [])
    .map((item) => normalizeIssueComment(item, repo, pr))
    .toSorted((left, right) => compareStrings(left.createdAt, right.createdAt));
  const requestedReviewers = [...(requestedReviewersResult.logins ?? [])].toSorted(compareStrings);
  const requiredCheckPolicy = checkRunsResult.requiredPolicy === "resolved" ? "resolved" : "unknown";
  const checkRuns = (checkRunsResult.items ?? [])
    .map((item) => normalizeCheckRun(item))
    .toSorted((left, right) => compareStrings(left.name, right.name));

  const evidence = {
    repo,
    pr,
    headSha: finalHeadSha || initialHeadSha,
    headRef: finalPull?.head?.ref ?? initialPull?.head?.ref ?? "",
    prUrl,
    formalReviews,
    inlineReviewComments,
    issueComments,
    requestedReviewers,
    checkRuns,
    requiredCheckPolicy,
    surfaceCoverage: {
      formal_reviews: {
        complete: formalReviewsResult.complete,
        count: formalReviews.length,
      },
      inline_review_comments: {
        complete: inlineReviewCommentsResult.complete,
        count: inlineReviewComments.length,
      },
      issue_comments: {
        complete: issueCommentsResult.complete,
        count: issueComments.length,
      },
      requested_reviewers: {
        complete: requestedReviewersResult.complete,
        count: requestedReviewers.length,
      },
      check_runs: {
        complete: checkRunsResult.complete,
        count: checkRuns.length,
      },
    },
    errors: [],
  };

  const findingItems = [
    ...(formalReviewsResult.items ?? []).map((item) =>
      withActorFields(normalizeFormalReview(item, repo, pr), item),
    ),
    ...(inlineReviewCommentsResult.items ?? []).map((item) =>
      withActorFields(normalizeInlineReviewComment(item, repo, pr), item),
    ),
    ...(issueCommentsResult.items ?? []).map((item) =>
      withActorFields(normalizeIssueComment(item, repo, pr), item),
    ),
  ];

  const findings = findingItems
    .flatMap((item) => extractFindingsFromEvidenceItem(item, evidence.headSha))
    .toSorted((left, right) => compareStrings(left.id, right.id));

  const hasExactHeadClawSweeperPass = hasClawSweeperExactHeadProof({
    pullRequest: { number: pr, head: { sha: evidence.headSha } },
    comments: issueCommentsResult.items ?? [],
  });

  const decision = decidePrConvergence({
    evidence,
    findings,
    headStable,
    hasExactHeadClawSweeperPass,
  });

  return {
    ...decision,
    repo,
    pr,
    headSha: evidence.headSha,
    prUrl,
    evidence,
    findings,
    findingCounts: summarizeFindingCounts(findings),
  };
}
