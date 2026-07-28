// Shared owner-qualified ClawHub skill verdict fallback.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  fetchClawHubSkillVerification,
  type ClawHubSkillSecurityVerdictItem,
  type ClawHubSkillVerificationResponse,
} from "./clawhub.js";

const CLAWHUB_NON_SECURITY_SKILL_VERIFY_REASONS = new Set(["card.missing", "card_missing"]);

function normalizeClawHubTrustToken(value: string | null | undefined): string {
  return normalizeOptionalString(value)?.toLowerCase() ?? "";
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readOptionalStringField(value: unknown, field: string): string | undefined {
  const record = readObject(value);
  return normalizeOptionalString(record?.[field]);
}

function readOptionalNumberField(value: unknown, field: string): number | undefined {
  const record = readObject(value);
  const raw = record?.[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function mapSkillVerificationSecurityForVerdict(
  verification: ClawHubSkillVerificationResponse,
  opts?: { allowCleanCardOnlyPass?: boolean },
): unknown {
  const security = readObject(verification.security);
  if (!security || Object.hasOwn(security, "passed")) {
    return verification.security;
  }
  const status =
    normalizeOptionalString(security.status) ?? normalizeOptionalString(security.rawStatus);
  const decisionPass =
    verification.ok && normalizeClawHubTrustToken(verification.decision) === "pass";
  if (!status || (!decisionPass && opts?.allowCleanCardOnlyPass !== true)) {
    return verification.security;
  }
  // The owner-qualified fallback uses the older verify endpoint, whose pass
  // decision plus concrete status predates the batched verdict `passed` flag.
  return { ...security, passed: true };
}

function hasOnlyNonSecuritySkillVerifyReasons(reasons: readonly string[]): boolean {
  return (
    reasons.length > 0 &&
    reasons.every((reason) =>
      CLAWHUB_NON_SECURITY_SKILL_VERIFY_REASONS.has(normalizeClawHubTrustToken(reason)),
    )
  );
}

function mapSkillVerificationToSecurityVerdictItem(params: {
  verification: ClawHubSkillVerificationResponse;
  slug: string;
  ownerHandle: string;
  version: string;
}): ClawHubSkillSecurityVerdictItem {
  const skill = readObject(params.verification.skill);
  const publisher = readObject(params.verification.publisher);
  const versionRecord = readObject(params.verification.version);
  const pageUrl = normalizeOptionalString(params.verification.pageUrl);
  const reasons = params.verification.reasons
    .map((reason) => normalizeOptionalString(reason))
    .filter((reason): reason is string => Boolean(reason));
  const securityStatus = normalizeClawHubTrustToken(
    readOptionalStringField(params.verification.security, "status") ??
      readOptionalStringField(params.verification.security, "rawStatus"),
  );
  const cardOnlyCleanFailure =
    !params.verification.ok &&
    securityStatus === "clean" &&
    hasOnlyNonSecuritySkillVerifyReasons(reasons);
  const verifiedVersion =
    normalizeOptionalString(params.verification.version) ??
    readOptionalStringField(versionRecord, "version");
  return {
    ok: cardOnlyCleanFailure ? true : params.verification.ok,
    decision: cardOnlyCleanFailure ? "pass" : params.verification.decision,
    reasons: cardOnlyCleanFailure ? [] : reasons,
    requestedSlug: params.slug,
    requestedVersion: params.version,
    slug:
      normalizeOptionalString(params.verification.slug) ?? readOptionalStringField(skill, "slug"),
    version: verifiedVersion ?? (cardOnlyCleanFailure ? params.version : null),
    displayName:
      normalizeOptionalString(params.verification.displayName) ??
      readOptionalStringField(skill, "displayName"),
    publisherHandle:
      normalizeOptionalString(params.verification.publisherHandle) ??
      readOptionalStringField(publisher, "handle") ??
      params.ownerHandle,
    publisherDisplayName:
      normalizeOptionalString(params.verification.publisherDisplayName) ??
      readOptionalStringField(publisher, "displayName"),
    createdAt:
      params.verification.createdAt ?? readOptionalNumberField(versionRecord, "createdAt") ?? null,
    checkedAt: readOptionalNumberField(params.verification.security, "checkedAt") ?? null,
    ...(pageUrl ? { skillUrl: pageUrl } : {}),
    ...(pageUrl
      ? {
          securityAuditUrl: `${pageUrl}/security-audit?version=${encodeURIComponent(params.version)}`,
        }
      : {}),
    security: mapSkillVerificationSecurityForVerdict(params.verification, {
      allowCleanCardOnlyPass: cardOnlyCleanFailure,
    }),
  };
}

export function isOwnerQualifiedSkillNotFoundVerdict(
  item: ClawHubSkillSecurityVerdictItem,
): boolean {
  return item.error?.code === "skill_not_found";
}

export async function fetchOwnerQualifiedSkillSecurityVerdict(params: {
  slug: string;
  ownerHandle: string;
  version: string;
  baseUrl?: string;
  token?: string;
  skipAuth?: boolean;
  timeoutMs?: number;
}): Promise<ClawHubSkillSecurityVerdictItem> {
  const verification = await fetchClawHubSkillVerification({
    slug: params.slug,
    ownerHandle: params.ownerHandle,
    version: params.version,
    baseUrl: params.baseUrl,
    token: params.token,
    skipAuth: params.skipAuth,
    timeoutMs: params.timeoutMs,
  });
  return mapSkillVerificationToSecurityVerdictItem({
    verification,
    slug: params.slug,
    ownerHandle: params.ownerHandle,
    version: params.version,
  });
}
