import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ToolApprovalReview } from "./chat-types.ts";

type ToolApprovalReviewOutcome = "approved" | "denied" | "reviewing";

const REVIEW_STATUSES = new Set<string>([
  "in_progress",
  "approved",
  "denied",
  "timed_out",
  "aborted",
]);
export const MAX_TOOL_APPROVAL_REVIEWS = 16;

function boundedString(value: unknown, maxChars: number): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? truncateUtf16Safe(text, maxChars) : undefined;
}

function isReviewStatus(value: string | undefined): value is ToolApprovalReview["status"] {
  return value !== undefined && REVIEW_STATUSES.has(value);
}

export function normalizeToolApprovalReview(value: unknown): ToolApprovalReview | null {
  const review = asNullableRecord(value);
  const id = boundedString(review?.id, 256);
  const label = boundedString(review?.label, 80);
  const status = boundedString(review?.status, 32);
  if (!id || !label || !isReviewStatus(status)) {
    return null;
  }
  const riskLevel = boundedString(review?.riskLevel, 40);
  const userAuthorization = boundedString(review?.userAuthorization, 40);
  const rationale = boundedString(review?.rationale, 2_000);
  return {
    id,
    label,
    status,
    ...(riskLevel ? { riskLevel } : {}),
    ...(userAuthorization ? { userAuthorization } : {}),
    ...(rationale ? { rationale } : {}),
  };
}

export function readToolApprovalReviews(details: unknown): ToolApprovalReview[] {
  const values = asNullableRecord(details)?.approvalReviews;
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .slice(-MAX_TOOL_APPROVAL_REVIEWS)
    .map(normalizeToolApprovalReview)
    .filter((review): review is ToolApprovalReview => review !== null);
}

export function withToolApprovalReviews(
  details: unknown,
  reviews: readonly ToolApprovalReview[],
  outcome?: ToolApprovalReviewOutcome,
): Record<string, unknown> {
  const record = asNullableRecord(details);
  return {
    ...(record ?? (details === undefined ? {} : { toolDetails: details })),
    approvalReviews: [...reviews],
    ...(outcome ? { approvalReviewOutcome: outcome } : {}),
  };
}

export function readToolApprovalReviewOutcome(
  details: unknown,
): ToolApprovalReviewOutcome | undefined {
  const outcome = asNullableRecord(details)?.approvalReviewOutcome;
  return outcome === "approved" || outcome === "denied" || outcome === "reviewing"
    ? outcome
    : undefined;
}

export function resolveToolApprovalReviewOutcome(
  reviews: readonly ToolApprovalReview[],
  recordedOutcomes: readonly ToolApprovalReviewOutcome[] = [],
): ToolApprovalReviewOutcome | null {
  if (
    recordedOutcomes.includes("denied") ||
    reviews.some((review) => ["denied", "timed_out", "aborted"].includes(review.status))
  ) {
    return "denied";
  }
  if (
    recordedOutcomes.includes("reviewing") ||
    reviews.some((review) => review.status === "in_progress")
  ) {
    return "reviewing";
  }
  return recordedOutcomes.includes("approved") ||
    reviews.some((review) => review.status === "approved")
    ? "approved"
    : null;
}
