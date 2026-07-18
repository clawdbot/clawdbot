import pLimit from "p-limit";
import { z } from "zod";
import { searchClawHubSkills } from "../infra/clawhub.js";
import type { InstalledAppsResult } from "../infra/installed-apps.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalChannelCatalogEntries,
  listOfficialExternalPluginCatalogEntries,
  listOfficialExternalProviderCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginLabel,
  type OfficialExternalPluginCatalogEntry,
} from "../plugins/official-external-plugin-catalog.js";
import type { RuntimeEnv } from "../runtime.js";
import type { OnboardingRecommendationMatch } from "../state/onboarding-recommendations.js";
import { completeSetupInference } from "./setup-inference.js";

const CLAWHUB_SEARCH_CONCURRENCY = 4;
const CLAWHUB_SEARCH_LIMIT = 3;
const CLAWHUB_SEARCH_TIMEOUT_MS = 5_000;
// Overall budget for the ClawHub phase: with per-request timeouts an
// unreachable host would otherwise stall onboarding ~(apps/4)*5s. Apps past
// the deadline keep their official-catalog candidates and skip hub search.
const CLAWHUB_SEARCH_TOTAL_BUDGET_MS = 20_000;
const CANDIDATE_SOURCE_ORDER: Record<SetupAppCandidateSource, number> = {
  "official-plugin": 0,
  "official-channel": 1,
  "official-provider": 2,
  "clawhub-skill": 3,
};

type SetupAppInventoryItem = {
  label: string;
  bundleId?: string;
};

type SetupAppCandidateSource =
  | "official-plugin"
  | "official-channel"
  | "official-provider"
  | "clawhub-skill";

type SetupAppCandidate = {
  id: string;
  displayName: string;
  summary: string;
  source: SetupAppCandidateSource;
  downloads?: number;
};

type SetupAppCandidateGroup = {
  app: SetupAppInventoryItem;
  candidates: SetupAppCandidate[];
};

export type SetupAppRecommendationMatch = OnboardingRecommendationMatch;

export type SetupAppRecommendationsResult =
  | {
      status: "ok";
      apps: SetupAppInventoryItem[];
      groups: SetupAppCandidateGroup[];
      matches: SetupAppRecommendationMatch[];
    }
  | {
      status: "skipped";
      reason: "unsupported" | "no-apps" | "no-candidates" | "model-failed" | "no-matches";
    };

// Tolerant on purpose: models add extra keys and overlong reasons; a strict
// schema here would turn one sloppy field into a feature-wide "model-failed".
const MatcherOutputSchema = z.object({
  matches: z.array(
    z.object({
      appLabel: z.string().trim().min(1),
      candidateId: z.string().trim().min(1),
      tier: z.enum(["recommended", "optional"]),
      reason: z
        .string()
        .trim()
        .min(1)
        .transform((value) => (value.length > 120 ? `${value.slice(0, 119)}…` : value)),
    }),
  ),
});

type RecommendationDeps = {
  listPlugins?: typeof listOfficialExternalPluginCatalogEntries;
  listChannels?: typeof listOfficialExternalChannelCatalogEntries;
  listProviders?: typeof listOfficialExternalProviderCatalogEntries;
  searchSkills?: typeof searchClawHubSkills;
  complete?: (prompt: string) => Promise<{ ok: true; text: string } | { ok: false }>;
};

function compareInventory(left: SetupAppInventoryItem, right: SetupAppInventoryItem): number {
  return (
    left.label.localeCompare(right.label, "en", { sensitivity: "base" }) ||
    (left.bundleId ?? "").localeCompare(right.bundleId ?? "")
  );
}

function normalizeInventory(apps: readonly SetupAppInventoryItem[]): SetupAppInventoryItem[] {
  const byLabel = new Map<string, SetupAppInventoryItem>();
  for (const app of apps.toSorted(compareInventory)) {
    const label = app.label.trim();
    if (!label) {
      continue;
    }
    const bundleId = app.bundleId?.trim();
    const key = label.toLocaleLowerCase("en-US");
    const existing = byLabel.get(key);
    if (!existing || (!existing.bundleId && bundleId)) {
      byLabel.set(key, { label, ...(bundleId ? { bundleId } : {}) });
    }
  }
  return [...byLabel.values()].toSorted(compareInventory);
}

function inventoryTokens(label: string): string[] {
  return label
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3)
    .toSorted();
}

function providerSearchTokens(
  manifest: ReturnType<typeof getOfficialExternalPluginCatalogManifest>,
): Array<string | undefined> {
  const tokens: Array<string | undefined> = [];
  for (const provider of manifest?.providers ?? []) {
    tokens.push(provider.id, provider.name);
    for (const alias of provider.aliases ?? []) {
      tokens.push(alias);
    }
  }
  return tokens;
}

function entrySearchText(entry: OfficialExternalPluginCatalogEntry): string {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return [
    entry.id,
    entry.name,
    entry.title,
    entry.description,
    manifest?.plugin?.id,
    manifest?.plugin?.label,
    manifest?.channel?.id,
    manifest?.channel?.label,
    ...providerSearchTokens(manifest),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLocaleLowerCase("en-US");
}

function entryMatchesApp(entry: OfficialExternalPluginCatalogEntry, appLabel: string): boolean {
  const appTokens = inventoryTokens(appLabel);
  const searchText = entrySearchText(entry);
  const entryTokens = inventoryTokens(searchText);
  return appTokens.some(
    (appToken) =>
      searchText.includes(appToken) ||
      entryTokens.some((entryToken) => appToken.includes(entryToken)),
  );
}

function officialCandidate(
  entry: OfficialExternalPluginCatalogEntry,
  source: Exclude<SetupAppCandidateSource, "clawhub-skill">,
): SetupAppCandidate | null {
  const id = resolveOfficialExternalPluginId(entry);
  if (!id) {
    return null;
  }
  return {
    id,
    displayName: resolveOfficialExternalPluginLabel(entry),
    summary: entry.description?.trim() || "Official OpenClaw plugin",
    source,
  };
}

function compareCandidates(left: SetupAppCandidate, right: SetupAppCandidate): number {
  return (
    CANDIDATE_SOURCE_ORDER[left.source] - CANDIDATE_SOURCE_ORDER[right.source] ||
    left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" }) ||
    left.id.localeCompare(right.id)
  );
}

function dedupeCandidates(candidates: SetupAppCandidate[]): SetupAppCandidate[] {
  const seen = new Set<string>();
  return candidates.toSorted(compareCandidates).filter((candidate) => {
    const key = candidate.id.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function gatherSetupAppCandidates(params: {
  apps: SetupAppInventoryItem[];
  deps?: RecommendationDeps;
}): Promise<SetupAppCandidateGroup[]> {
  const deps = params.deps ?? {};
  const channels = deps.listChannels?.() ?? listOfficialExternalChannelCatalogEntries();
  const providers = deps.listProviders?.() ?? listOfficialExternalProviderCatalogEntries();
  const allEntries = deps.listPlugins?.() ?? listOfficialExternalPluginCatalogEntries();
  // Catalog entries are package manifests without a stable top-level `id`;
  // key everything by the resolved plugin id or the map collapses to one
  // undefined-keyed entry and no official candidate is ever produced.
  const entryKey = (entry: OfficialExternalPluginCatalogEntry): string | undefined =>
    resolveOfficialExternalPluginId(entry) ?? entry.name;
  const channelIds = new Set(channels.map(entryKey));
  const providerIds = new Set(providers.map(entryKey));
  const entriesById = new Map(
    [...allEntries, ...channels, ...providers].flatMap((entry) => {
      const key = entryKey(entry);
      return key ? ([[key, entry]] as const) : [];
    }),
  );
  const officialEntries = [...entriesById.entries()].map(([key, entry]) => ({
    entry,
    source: channelIds.has(key)
      ? ("official-channel" as const)
      : providerIds.has(key)
        ? ("official-provider" as const)
        : ("official-plugin" as const),
  }));
  const searchSkills = deps.searchSkills ?? searchClawHubSkills;
  const searchLimit = pLimit(CLAWHUB_SEARCH_CONCURRENCY);
  const searchDeadline = Date.now() + CLAWHUB_SEARCH_TOTAL_BUDGET_MS;

  const groups = await Promise.all(
    normalizeInventory(params.apps).map(async (app): Promise<SetupAppCandidateGroup> => {
      const official = officialEntries.flatMap(({ entry, source }) => {
        if (!entryMatchesApp(entry, app.label)) {
          return [];
        }
        const candidate = officialCandidate(entry, source);
        return candidate ? [candidate] : [];
      });
      const skills = await searchLimit(async () => {
        if (Date.now() >= searchDeadline) {
          return [];
        }
        try {
          const results = await searchSkills({
            query: app.label.normalize("NFKC").trim(),
            limit: CLAWHUB_SEARCH_LIMIT,
            timeoutMs: CLAWHUB_SEARCH_TIMEOUT_MS,
          });
          return results.slice(0, CLAWHUB_SEARCH_LIMIT).map(
            (result): SetupAppCandidate => ({
              id: result.slug,
              displayName: result.displayName,
              summary: result.summary?.trim() || "ClawHub skill",
              source: "clawhub-skill",
            }),
          );
        } catch {
          return [];
        }
      });
      return { app, candidates: dedupeCandidates([...official, ...skills]) };
    }),
  );
  return groups.toSorted((left, right) => compareInventory(left.app, right.app));
}

// Models routinely wrap JSON in markdown fences or prose despite "JSON only"
// instructions; parse the outermost object instead of the raw text.
function parseMatcherJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildMatcherPrompt(groups: SetupAppCandidateGroup[]): string {
  const payload = groups.map((group) => ({
    app: group.app,
    candidates: group.candidates,
  }));
  return [
    "Match installed applications to genuinely related OpenClaw plugins or skills.",
    "Reject coincidental substring, brand, or name overlaps.",
    "Use tier recommended for messaging-channel integrations; otherwise choose recommended or optional by usefulness.",
    "Give a reason of at most 12 words.",
    'Return strict JSON only: {"matches":[{"appLabel":"...","candidateId":"...","tier":"recommended|optional","reason":"..."}]}.',
    JSON.stringify(payload),
  ].join("\n");
}

export async function getSetupAppRecommendations(params: {
  inventorySource: () => Promise<InstalledAppsResult | SetupAppInventoryItem[]>;
  runtime: RuntimeEnv;
  deps?: RecommendationDeps;
}): Promise<SetupAppRecommendationsResult> {
  const inventory = await params.inventorySource();
  if (!Array.isArray(inventory) && inventory.status === "unsupported") {
    return { status: "skipped", reason: "unsupported" };
  }
  const apps = normalizeInventory(
    Array.isArray(inventory)
      ? inventory
      : inventory.apps.map((app) => ({ label: app.label, bundleId: app.bundleId })),
  );
  if (apps.length === 0) {
    return { status: "skipped", reason: "no-apps" };
  }
  const groups = await gatherSetupAppCandidates({ apps, deps: params.deps });
  if (groups.every((group) => group.candidates.length === 0)) {
    return { status: "skipped", reason: "no-candidates" };
  }
  const complete =
    params.deps?.complete ??
    // Output is bounded by the resolved model's own maxTokens budget (the
    // stream layer applies it when no explicit cap is passed), so a runaway
    // completion cannot exceed what the model config already allows.
    (async (prompt: string) => await completeSetupInference({ prompt, runtime: params.runtime }));
  let completion: Awaited<ReturnType<typeof complete>>;
  try {
    completion = await complete(buildMatcherPrompt(groups));
  } catch {
    return { status: "skipped", reason: "model-failed" };
  }
  if (!completion.ok) {
    return { status: "skipped", reason: "model-failed" };
  }
  const parsed = MatcherOutputSchema.safeParse(parseMatcherJson(completion.text));
  if (!parsed.success) {
    return { status: "skipped", reason: "model-failed" };
  }
  // Case-insensitive lookups: models normalize label/id casing in their output.
  const matches = parsed.data.matches.flatMap((match): SetupAppRecommendationMatch[] => {
    const appKey = match.appLabel.toLocaleLowerCase("en-US");
    const candidateKey = match.candidateId.toLocaleLowerCase("en-US");
    const group = groups.find(
      (candidate) => candidate.app.label.toLocaleLowerCase("en-US") === appKey,
    );
    const candidate = group?.candidates.find(
      (entry) => entry.id.toLocaleLowerCase("en-US") === candidateKey,
    );
    return candidate ? [{ ...match, appLabel: group?.app.label ?? match.appLabel, candidate }] : [];
  });
  if (matches.length === 0) {
    return { status: "skipped", reason: "no-matches" };
  }
  return {
    status: "ok",
    apps,
    groups,
    matches: matches.toSorted(
      (left, right) =>
        (left.tier === right.tier ? 0 : left.tier === "recommended" ? -1 : 1) ||
        left.candidate.displayName.localeCompare(right.candidate.displayName, "en", {
          sensitivity: "base",
        }) ||
        left.appLabel.localeCompare(right.appLabel, "en", { sensitivity: "base" }),
    ),
  };
}
