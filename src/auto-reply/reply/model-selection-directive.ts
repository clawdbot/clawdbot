import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { isModelKeyAllowedBySet } from "../../agents/model-selection-shared.js";
import { normalizeProviderId } from "../../agents/provider-id.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

export type ModelAliasIndex = {
  byAlias: Map<
    string,
    {
      alias: string;
      ref: { provider: string; model: string };
    }
  >;
  byKey: Map<string, string[]>;
};

export type ModelDirectiveSelection = {
  provider: string;
  model: string;
  isDefault: boolean;
  alias?: string;
};

function formatAddModelCommand(modelRef: string): string {
  return `openclaw config set agents.defaults.models '${JSON.stringify({ [modelRef]: {} })}' --strict-json --merge`;
}

function formatNotAllowedError(params: {
  modelRef: string;
  rawRuntime?: string | undefined;
}): string {
  const rawRuntime = params.rawRuntime?.trim();
  const retryCommand = rawRuntime
    ? `/model ${params.modelRef} --runtime ${rawRuntime}`
    : `/model ${params.modelRef}`;
  const lines = [
    `Model "${params.modelRef}" is not allowed. Use /models to list providers, or /models <provider> to list models.`,
    `Add it with: ${formatAddModelCommand(params.modelRef)}`,
    `Then retry: ${retryCommand}`,
  ];
  if (rawRuntime && normalizeProviderId(rawRuntime) === "codex") {
    lines.push("If the Codex runtime is missing, run: openclaw plugins enable codex");
  }
  return lines.join("\n");
}

const FUZZY_VARIANT_TOKENS = [
  "lightning",
  "preview",
  "mini",
  "fast",
  "turbo",
  "lite",
  "beta",
  "small",
  "nano",
];

export function modelKey(provider: string, model: string): string {
  const providerId = provider.trim();
  const modelId = model.trim();
  if (!providerId) {
    return modelId;
  }
  if (!modelId) {
    return providerId;
  }
  return normalizeLowercaseStringOrEmpty(modelId).startsWith(
    `${normalizeLowercaseStringOrEmpty(providerId)}/`,
  )
    ? modelId
    : `${providerId}/${modelId}`;
}

export function resolveModelRefFromDirectiveString(params: {
  raw: string;
  defaultProvider: string;
  aliasIndex: ModelAliasIndex;
}): { ref: { provider: string; model: string }; alias?: string } | null {
  const { model } = splitTrailingAuthProfile(params.raw);
  if (!model) {
    return null;
  }
  if (!model.includes("/")) {
    const aliasKey = normalizeLowercaseStringOrEmpty(model);
    const aliasMatch = params.aliasIndex.byAlias.get(aliasKey);
    if (aliasMatch) {
      return { ref: aliasMatch.ref, alias: aliasMatch.alias };
    }
  }
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  const providerRaw = slash === -1 ? params.defaultProvider : trimmed.slice(0, slash).trim();
  const modelRaw = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
  if (!providerRaw || !modelRaw) {
    return null;
  }
  return {
    ref: {
      provider: normalizeProviderId(providerRaw),
      model: modelRaw,
    },
  };
}

function boundedLevenshteinDistance(a: string, b: string, maxDistance: number): number | null {
  if (a === b) {
    return 0;
  }
  if (!a || !b) {
    return null;
  }
  const aLen = a.length;
  const bLen = b.length;
  if (Math.abs(aLen - bLen) > maxDistance) {
    return null;
  }

  // Standard DP with early exit. O(maxDistance * minLen) in common cases.
  const prev = Array.from({ length: bLen + 1 }, (_, idx) => idx);
  const curr = Array.from({ length: bLen + 1 }, () => 0);

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    let rowMin = curr[0];

    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j++) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) {
        rowMin = curr[j];
      }
    }

    if (rowMin > maxDistance) {
      return null;
    }

    for (let j = 0; j <= bLen; j++) {
      prev[j] = curr[j] ?? 0;
    }
  }

  const dist = prev[bLen] ?? null;
  if (dist == null || dist > maxDistance) {
    return null;
  }
  return dist;
}

function scoreFuzzyMatch(params: {
  provider: string;
  model: string;
  fragment: string;
  aliasIndex: ModelAliasIndex;
  defaultProvider: string;
  defaultModel: string;
}): {
  score: number;
  isDefault: boolean;
  variantCount: number;
  variantMatchCount: number;
  modelLength: number;
  key: string;
} {
  const provider = normalizeProviderId(params.provider);
  const model = params.model;
  const fragment = normalizeLowercaseStringOrEmpty(params.fragment);
  const providerLower = normalizeLowercaseStringOrEmpty(provider);
  const modelLower = normalizeLowercaseStringOrEmpty(model);
  const haystack = `${providerLower}/${modelLower}`;
  const key = modelKey(provider, model);

  const scoreFragment = (
    value: string,
    weights: { exact: number; starts: number; includes: number },
  ) => {
    if (!fragment) {
      return 0;
    }
    let score = 0;
    if (value === fragment) {
      score = Math.max(score, weights.exact);
    }
    if (value.startsWith(fragment)) {
      score = Math.max(score, weights.starts);
    }
    if (value.includes(fragment)) {
      score = Math.max(score, weights.includes);
    }
    return score;
  };

  let score = 0;
  score += scoreFragment(haystack, { exact: 220, starts: 140, includes: 110 });
  score += scoreFragment(providerLower, {
    exact: 180,
    starts: 120,
    includes: 90,
  });
  score += scoreFragment(modelLower, {
    exact: 160,
    starts: 110,
    includes: 80,
  });

  // Best-effort typo tolerance for common near-misses like "claud" vs "claude".
  // Bounded to keep this cheap across large model sets.
  const distModel = boundedLevenshteinDistance(fragment, modelLower, 3);
  if (distModel != null) {
    score += (3 - distModel) * 70;
  }

  const aliases = params.aliasIndex.byKey.get(key) ?? [];
  for (const alias of aliases) {
    score += scoreFragment(normalizeLowercaseStringOrEmpty(alias), {
      exact: 140,
      starts: 90,
      includes: 60,
    });
  }

  if (modelLower.startsWith(providerLower)) {
    score += 30;
  }

  const fragmentVariants = FUZZY_VARIANT_TOKENS.filter((token) => fragment.includes(token));
  const modelVariants = FUZZY_VARIANT_TOKENS.filter((token) => modelLower.includes(token));
  const variantMatchCount = fragmentVariants.filter((token) => modelLower.includes(token)).length;
  const variantCount = modelVariants.length;
  if (fragmentVariants.length === 0 && variantCount > 0) {
    score -= variantCount * 30;
  } else if (fragmentVariants.length > 0) {
    if (variantMatchCount > 0) {
      score += variantMatchCount * 40;
    }
    if (variantMatchCount === 0) {
      score -= 20;
    }
  }

  const defaultProvider = normalizeProviderId(params.defaultProvider);
  const isDefault = provider === defaultProvider && model === params.defaultModel;
  if (isDefault) {
    score += 20;
  }

  return {
    score,
    isDefault,
    variantCount,
    variantMatchCount,
    modelLength: modelLower.length,
    key,
  };
}

export function resolveModelDirectiveSelection(params: {
  raw: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  rawRuntime?: string | undefined;
}): { selection?: ModelDirectiveSelection; error?: string } {
  const { raw, defaultProvider, defaultModel, aliasIndex, allowedModelKeys } = params;

  const rawTrimmed = raw.trim();
  const rawLower = normalizeLowercaseStringOrEmpty(rawTrimmed);

  const pickAliasForKey = (provider: string, model: string): string | undefined =>
    aliasIndex.byKey.get(modelKey(provider, model))?.[0];

  const buildSelection = (provider: string, model: string): ModelDirectiveSelection => {
    const alias = pickAliasForKey(provider, model);
    return {
      provider,
      model,
      isDefault: provider === defaultProvider && model === defaultModel,
      ...(alias ? { alias } : undefined),
    };
  };

  const resolveFuzzy = (params: {
    provider?: string;
    fragment: string;
  }): { selection?: ModelDirectiveSelection; error?: string } => {
    const fragment = normalizeLowercaseStringOrEmpty(params.fragment);
    if (!fragment) {
      return {};
    }

    const providerFilter = params.provider ? normalizeProviderId(params.provider) : undefined;

    const candidates: Array<{ provider: string; model: string }> = [];
    for (const key of allowedModelKeys) {
      const slash = key.indexOf("/");
      if (slash <= 0) {
        continue;
      }
      const provider = normalizeProviderId(key.slice(0, slash));
      const model = key.slice(slash + 1);
      if (model === "*") {
        continue;
      }
      if (providerFilter && provider !== providerFilter) {
        continue;
      }
      candidates.push({ provider, model });
    }

    // Also allow partial alias matches when the user didn't specify a provider.
    if (!params.provider) {
      const aliasMatches: Array<{ provider: string; model: string }> = [];
      for (const [aliasKey, entry] of aliasIndex.byAlias.entries()) {
        if (!aliasKey.includes(fragment)) {
          continue;
        }
        aliasMatches.push({
          provider: entry.ref.provider,
          model: entry.ref.model,
        });
      }
      for (const match of aliasMatches) {
        const key = modelKey(match.provider, match.model);
        if (!isModelKeyAllowedBySet(allowedModelKeys, key)) {
          continue;
        }
        if (!candidates.some((c) => c.provider === match.provider && c.model === match.model)) {
          candidates.push(match);
        }
      }
    }

    if (candidates.length === 0) {
      return {};
    }

    const scored = candidates
      .map((candidate) => {
        const details = scoreFuzzyMatch({
          provider: candidate.provider,
          model: candidate.model,
          fragment,
          aliasIndex,
          defaultProvider,
          defaultModel,
        });
        return Object.assign({ candidate }, details);
      })
      .toSorted((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        if (a.isDefault !== b.isDefault) {
          return a.isDefault ? -1 : 1;
        }
        if (a.variantMatchCount !== b.variantMatchCount) {
          return b.variantMatchCount - a.variantMatchCount;
        }
        if (a.variantCount !== b.variantCount) {
          return a.variantCount - b.variantCount;
        }
        if (a.modelLength !== b.modelLength) {
          return a.modelLength - b.modelLength;
        }
        return a.key.localeCompare(b.key);
      });

    const bestScored = scored[0];
    const best = bestScored?.candidate;
    if (!best || !bestScored) {
      return {};
    }

    const minScore = providerFilter ? 90 : 120;
    if (bestScored.score < minScore) {
      return {};
    }

    return { selection: buildSelection(best.provider, best.model) };
  };

  const resolved = resolveModelRefFromDirectiveString({
    raw: rawTrimmed,
    defaultProvider,
    aliasIndex,
  });

  if (!resolved) {
    const fuzzy = resolveFuzzy({ fragment: rawTrimmed });
    if (fuzzy.selection || fuzzy.error) {
      return fuzzy;
    }
    return {
      error: `Unrecognized model "${rawTrimmed}". Use /models to list providers, or /models <provider> to list models.`,
    };
  }

  const resolvedKey = modelKey(resolved.ref.provider, resolved.ref.model);
  if (allowedModelKeys.size === 0 || isModelKeyAllowedBySet(allowedModelKeys, resolvedKey)) {
    return {
      selection: {
        provider: resolved.ref.provider,
        model: resolved.ref.model,
        isDefault: resolved.ref.provider === defaultProvider && resolved.ref.model === defaultModel,
        alias: resolved.alias,
      },
    };
  }

  // If the user specified a provider/model but the exact model isn't allowed,
  // attempt a fuzzy match within that provider.
  if (rawLower.includes("/")) {
    const slash = rawTrimmed.indexOf("/");
    const provider = normalizeProviderId(rawTrimmed.slice(0, slash).trim());
    const fragment = rawTrimmed.slice(slash + 1).trim();
    const fuzzy = resolveFuzzy({ provider, fragment });
    if (fuzzy.selection || fuzzy.error) {
      return fuzzy;
    }
  }

  // Otherwise, try fuzzy matching across allowlisted models.
  const fuzzy = resolveFuzzy({ fragment: rawTrimmed });
  if (fuzzy.selection || fuzzy.error) {
    return fuzzy;
  }

  return {
    error: formatNotAllowedError({
      modelRef: `${resolved.ref.provider}/${resolved.ref.model}`,
      rawRuntime: params.rawRuntime,
    }),
  };
}
