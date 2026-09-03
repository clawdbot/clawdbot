import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
// Merges gateway provider signals (auth status, live usage/quota, local session
// cost) into one card list for the Models settings page.
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
  ModelCatalogProviderOutcome,
} from "../../api/types.ts";
import { providerDisplayLabel } from "../../components/provider-icon.ts";
import {
  canonicalModelAuthProviderId,
  isMonitoredAuthProvider,
  listEffectiveModelAuthProviders,
} from "../../lib/model-auth.ts";

export type ModelProviderAuthKind = "ok" | "expiring" | "expired" | "missing" | "api-key";

type ModelProviderAuthSummary = {
  kind: ModelProviderAuthKind;
  profileCount: number;
  expiryLabel?: string;
  unavailableMessage?: string;
};

type ModelProviderLocalCost = {
  totalCost: number;
  totalTokens: number;
  sessionCount: number;
  missingCostEntries: number;
};

export type ModelProviderLogoutTarget = {
  provider: string;
  profileIds: string[];
};

export type ModelProviderAccessOption = NonNullable<
  NonNullable<ModelAuthStatusResult["providerCapabilities"]>[number]["accessOptions"]
>[number];

export type ModelProviderCard = {
  /** Canonical provider id used for icon + label lookup. */
  id: string;
  /** Exact config map key; provider ids are otherwise normalized for display/runtime use. */
  configKey?: string;
  configAuthMode?: string;
  apiKeySupported?: boolean;
  accessOptions: ModelProviderAccessOption[];
  /** Provider ids that own credentials merged into this card. */
  credentialProviderIds: string[];
  /** Saved profiles eligible for targeted logout. */
  logoutTargets: ModelProviderLogoutTarget[];
  displayName: string;
  auth?: ModelProviderAuthSummary;
  profiles: ModelAuthStatusProfile[];
  apiKey?: ModelAuthStatusProvider["apiKey"];
  hasConfigApiKey: boolean;
  modelCount: number;
  availableModelCount: number;
  runtimeAvailableModelCount: number;
  runtimeLabels: string[];
  catalogStatus?: ModelCatalogProviderOutcome["status"];
  /** Live provider-reported usage (quota windows, billing, cost history). */
  usage?: ProviderUsageSnapshot;
  /** Locally-computed session spend for the requested window. */
  localCost?: ModelProviderLocalCost;
};

export type ModelProviderCardState = {
  status: "auth" | "denied" | "unavailable" | "ready" | "not-set-up" | "available" | "configured";
  sortTier: "active" | "inactive";
  verified: boolean;
  /** Provider holds a credential, regardless of whether the catalog verified it. */
  configured: boolean;
  message?: string;
};

type ModelProviderCardsInput = {
  authStatus: ModelAuthStatusResult | null;
  models: ModelCatalogEntry[] | null;
  providerOutcomes?: ModelCatalogProviderOutcome[];
  configProviderIds?: string[] | null;
  configApiKeyProviderIds?: string[] | null;
  configProviderAuthModes?: Record<string, string> | null;
  providerUsage: UsageSummary | null;
  costByProvider: SessionModelUsage[] | null;
};

type CardDraft = {
  ids: Set<string>;
  card: ModelProviderCard;
  hasModelAuth: boolean;
};

// Canonicalize alias provider ids (claude-cli → anthropic, minimax-* →
// minimax) with the same table the gateway uses, so one subscription stays
// one card even when the optional auth-status usage embed is missing.
function canonicalProviderId(provider: string): string {
  return canonicalModelAuthProviderId(provider);
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

export function classifyModelProviderCard(card: ModelProviderCard): ModelProviderCardState {
  const configured = card.hasConfigApiKey || Boolean(card.apiKey) || card.profiles.length > 0;
  if (card.catalogStatus === "auth-rejected") {
    return { status: "denied", sortTier: "inactive", verified: false, configured };
  }
  if (card.auth?.unavailableMessage) {
    return {
      status: "unavailable",
      sortTier: "inactive",
      verified: false,
      configured,
      message: card.auth.unavailableMessage,
    };
  }
  if (card.auth?.kind === "expired" || card.auth?.kind === "missing") {
    return { status: "auth", sortTier: "inactive", verified: false, configured };
  }
  if (card.auth?.kind === "expiring") {
    return { status: "auth", sortTier: "active", verified: false, configured };
  }
  const hasActiveAuth = card.auth?.kind === "ok" || card.auth?.kind === "api-key";
  if (card.catalogStatus === "unavailable") {
    return {
      status: "unavailable",
      sortTier: hasActiveAuth ? "active" : "inactive",
      verified: false,
      configured,
    };
  }
  const verified = card.catalogStatus === "ready" || card.runtimeAvailableModelCount > 0;
  if (verified) {
    return {
      status: card.availableModelCount > 0 ? "ready" : "available",
      sortTier: "active",
      verified: true,
      configured,
    };
  }
  return {
    status: configured ? "configured" : "not-set-up",
    sortTier: hasActiveAuth ? "active" : "inactive",
    verified: false,
    configured,
  };
}

function compareProviderCards(left: ModelProviderCard, right: ModelProviderCard): number {
  const leftTier = classifyModelProviderCard(left).sortTier;
  const rightTier = classifyModelProviderCard(right).sortTier;
  return (
    Number(rightTier === "active") - Number(leftTier === "active") ||
    left.displayName.localeCompare(right.displayName) ||
    left.id.localeCompare(right.id)
  );
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
      accessOptions: [],
      hasConfigApiKey: false,
      modelCount: 0,
      availableModelCount: 0,
      runtimeAvailableModelCount: 0,
      runtimeLabels: [],
    },
    hasModelAuth: false,
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
 * has an auth row, explicit provider config, a live usage snapshot, or recorded
 * local spend. Catalog rows and outcomes only decorate those providers. They
 * never turn the provider universe into configured accounts.
 * Manifest capabilities decorate qualified cards; Connect owns providers that
 * have no configured or observed state yet.
 */
export function buildModelProviderCards(input: ModelProviderCardsInput): ModelProviderCard[] {
  const drafts: CardDraft[] = [];
  const apiKeyCapabilities = new Map<string, boolean>();
  const accessOptionsByProvider = new Map<string, ModelProviderAccessOption[]>();
  for (const capability of input.authStatus?.providerCapabilities ?? []) {
    const id = canonicalProviderId(capability.provider);
    if (!id) {
      continue;
    }
    apiKeyCapabilities.set(id, apiKeyCapabilities.get(id) === true || capability.apiKeySupported);
    if (capability.accessOptions?.length) {
      const accessOptions = accessOptionsByProvider.get(id) ?? [];
      for (const option of capability.accessOptions) {
        if (!accessOptions.some((candidate) => candidate.id === option.id)) {
          accessOptions.push(option);
        }
      }
      accessOptionsByProvider.set(id, accessOptions);
    }
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

  const outcomeSeverity: ReadonlyArray<ModelCatalogProviderOutcome["status"]> = [
    "auth-rejected",
    "unavailable",
    "ready",
  ];
  for (const outcome of input.providerOutcomes ?? []) {
    const id = canonicalProviderId(outcome.provider);
    if (!id) {
      continue;
    }
    const card = ensureDraft(drafts, id, providerDisplayLabel(id)).card;
    if (
      !card.catalogStatus ||
      outcomeSeverity.indexOf(outcome.status) < outcomeSeverity.indexOf(card.catalogStatus)
    ) {
      card.catalogStatus = outcome.status;
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
      const runtimeId = normalizeProviderId(entry.agentRuntime?.id ?? "");
      if (runtimeId && runtimeId !== "auto" && runtimeId !== "openclaw") {
        draft.card.runtimeAvailableModelCount += 1;
        const label = providerDisplayLabel(runtimeId);
        if (!draft.card.runtimeLabels.includes(label)) {
          draft.card.runtimeLabels.push(label);
        }
      }
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
    // Generic auth discovery also includes tool-only API keys; those alone do not make a model card.
    draft.hasModelAuth ||= isMonitoredAuthProvider(provider) || apiKeyCapabilities.has(id);
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

  for (const provider of listEffectiveModelAuthProviders(input.authStatus?.providers ?? [])) {
    const draft = findDraft(drafts, [canonicalProviderId(provider.provider)]);
    if (draft) {
      const unresolvedApiKey = provider.profiles.find(
        (profile) =>
          profile.type === "api_key" &&
          profile.reasonCode === "unresolved_ref" &&
          profile.secretRef,
      );
      draft.card.auth = {
        kind: authKindForProvider(provider),
        profileCount: provider.profiles.length,
        ...(provider.expiry?.label ? { expiryLabel: provider.expiry.label } : {}),
        ...(unresolvedApiKey?.secretRef
          ? {
              unavailableMessage: `API key reference not found: ${unresolvedApiKey.secretRef.source} ${unresolvedApiKey.secretRef.id}`,
            }
          : {}),
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
      missingCostEntries: entry.totals.missingCostEntries,
    };
    const current = draft.card.localCost;
    draft.card.localCost = current
      ? {
          totalCost: current.totalCost + addition.totalCost,
          totalTokens: current.totalTokens + addition.totalTokens,
          sessionCount: current.sessionCount + addition.sessionCount,
          missingCostEntries: current.missingCostEntries + addition.missingCostEntries,
        }
      : addition;
  }

  return drafts
    .filter(
      (draft) =>
        draft.hasModelAuth ||
        (input.configProviderIds ?? []).some((id) => canonicalProviderId(id) === draft.card.id) ||
        Boolean(draft.card.usage) ||
        (draft.card.localCost?.totalTokens ?? 0) > 0,
    )
    .map((draft) => {
      const apiKeySupported = apiKeyCapabilities.get(draft.card.id);
      const accessOptions = accessOptionsByProvider.get(draft.card.id);
      return Object.assign(
        {},
        draft.card,
        accessOptions ? { accessOptions } : {},
        apiKeySupported === undefined ? {} : { apiKeySupported },
      );
    })
    .toSorted(compareProviderCards);
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
  // An unavailable catalog cannot establish that a saved model is unavailable.
  const availability = models === null ? {} : { available: false as const };
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
        ...(match ?? { provider: "", id: ref, name: ref, ...availability }),
        selectionRef: ref,
      });
      continue;
    }
    selectable.push({
      provider: ref.slice(0, slash),
      id: ref.slice(slash + 1),
      name: ref,
      ...availability,
    });
  }
  return selectable;
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
