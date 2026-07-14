import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
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
  ModelAuthStatusProfile,
  ModelAuthStatusResult,
  ModelCatalogEntry,
} from "../../api/types.ts";
import { providerDisplayLabel } from "../../components/provider-icon.ts";

export type ModelProviderAuthKind = "ok" | "expiring" | "expired" | "missing" | "api-key";

type ModelProviderAuthSummary = {
  kind: ModelProviderAuthKind;
  profileCount: number;
  expiryLabel?: string;
};

type ModelProviderLocalCost = {
  totalCost: number;
  totalTokens: number;
  sessionCount: number;
};

export type ModelProviderLogoutTarget = {
  provider: string;
  profileIds: string[];
};

export type ModelProviderCard = {
  /** Canonical provider id used for icon + label lookup. */
  id: string;
  /** Exact config map key; provider ids are otherwise normalized for display/runtime use. */
  configKey?: string;
  configAuthMode?: string;
  apiKeySupported?: boolean;
  /** Provider ids that own credentials merged into this card. */
  credentialProviderIds: string[];
  /** Saved OAuth/token profiles eligible for targeted logout. */
  logoutTargets: ModelProviderLogoutTarget[];
  displayName: string;
  auth?: ModelProviderAuthSummary;
  profiles: ModelAuthStatusProfile[];
  apiKey?: ModelAuthStatusProvider["apiKey"];
  hasConfigApiKey: boolean;
  modelCount: number;
  availableModelCount: number;
  /** Live provider-reported usage (quota windows, billing, cost history). */
  usage?: ProviderUsageSnapshot;
  /** Locally-computed session spend for the requested window. */
  localCost?: ModelProviderLocalCost;
};

type ModelProviderCardsInput = {
  authStatus: ModelAuthStatusResult | null;
  models: ModelCatalogEntry[] | null;
  catalogModels?: ModelCatalogEntry[] | null;
  configProviderIds?: string[] | null;
  configApiKeyProviderIds?: string[] | null;
  configProviderAuthModes?: Record<string, string> | null;
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
    card: {
      id,
      displayName,
      profiles: [],
      credentialProviderIds: [],
      logoutTargets: [],
      hasConfigApiKey: false,
      modelCount: 0,
      availableModelCount: 0,
    },
    hasAuthRow: false,
    hasUsageSnapshot: false,
  };
  drafts.push(draft);
  return draft;
}

function addProviderId(ids: string[], provider: string): void {
  const normalized = normalizeProviderId(provider);
  if (normalized && !ids.some((candidate) => normalizeProviderId(candidate) === normalized)) {
    ids.push(provider);
  }
}

function addLogoutTarget(
  targets: ModelProviderLogoutTarget[],
  provider: string,
  profileIds: string[],
): void {
  if (profileIds.length === 0) {
    return;
  }
  const normalized = normalizeProviderId(provider);
  const existing = targets.find(
    (candidate) => normalizeProviderId(candidate.provider) === normalized,
  );
  if (!existing) {
    targets.push({ provider, profileIds: [...new Set(profileIds)] });
    return;
  }
  existing.profileIds = [...new Set([...existing.profileIds, ...profileIds])];
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
  const apiKeyCapabilities = new Map<string, boolean>();
  for (const entry of input.catalogModels ?? []) {
    const id = canonicalProviderId(entry.provider);
    if (!id || entry.apiKeySupported === undefined) {
      continue;
    }
    apiKeyCapabilities.set(id, apiKeyCapabilities.get(id) === true || entry.apiKeySupported);
  }

  for (const provider of input.configProviderIds ?? []) {
    const id = canonicalProviderId(provider);
    if (id) {
      ensureDraft(drafts, id, providerDisplayLabel(id)).card.configKey ??= provider;
    }
  }
  for (const provider of input.configApiKeyProviderIds ?? []) {
    const id = canonicalProviderId(provider);
    if (id) {
      const card = ensureDraft(drafts, id, providerDisplayLabel(id)).card;
      card.configKey = provider;
      card.hasConfigApiKey = true;
      addProviderId(card.credentialProviderIds, provider);
    }
  }
  for (const [provider, authMode] of Object.entries(input.configProviderAuthModes ?? {})) {
    const id = canonicalProviderId(provider);
    if (id) {
      ensureDraft(drafts, id, providerDisplayLabel(id)).card.configAuthMode = authMode;
    }
  }

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
    draft.card.profiles.push(...provider.profiles);
    if (provider.apiKey || provider.profiles.length > 0) {
      addProviderId(draft.card.credentialProviderIds, provider.provider);
    }
    addLogoutTarget(
      draft.card.logoutTargets,
      provider.provider,
      provider.profiles
        .filter((profile) => profile.logoutSupported === true)
        .map((profile) => profile.profileId),
    );
    draft.card.apiKey ??= provider.apiKey;
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
        (input.configProviderIds ?? []).some((id) => canonicalProviderId(id) === draft.card.id) ||
        draft.hasUsageSnapshot ||
        Boolean(draft.card.usage) ||
        draft.card.modelCount > 0 ||
        (draft.card.localCost?.totalTokens ?? 0) > 0,
    )
    .map((draft) => {
      const apiKeySupported = apiKeyCapabilities.get(draft.card.id);
      return Object.assign(
        {},
        draft.card,
        apiKeySupported === undefined ? {} : { apiKeySupported },
      );
    })
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));
}

export type DefaultModelSelection = {
  primary: string;
  fallbacks: string[];
  /** null = automatic/unset; empty string = explicitly disabled. */
  utilityModel: string | null;
};

export type ModelPickerEntry = ModelCatalogEntry & { selectionRef?: string };

export function modelCatalogRef(model: ModelPickerEntry): string {
  if (model.selectionRef !== undefined) {
    return model.selectionRef;
  }
  return model.id.startsWith(`${model.provider}/`) ? model.id : `${model.provider}/${model.id}`;
}

export function buildSelectableDefaultModels(
  models: ModelCatalogEntry[] | null,
  selection: DefaultModelSelection,
): ModelPickerEntry[] {
  const selected = new Set<string>(
    [selection.primary, ...selection.fallbacks, selection.utilityModel].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  const selectable: ModelPickerEntry[] = (models ?? []).filter(
    (model) => model.available !== false || selected.has(modelCatalogRef(model)),
  );
  const seen = new Set(selectable.map(modelCatalogRef));
  for (const ref of selected) {
    if (seen.has(ref)) {
      continue;
    }
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) {
      const normalized = ref.trim().toLowerCase();
      const match = (models ?? []).find(
        (model) =>
          model.alias?.trim().toLowerCase() === normalized || model.id.trim() === ref.trim(),
      );
      selectable.push({
        ...(match ?? { provider: "", id: ref, name: ref, available: false }),
        selectionRef: ref,
      });
      continue;
    }
    selectable.push({
      provider: ref.slice(0, slash),
      id: ref.slice(slash + 1),
      name: ref,
      available: false,
    });
  }
  return selectable;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readModelProviderConfig(config: Record<string, unknown> | null): {
  providerIds: string[];
  apiKeyProviderIds: string[];
  providerAuthModes: Record<string, string>;
  defaults: DefaultModelSelection;
} {
  const models = asRecord(config?.models);
  const providers = asRecord(models?.providers);
  const agents = asRecord(config?.agents);
  const defaults = asRecord(agents?.defaults);
  const model = defaults?.model;
  const modelObject = asRecord(model);
  const primary =
    typeof model === "string"
      ? model
      : typeof modelObject?.primary === "string"
        ? modelObject.primary
        : "";
  const fallbacks = Array.isArray(modelObject?.fallbacks)
    ? modelObject.fallbacks.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    providerIds: Object.keys(providers ?? {}),
    apiKeyProviderIds: Object.entries(providers ?? {})
      .filter(([, value]) => {
        const provider = asRecord(value);
        return provider ? Object.hasOwn(provider, "apiKey") && provider.apiKey != null : false;
      })
      .map(([id]) => id),
    providerAuthModes: Object.fromEntries(
      Object.entries(providers ?? {}).flatMap(([id, value]) => {
        const auth = asRecord(value)?.auth;
        return typeof auth === "string" ? [[id, auth]] : [];
      }),
    ),
    defaults: {
      primary,
      fallbacks,
      utilityModel: typeof defaults?.utilityModel === "string" ? defaults.utilityModel : null,
    },
  };
}

export type ProviderOption = { id: string; displayName: string };

export function buildUnconfiguredProviderOptions(
  models: ModelCatalogEntry[] | null,
  configuredProviderIds: Iterable<string>,
): ProviderOption[] {
  const configured = new Set(Array.from(configuredProviderIds, canonicalProviderId));
  const options = new Map<string, ProviderOption>();
  for (const model of models ?? []) {
    const id = canonicalProviderId(model.provider);
    if (model.apiKeySupported === true && id && !configured.has(id) && !options.has(id)) {
      options.set(id, { id, displayName: providerDisplayLabel(id) });
    }
  }
  return [...options.values()].toSorted((a, b) => a.displayName.localeCompare(b.displayName));
}
