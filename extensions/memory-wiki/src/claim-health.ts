import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WikiClaim, WikiPageSummary } from "./markdown.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const WIKI_AGING_DAYS = 30;
const WIKI_STALE_DAYS = 90;

const CONTESTED_CLAIM_STATUSES = new Set(["contested", "contradicted", "refuted", "superseded"]);

export type WikiFreshnessLevel = "fresh" | "aging" | "stale" | "unknown";

export type WikiFreshness = {
  level: WikiFreshnessLevel;
  reason: string;
  daysSinceTouch?: number;
  lastTouchedAt?: string;
};

export type WikiClaimHealth = {
  key: string;
  pagePath: string;
  pageTitle: string;
  pageId?: string;
  claimId?: string;
  text: string;
  status: string;
  confidence?: number;
  evidenceCount: number;
  missingEvidence: boolean;
  freshness: WikiFreshness;
};

export type WikiClaimContradictionCluster = {
  key: string;
  label: string;
  entries: WikiClaimHealth[];
};

export type WikiPageContradictionCluster = {
  key: string;
  label: string;
  entries: Array<{
    pagePath: string;
    pageTitle: string;
    pageId?: string;
    note: string;
  }>;
};

function parseTimestamp(value?: string): number | null {
  if (!value?.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampDaysSinceTouch(daysSinceTouch: number): number {
  return Math.max(0, daysSinceTouch);
}

function normalizeClaimTextKey(text: string): string {
  return normalizeLowercaseStringOrEmpty(text.replace(/\s+/g, " "));
}

function normalizeTextKey(text: string): string {
  return normalizeLowercaseStringOrEmpty(text)
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .replace(/\s+/g, " ");
}

function buildFreshnessFromTimestamp(params: { timestamp?: string; now?: Date }): WikiFreshness {
  const now = params.now ?? new Date();
  const timestampMs = parseTimestamp(params.timestamp);
  if (timestampMs === null || !params.timestamp) {
    return {
      level: "unknown",
      reason: "missing updatedAt",
    };
  }
  const daysSinceTouch = clampDaysSinceTouch(Math.floor((now.getTime() - timestampMs) / DAY_MS));
  if (daysSinceTouch >= WIKI_STALE_DAYS) {
    return {
      level: "stale",
      reason: `last touched ${params.timestamp}`,
      daysSinceTouch,
      lastTouchedAt: params.timestamp,
    };
  }
  if (daysSinceTouch >= WIKI_AGING_DAYS) {
    return {
      level: "aging",
      reason: `last touched ${params.timestamp}`,
      daysSinceTouch,
      lastTouchedAt: params.timestamp,
    };
  }
  return {
    level: "fresh",
    reason: `last touched ${params.timestamp}`,
    daysSinceTouch,
    lastTouchedAt: params.timestamp,
  };
}

function resolveLatestTimestamp(candidates: Array<string | undefined>): string | undefined {
  let bestValue: string | undefined;
  let bestMs = -1;
  for (const candidate of candidates) {
    const parsed = parseTimestamp(candidate);
    if (parsed === null || !candidate || parsed <= bestMs) {
      continue;
    }
    bestMs = parsed;
    bestValue = candidate;
  }
  return bestValue;
}

export function normalizeClaimStatus(status?: string): string {
  return normalizeLowercaseStringOrEmpty(status) || "supported";
}

export function isClaimContestedStatus(status?: string): boolean {
  return CONTESTED_CLAIM_STATUSES.has(normalizeClaimStatus(status));
}

export function assessPageFreshness(page: WikiPageSummary, now?: Date): WikiFreshness {
  return buildFreshnessFromTimestamp({ timestamp: page.updatedAt, now });
}

export function assessClaimFreshness(params: {
  page: WikiPageSummary;
  claim: WikiClaim;
  now?: Date;
}): WikiFreshness {
  const latestTimestamp = resolveLatestTimestamp([
    params.claim.updatedAt,
    params.page.updatedAt,
    ...params.claim.evidence.map((evidence) => evidence.updatedAt),
  ]);
  return buildFreshnessFromTimestamp({ timestamp: latestTimestamp, now: params.now });
}

function buildWikiClaimHealth(params: {
  page: WikiPageSummary;
  claim: WikiClaim;
  index: number;
  now?: Date;
}): WikiClaimHealth {
  const claimId = params.claim.id?.trim();
  return {
    key: `${params.page.relativePath}#${claimId ?? `claim-${params.index + 1}`}`,
    pagePath: params.page.relativePath,
    pageTitle: params.page.title,
    ...(params.page.id ? { pageId: params.page.id } : {}),
    ...(claimId ? { claimId } : {}),
    text: params.claim.text,
    status: normalizeClaimStatus(params.claim.status),
    ...(typeof params.claim.confidence === "number" ? { confidence: params.claim.confidence } : {}),
    evidenceCount: params.claim.evidence.length,
    missingEvidence: params.claim.evidence.length === 0,
    freshness: assessClaimFreshness({ page: params.page, claim: params.claim, now: params.now }),
  };
}

export function collectWikiClaimHealth(pages: WikiPageSummary[], now?: Date): WikiClaimHealth[] {
  return pages.flatMap((page) =>
    page.claims.map((claim, index) => buildWikiClaimHealth({ page, claim, index, now })),
  );
}

export function buildClaimContradictionClusters(params: {
  pages: WikiPageSummary[];
  now?: Date;
}): WikiClaimContradictionCluster[] {
  const claimHealth = collectWikiClaimHealth(params.pages, params.now);
  const byId = new Map<string, WikiClaimHealth[]>();
  for (const claim of claimHealth) {
    if (!claim.claimId) {
      continue;
    }
    const current = byId.get(claim.claimId) ?? [];
    current.push(claim);
    byId.set(claim.claimId, current);
  }

  return [...byId.entries()]
    .flatMap(([claimId, entries]) => {
      if (entries.length < 2) {
        return [];
      }
      const distinctTexts = new Set(entries.map((entry) => normalizeClaimTextKey(entry.text)));
      const distinctStatuses = new Set(entries.map((entry) => entry.status));
      if (distinctTexts.size < 2 && distinctStatuses.size < 2) {
        return [];
      }
      return [
        {
          key: claimId,
          label: claimId,
          entries: [...entries].toSorted((left, right) =>
            left.pagePath.localeCompare(right.pagePath),
          ),
        },
      ];
    })
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

export function buildPageContradictionClusters(
  pages: WikiPageSummary[],
): WikiPageContradictionCluster[] {
  const byNote = new Map<string, WikiPageContradictionCluster["entries"]>();
  for (const page of pages) {
    for (const note of page.contradictions) {
      const key = normalizeTextKey(note);
      if (!key) {
        continue;
      }
      const current = byNote.get(key) ?? [];
      current.push({
        pagePath: page.relativePath,
        pageTitle: page.title,
        ...(page.id ? { pageId: page.id } : {}),
        note,
      });
      byNote.set(key, current);
    }
  }
  return [...byNote.entries()]
    .map(([key, entries]) => ({
      key,
      label: entries[0]?.note ?? key,
      entries: [...entries].toSorted((left, right) => left.pagePath.localeCompare(right.pagePath)),
    }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
}
