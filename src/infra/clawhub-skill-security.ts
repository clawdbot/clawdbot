// Shared owner-qualified ClawHub security verdict resolution.
import { asOptionalRecord as readObject } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import pLimit from "p-limit";
import {
  fetchClawHubSkillSecurityVerdicts,
  fetchClawHubSkillVerification,
  type ClawHubSkillSecurityVerdictItem,
  type ClawHubSkillVerificationResponse,
} from "./clawhub-skills.js";

const MAX_SECURITY_VERDICT_BATCH_SIZE = 100;
const OWNER_QUALIFIED_FALLBACK_CONCURRENCY = 6;
const NON_SECURITY_VERIFY_REASONS = new Set(["card.missing", "card_missing"]);

type ClawHubExactSkillSecurityTarget = {
  slug: string;
  ownerHandle?: string;
  version: string;
};

type FetchExactSkillSecurityParams = {
  items: ClawHubExactSkillSecurityTarget[];
  baseUrl?: string;
  token?: string;
  skipAuth?: boolean;
  timeoutMs?: number;
};

function normalizeOwnerHandle(ownerHandle: string | null | undefined): string | undefined {
  const normalized = normalizeOptionalString(ownerHandle)?.replace(/^@+/, "").toLowerCase();
  return normalized || undefined;
}

function normalizeTarget(target: ClawHubExactSkillSecurityTarget): ClawHubExactSkillSecurityTarget {
  const slug = target.slug.trim();
  const ownerHandle = normalizeOwnerHandle(target.ownerHandle);
  const version = target.version.trim();
  return { slug, ...(ownerHandle ? { ownerHandle } : {}), version };
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function targetKey(target: ClawHubExactSkillSecurityTarget): string {
  return `${target.ownerHandle ?? ""}\0${normalizeSlug(target.slug)}\0${target.version}`;
}

function legacyTargetKey(
  target: Pick<ClawHubExactSkillSecurityTarget, "slug" | "version">,
): string {
  return `${normalizeSlug(target.slug)}\0${target.version}`;
}

function partitionCompatibleBatches(
  targets: ClawHubExactSkillSecurityTarget[],
): ClawHubExactSkillSecurityTarget[][] {
  const batches: Array<{
    items: ClawHubExactSkillSecurityTarget[];
    legacyKeys: Set<string>;
  }> = [];
  for (const target of targets) {
    const legacyKey = legacyTargetKey(target);
    let batch = batches.find(
      (candidate) =>
        candidate.items.length < MAX_SECURITY_VERDICT_BATCH_SIZE &&
        !candidate.legacyKeys.has(legacyKey),
    );
    if (!batch) {
      batch = { items: [], legacyKeys: new Set() };
      batches.push(batch);
    }
    batch.items.push(target);
    batch.legacyKeys.add(legacyKey);
  }
  return batches.map((batch) => batch.items);
}

function readOptionalStringField(value: unknown, field: string): string | undefined {
  return normalizeOptionalString(readObject(value)?.[field]);
}

function readOptionalNumberField(value: unknown, field: string): number | undefined {
  const raw = readObject(value)?.[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function normalizeReason(reason: string | null | undefined): string {
  return normalizeOptionalString(reason)?.toLowerCase() ?? "";
}

function hasOnlyNonSecurityVerifyReasons(reasons: readonly string[]): boolean {
  return (
    reasons.length > 0 &&
    reasons.every((reason) => NON_SECURITY_VERIFY_REASONS.has(normalizeReason(reason)))
  );
}

function mapVerificationSecurity(
  verification: ClawHubSkillVerificationResponse,
  allowCleanCardOnlyPass: boolean,
): unknown {
  const security = readObject(verification.security);
  if (!security || Object.hasOwn(security, "passed")) {
    return verification.security;
  }
  const status =
    normalizeOptionalString(security.status) ?? normalizeOptionalString(security.rawStatus);
  const decisionPass = verification.ok && normalizeReason(verification.decision) === "pass";
  if (!status || (!decisionPass && !allowCleanCardOnlyPass)) {
    return verification.security;
  }
  // Older exact-verify responses predate the batched verdict `passed` flag.
  return { ...security, passed: true };
}

function mapVerificationToVerdict(params: {
  verification: ClawHubSkillVerificationResponse;
  target: ClawHubExactSkillSecurityTarget & { ownerHandle: string };
}): ClawHubSkillSecurityVerdictItem {
  const skill = readObject(params.verification.skill);
  const publisher = readObject(params.verification.publisher);
  const versionRecord = readObject(params.verification.version);
  const pageUrl = normalizeOptionalString(params.verification.pageUrl);
  const reasons = params.verification.reasons
    .map((reason) => normalizeOptionalString(reason))
    .filter((reason): reason is string => Boolean(reason));
  const securityStatus = normalizeReason(
    readOptionalStringField(params.verification.security, "status") ??
      readOptionalStringField(params.verification.security, "rawStatus"),
  );
  const cardOnlyCleanFailure =
    !params.verification.ok &&
    securityStatus === "clean" &&
    hasOnlyNonSecurityVerifyReasons(reasons);
  const verifiedVersion =
    normalizeOptionalString(params.verification.version) ??
    readOptionalStringField(versionRecord, "version");
  return {
    ok: cardOnlyCleanFailure ? true : params.verification.ok,
    decision: cardOnlyCleanFailure ? "pass" : params.verification.decision,
    reasons: cardOnlyCleanFailure ? [] : reasons,
    requestedSlug: params.target.slug,
    requestedOwnerHandle: params.target.ownerHandle,
    requestedVersion: params.target.version,
    slug:
      normalizeOptionalString(params.verification.slug) ?? readOptionalStringField(skill, "slug"),
    version: verifiedVersion ?? (cardOnlyCleanFailure ? params.target.version : null),
    displayName:
      normalizeOptionalString(params.verification.displayName) ??
      readOptionalStringField(skill, "displayName"),
    publisherHandle:
      normalizeOptionalString(params.verification.publisherHandle) ??
      readOptionalStringField(publisher, "handle"),
    publisherDisplayName:
      normalizeOptionalString(params.verification.publisherDisplayName) ??
      readOptionalStringField(publisher, "displayName"),
    createdAt:
      params.verification.createdAt ?? readOptionalNumberField(versionRecord, "createdAt") ?? null,
    checkedAt: readOptionalNumberField(params.verification.security, "checkedAt") ?? null,
    ...(pageUrl ? { skillUrl: pageUrl } : {}),
    ...(pageUrl
      ? {
          securityAuditUrl: `${pageUrl}/security-audit?version=${encodeURIComponent(params.target.version)}`,
        }
      : {}),
    security: mapVerificationSecurity(params.verification, cardOnlyCleanFailure),
  };
}

function identityFailure(
  target: ClawHubExactSkillSecurityTarget,
  message: string,
): ClawHubSkillSecurityVerdictItem {
  return {
    ok: false,
    decision: "fail",
    reasons: ["security.identity_mismatch"],
    requestedSlug: target.slug,
    ...(target.ownerHandle ? { requestedOwnerHandle: target.ownerHandle } : {}),
    requestedVersion: target.version,
    slug: null,
    version: null,
    publisherHandle: null,
    security: null,
    error: { code: "identity_mismatch", message },
  };
}

function validateVerdictIdentity(
  target: ClawHubExactSkillSecurityTarget,
  item: ClawHubSkillSecurityVerdictItem,
): ClawHubSkillSecurityVerdictItem {
  const requestedSlug = normalizeOptionalString(item.requestedSlug)?.toLowerCase();
  if (requestedSlug !== normalizeSlug(target.slug)) {
    return identityFailure(
      target,
      `ClawHub returned requested slug ${requestedSlug ?? "unknown"}.`,
    );
  }
  if (normalizeOptionalString(item.requestedVersion) !== target.version) {
    return identityFailure(target, "ClawHub returned a different requested version.");
  }
  const requestedOwnerHandle = normalizeOwnerHandle(item.requestedOwnerHandle);
  if (requestedOwnerHandle && requestedOwnerHandle !== target.ownerHandle) {
    return identityFailure(target, `ClawHub returned requested owner ${requestedOwnerHandle}.`);
  }
  const resolvedSlug = normalizeOptionalString(item.slug)?.toLowerCase();
  if (resolvedSlug && resolvedSlug !== normalizeSlug(target.slug)) {
    return identityFailure(target, `ClawHub resolved skill ${resolvedSlug}.`);
  }
  const resolvedVersion = normalizeOptionalString(item.version);
  if (resolvedVersion && resolvedVersion !== target.version) {
    return identityFailure(target, `ClawHub resolved version ${resolvedVersion}.`);
  }
  if (item.ok && resolvedVersion !== target.version) {
    return identityFailure(target, "ClawHub did not return the exact requested version.");
  }
  const publisherHandle = normalizeOwnerHandle(item.publisherHandle);
  if (target.ownerHandle && item.version !== null && publisherHandle !== target.ownerHandle) {
    return identityFailure(target, `ClawHub resolved publisher ${publisherHandle ?? "unknown"}.`);
  }
  return item;
}

function correlateBatchItems(
  targets: ClawHubExactSkillSecurityTarget[],
  items: ClawHubSkillSecurityVerdictItem[],
): Map<string, ClawHubSkillSecurityVerdictItem> {
  if (items.length !== targets.length) {
    throw new Error(
      `ClawHub skill security verdict request returned ${items.length} verdicts for ${targets.length} targets.`,
    );
  }
  const byKey = new Map(targets.map((target) => [targetKey(target), target]));
  const byLegacyKey = new Map(targets.map((target) => [legacyTargetKey(target), target]));
  const correlated = new Map<string, ClawHubSkillSecurityVerdictItem>();
  for (const item of items) {
    const requestedSlug = normalizeOptionalString(item.requestedSlug)?.toLowerCase();
    const requestedVersion = normalizeOptionalString(item.requestedVersion);
    const requestedOwnerHandle = normalizeOwnerHandle(item.requestedOwnerHandle);
    if (!requestedSlug || !requestedVersion) {
      throw new Error("ClawHub skill security verdict response omitted request identity.");
    }
    const target = requestedOwnerHandle
      ? byKey.get(
          targetKey({
            slug: requestedSlug,
            ownerHandle: requestedOwnerHandle,
            version: requestedVersion,
          }),
        )
      : byLegacyKey.get(legacyTargetKey({ slug: requestedSlug, version: requestedVersion }));
    if (!target || correlated.has(targetKey(target))) {
      throw new Error("ClawHub skill security verdict response could not be correlated safely.");
    }
    correlated.set(targetKey(target), item);
  }
  return correlated;
}

async function resolveOwnerQualifiedFallback(params: {
  target: ClawHubExactSkillSecurityTarget & { ownerHandle: string };
  baseUrl?: string;
  token?: string;
  skipAuth?: boolean;
  timeoutMs?: number;
}): Promise<ClawHubSkillSecurityVerdictItem> {
  const verification = await fetchClawHubSkillVerification({
    slug: params.target.slug,
    ownerHandle: params.target.ownerHandle,
    version: params.target.version,
    baseUrl: params.baseUrl,
    token: params.token,
    ...(params.skipAuth !== undefined ? { skipAuth: params.skipAuth } : {}),
    timeoutMs: params.timeoutMs,
  });
  return mapVerificationToVerdict({ verification, target: params.target });
}

export async function fetchExactClawHubSkillSecurityVerdicts(
  params: FetchExactSkillSecurityParams,
): Promise<ClawHubSkillSecurityVerdictItem[]> {
  const targets = params.items.map(normalizeTarget);
  const keys = new Set<string>();
  for (const target of targets) {
    const key = targetKey(target);
    if (keys.has(key)) {
      throw new Error("ClawHub skill security verdict request contains duplicate targets.");
    }
    keys.add(key);
  }

  const resolved = new Map<string, ClawHubSkillSecurityVerdictItem>();
  for (const batch of partitionCompatibleBatches(targets)) {
    const response = await fetchClawHubSkillSecurityVerdicts({
      items: batch,
      baseUrl: params.baseUrl,
      token: params.token,
      ...(params.skipAuth !== undefined ? { skipAuth: params.skipAuth } : {}),
      timeoutMs: params.timeoutMs,
    });
    const correlated = correlateBatchItems(batch, response.items);
    const fallbackLimit = pLimit(OWNER_QUALIFIED_FALLBACK_CONCURRENCY);
    const resolvedBatch = await Promise.all(
      batch.map(async (target) => {
        const key = targetKey(target);
        const item = correlated.get(key);
        if (!item) {
          throw new Error("ClawHub skill security verdict response omitted a target.");
        }
        const ownerHandle = target.ownerHandle;
        const fallbackItem =
          ownerHandle && item.error?.code === "skill_not_found"
            ? await fallbackLimit(() =>
                resolveOwnerQualifiedFallback({
                  target: { ...target, ownerHandle },
                  baseUrl: params.baseUrl,
                  token: params.token,
                  ...(params.skipAuth !== undefined ? { skipAuth: params.skipAuth } : {}),
                  timeoutMs: params.timeoutMs,
                }),
              )
            : item;
        return [key, validateVerdictIdentity(target, fallbackItem)] as const;
      }),
    );
    for (const [key, item] of resolvedBatch) {
      resolved.set(key, item);
    }
  }
  return targets.map((target) => {
    const item = resolved.get(targetKey(target));
    if (!item) {
      throw new Error("ClawHub skill security verdict resolution omitted a target.");
    }
    return item;
  });
}
