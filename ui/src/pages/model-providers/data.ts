import { resolveUsageProviderId } from "../../../../src/infra/provider-usage.shared.js";
// Merges gateway provider signals (auth status, live usage/quota, local session
// cost) into one card list for the Model Providers settings page.
import type {
  ProviderUsageSnapshot,
  UsageSummary,
} from "../../../../src/infra/provider-usage.types.js";
import type { SessionModelUsage } from "../../../../src/infra/session-cost-usage.types.js";
import type {
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
  ModelCatalogEntry,
} from "../../api/types.ts";
import { providerDisplayLabel } from "../../components/provider-icon.ts";

export type ModelProviderAuthKind = "ok" | "expiring" | "expired" | "missing" | "api-key";

export type ModelProviderAuthSummary = {
  kind: ModelProviderAuthKind;
  profileCount: number;
  expiryLabel?: string;
};

export type ModelProviderLocalCost = {
  totalCost: number;
  totalTokens: number;
  sessionCount: number;
};

export type ModelProviderCard = {
  /** Canonical provider id used for icon + label lookup. */
  id: string;
  displayName: string;
  auth?: ModelProviderAuthSummary;
  modelCount: number;
  availableModelCount: number;
  /** Live provider-reported usage (quota windows, billing, cost history). */
  usage?: ProviderUsageSnapshot;
  /** Locally-computed session spend for the requested window. */
  localCost?: ModelProviderLocalCost;
};

export type ModelProviderCardsInput = {
  authStatus: ModelAuthStatusResult | null;
  models: ModelCatalogEntry[] | null;
  providerUsage: UsageSummary | null;
  costByProvider: SessionModelUsage[] | null;
};

type CardDraft = {
  ids: Set<string>;
  card: ModelProviderCard;
  hasAuthRow: boolean;
  /** True when usage came from usage.status (richer than the auth-status embed). */
  hasUsageSnapshot: boolean;
};

// Canonicalize alias provider ids (claude-cli → anthropic, minimax-* →
// minimax) with the same table the gateway uses, so one subscription stays
// one card even when the optional auth-status usage embed is missing.
function canonicalProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return resolveUsageProviderId(normalized) ?? normalized;
}

function authKindForProvider(provider: ModelAuthStatusProvider): ModelProviderAuthKind {
  switch (provider.status) {
    case "ok":
    case "expiring":
    case "expired":
    case "missing":
      return provider.status;
    default:
      return "api-key";
  }
}

const AUTH_KIND_SEVERITY: readonly ModelProviderAuthKind[] = [
  "expired",
  "missing",
  "expiring",
  "ok",
  "api-key",
];

// Two auth rows can share one card (provider alias ids); surface the most
// urgent credential state and the combined profile count.
function mergeAuth(
  current: ModelProviderAuthSummary | undefined,
  next: ModelProviderAuthSummary,
): ModelProviderAuthSummary {
  if (!current) {
    return next;
  }
  const worse =
    AUTH_KIND_SEVERITY.indexOf(next.kind) < AUTH_KIND_SEVERITY.indexOf(current.kind)
      ? next
      : current;
  return {
    kind: worse.kind,
    profileCount: current.profileCount + next.profileCount,
    ...(worse.expiryLabel ? { expiryLabel: worse.expiryLabel } : {}),
  };
}

function findDraft(drafts: CardDraft[], ids: string[]): CardDraft | undefined {
  return drafts.find((draft) => ids.some((id) => draft.ids.has(id)));
}

function ensureDraft(drafts: CardDraft[], id: string, displayName: string): CardDraft {
  const existing = findDraft(drafts, [id]);
  if (existing) {
    return existing;
  }
  const draft: CardDraft = {
    ids: new Set([id]),
    card: { id, displayName, modelCount: 0, availableModelCount: 0 },
    hasAuthRow: false,
    hasUsageSnapshot: false,
  };
  drafts.push(draft);
  return draft;
}

/**
 * Builds the provider card list. A provider qualifies as "configured" when it
 * has an auth row, catalog models (the default models.list view only contains
 * configured or auth-backed entries), a live usage snapshot, or recorded
 * local spend. Model presence alone is enough: a configured API-key provider
 * with a broken credential reports available=false and no auth row, and the
 * page must surface that state rather than hide the provider.
 */
export function buildModelProviderCards(input: ModelProviderCardsInput): ModelProviderCard[] {
  const drafts: CardDraft[] = [];

  for (const entry of input.models ?? []) {
    const id = canonicalProviderId(entry.provider);
    if (!id) {
      continue;
    }
    const draft = ensureDraft(drafts, id, providerDisplayLabel(id));
    draft.card.modelCount += 1;
    if (entry.available === true) {
      draft.card.availableModelCount += 1;
    }
  }

  for (const provider of input.authStatus?.providers ?? []) {
    const id = canonicalProviderId(provider.provider);
    if (!id) {
      continue;
    }
    // The usage embed names the id the payload was fetched under; keep both
    // ids matchable in case it diverges from the static alias table.
    const canonicalId = provider.usage ? canonicalProviderId(provider.usage.providerId) : id;
    const ids = [...new Set([id, canonicalId])];
    const existing = findDraft(drafts, ids);
    // Fresh cards adopt the canonical usage id so icon/label lookups resolve
    // brand assets (claude-cli would miss the anthropic icon alias).
    const draft = existing ?? ensureDraft(drafts, canonicalId, providerDisplayLabel(canonicalId));
    for (const candidate of ids) {
      draft.ids.add(candidate);
    }
    draft.card.displayName = provider.displayName || draft.card.displayName;
    draft.card.auth = mergeAuth(draft.hasAuthRow ? draft.card.auth : undefined, {
      kind: authKindForProvider(provider),
      profileCount: provider.profiles.length,
      ...(provider.expiry?.label ? { expiryLabel: provider.expiry.label } : {}),
    });
    draft.hasAuthRow = true;
    const usage = provider.usage;
    if (usage && !draft.card.usage) {
      draft.card.usage = {
        provider: usage.providerId,
        displayName: provider.displayName,
        windows: usage.windows,
        ...(usage.summary ? { summary: usage.summary } : {}),
        ...(usage.plan ? { plan: usage.plan } : {}),
        ...(usage.billing?.length ? { billing: usage.billing } : {}),
      };
    }
  }

  for (const snapshot of input.providerUsage?.providers ?? []) {
    const id = canonicalProviderId(snapshot.provider);
    if (!id) {
      continue;
    }
    const draft =
      findDraft(drafts, [id]) ??
      ensureDraft(drafts, id, snapshot.displayName || providerDisplayLabel(id));
    draft.ids.add(id);
    // usage.status snapshots carry cost history and errors that the
    // auth-status embed drops, so they win when both are present.
    draft.card.usage = snapshot;
    draft.hasUsageSnapshot = true;
  }

  for (const entry of input.costByProvider ?? []) {
    const id = canonicalProviderId(entry.provider ?? "");
    if (!id) {
      continue;
    }
    const draft = findDraft(drafts, [id]) ?? ensureDraft(drafts, id, providerDisplayLabel(id));
    const addition: ModelProviderLocalCost = {
      totalCost: entry.totals.totalCost,
      totalTokens: entry.totals.totalTokens,
      sessionCount: entry.count,
    };
    const current = draft.card.localCost;
    draft.card.localCost = current
      ? {
          totalCost: current.totalCost + addition.totalCost,
          totalTokens: current.totalTokens + addition.totalTokens,
          sessionCount: current.sessionCount + addition.sessionCount,
        }
      : addition;
  }

  return drafts
    .filter(
      (draft) =>
        draft.hasAuthRow ||
        draft.hasUsageSnapshot ||
        Boolean(draft.card.usage) ||
        draft.card.modelCount > 0 ||
        (draft.card.localCost?.totalTokens ?? 0) > 0,
    )
    .map((draft) => draft.card)
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));
}
