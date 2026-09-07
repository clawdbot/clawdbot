/**
 * Model resolution, scoping, and initial selection
 */

import { modelsAreEqual } from "@openclaw/ai/internal/runtime";
import chalk from "chalk";
import { minimatch } from "minimatch";
import type { Model } from "../../llm/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import type { ThinkingLevel } from "../runtime/index.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type { ModelRegistry } from "./model-registry.js";

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function isValidThinkingLevel(level: string): level is ThinkingLevel {
  return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

function splitModelPatternSuffix(pattern: string): [string, string] | undefined {
  const index = pattern.lastIndexOf(":");
  return index === -1 ? undefined : [pattern.slice(0, index), pattern.slice(index + 1)];
}

export interface ScopedModel {
  model: Model;
  /** Thinking level if explicitly specified in pattern (e.g., "model:high"), undefined otherwise */
  thinkingLevel?: ThinkingLevel;
}

/**
 * Helper to check if a model ID looks like an alias (no date suffix)
 * Dates are typically in format: -20241022 or -20250929
 */
function isAlias(id: string): boolean {
  return !/-\d{8}$/.test(id);
}

function scopeModelsToProvider(provider: string, availableModels: Model[]): Model[] {
  const exact = availableModels.filter((model) => model.provider === provider);
  return exact.length
    ? exact
    : availableModels.filter((model) => model.provider.toLowerCase() === provider.toLowerCase());
}

type ModelReferenceScope = [pattern: string, models: Model[]];

function collectQualifiedModelScopes(
  modelReference: string,
  availableModels: Model[],
): ModelReferenceScope[][] {
  const canonicalScopes: ModelReferenceScope[] = [];
  const qualifiedScopes: ModelReferenceScope[] = [];
  for (
    let slashIndex = modelReference.indexOf("/");
    slashIndex !== -1;
    slashIndex = modelReference.indexOf("/", slashIndex + 1)
  ) {
    const provider = modelReference.slice(0, slashIndex);
    const modelId = modelReference.slice(slashIndex + 1);
    const models = scopeModelsToProvider(provider, availableModels);
    if (models.length) {
      canonicalScopes.push([modelId, models]);
    }
    const trimmedModels =
      provider === provider.trim()
        ? models
        : scopeModelsToProvider(provider.trim(), availableModels);
    if (trimmedModels.length) {
      qualifiedScopes.push([modelId.trim(), trimmedModels]);
    }
  }
  return [canonicalScopes, qualifiedScopes];
}

function collectModelReferenceMatches(
  modelReference: string,
  availableModels: Model[],
  qualifiedOnly = false,
): Model[] {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) {
    return [];
  }

  // Compare every provider/model split before raw ids: both identities may contain slashes.
  // Literal tuple components win before the whitespace-tolerant reference form.
  const groups = collectQualifiedModelScopes(trimmedReference, availableModels);
  if (!qualifiedOnly) {
    groups.push([[trimmedReference, availableModels]]);
  }
  for (const scopes of groups) {
    const matchedScopes = scopes
      .map<ModelReferenceScope>(([id, models]) => [
        id,
        models.filter((model) => model.id.toLowerCase() === id.toLowerCase()),
      ])
      .filter(([, models]) => models.length);
    const folded = matchedScopes.flatMap(([, models]) => models);
    const canonical = folded.filter(
      (model) => `${model.provider}/${model.id}` === trimmedReference,
    );
    // Across different split positions only a complete exact tuple can break a case-folded tie.
    const matches = canonical.length
      ? canonical
      : matchedScopes.length > 1
        ? folded
        : matchedScopes.flatMap(([id, models]) => {
            const exact = models.filter((model) => model.id === id);
            return exact.length ? exact : models;
          });
    if (matches.length > 0) {
      // Catalogs may repeat an identity; preserve the registry's first-row precedence.
      return matches.filter(
        (model, index) =>
          matches.findIndex((candidate) => modelsAreEqual(candidate, model)) === index,
      );
    }
  }
  return [];
}

function ambiguousModelReference(pattern: string): string {
  return `Model "${pattern}" is ambiguous. Use exact provider and model IDs, specifying the provider separately if needed.`;
}

function collectModelPatternMatches(
  pattern: string,
  availableModels: Model[],
  deferRawIds = false,
): Model[] {
  const parts = splitModelPatternSuffix(pattern);
  const suffix = parts && isValidThinkingLevel(parts[1]) ? parts : undefined;
  // A complete literal id must win before a thinking suffix changes its interpretation.
  const matches = collectModelReferenceMatches(pattern, availableModels, deferRawIds && !suffix);
  return matches.length || !suffix
    ? matches
    : collectModelPatternMatches(suffix[0], availableModels, deferRawIds);
}

/**
 * Match a bare id or provider/model reference, preferring exact model-id casing.
 * Case-insensitive matches remain available only when unambiguous.
 */
export function findExactModelReferenceMatch(
  modelReference: string,
  availableModels: Model[],
): Model | undefined {
  const matches = collectModelReferenceMatches(modelReference, availableModels);
  return matches.length === 1 ? matches[0] : undefined;
}

function matchPartialModelPattern(
  modelPattern: string,
  availableModels: Model[],
): Model | undefined {
  const normalizedPattern = modelPattern.toLowerCase();
  const matches = availableModels.filter(
    (model) =>
      model.id.toLowerCase().includes(normalizedPattern) ||
      model.name?.toLowerCase().includes(normalizedPattern),
  );
  // Aliases precede snapshots; each group keeps its highest numeric version.
  const matched = matches.toSorted(
    (a, b) =>
      Number(isAlias(b.id)) - Number(isAlias(a.id)) ||
      b.id.localeCompare(a.id, undefined, { numeric: true }),
  )[0];
  // Duplicate names remain searchable aliases; the first registry row owns runtime metadata.
  return matched && availableModels.find((model) => modelsAreEqual(model, matched));
}

export interface ParsedModelResult {
  model: Model | undefined;
  /** Thinking level if explicitly specified in pattern, undefined otherwise */
  thinkingLevel?: ThinkingLevel;
  warning: string | undefined;
}

function buildFallbackModel(
  provider: string,
  modelId: string,
  availableModels: Model[],
): Model | undefined {
  const baseModel = availableModels.find((model) => model.provider === provider);
  return baseModel ? { ...baseModel, id: modelId, name: modelId } : undefined;
}

function selectAvailableFallbackModel(availableModels: readonly Model[]): Model | undefined {
  return (
    availableModels.find(
      (model) => model.provider === DEFAULT_PROVIDER && model.id === DEFAULT_MODEL,
    ) ?? availableModels[0]
  );
}

/**
 * Parse a pattern to extract model and thinking level.
 * Handles models with colons in their IDs (e.g., OpenRouter's :exacto suffix).
 *
 * Algorithm:
 * 1. Try to match full pattern as a model
 * 2. If found, leave the thinking level unspecified
 * 3. If not found and has colons, split on last colon:
 *    - If suffix is valid thinking level, use it and recurse on prefix
 *    - If suffix is invalid, warn and leave the thinking level unspecified
 *
 * @internal Shared with the session extension SDK
 */
export function parseModelPattern(
  pattern: string,
  availableModels: Model[],
  options?: { allowInvalidThinkingLevelFallback?: boolean },
): ParsedModelResult {
  const exactMatches = collectModelReferenceMatches(pattern, availableModels);
  // Ambiguity must not fall through to fuzzy selection or custom-model construction.
  if (exactMatches.length > 1) {
    return {
      model: undefined,
      thinkingLevel: undefined,
      warning: ambiguousModelReference(pattern),
    };
  }
  const model = exactMatches[0] ?? matchPartialModelPattern(pattern, availableModels);
  if (model) {
    return { model, thinkingLevel: undefined, warning: undefined };
  }

  // No match - try splitting on last colon if present
  const parts = splitModelPatternSuffix(pattern);
  if (!parts) {
    // No colons, pattern simply doesn't match unknown model
    return { model: undefined, thinkingLevel: undefined, warning: undefined };
  }

  const [prefix, suffix] = parts;

  if (isValidThinkingLevel(suffix)) {
    // Valid thinking level - recurse on prefix and use this level
    const result = parseModelPattern(prefix, availableModels, options);
    if (result.model) {
      // Only use this thinking level if no warning from inner recursion
      return {
        model: result.model,
        thinkingLevel: result.warning ? undefined : suffix,
        warning: result.warning,
      };
    }
    return result;
  }
  // Invalid suffix
  const allowFallback = options?.allowInvalidThinkingLevelFallback ?? true;
  if (!allowFallback) {
    // In strict mode (CLI --model parsing), treat it as part of the model id and fail.
    // This avoids accidentally resolving to a different model.
    return { model: undefined, thinkingLevel: undefined, warning: undefined };
  }

  // Scope mode: recurse on prefix and warn
  const result = parseModelPattern(prefix, availableModels, options);
  if (result.model) {
    return {
      model: result.model,
      thinkingLevel: undefined,
      warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
    };
  }
  return result;
}

/**
 * Resolve model patterns to actual Model objects with optional thinking levels
 * Format: "pattern:level" where :level is optional
 * For each pattern, finds all matching models and picks the best version:
 * 1. Prefer alias (e.g., claude-sonnet-4-5) over dated versions (claude-sonnet-4-5-20250929)
 * 2. If no alias, pick the latest dated version
 *
 * Supports models with colons in their IDs (e.g., OpenRouter's model:exacto).
 * The algorithm tries to match the full pattern first, then progressively
 * strips colon-suffixes to find a match.
 */
export async function resolveModelScope(
  patterns: string[],
  modelRegistry: ModelRegistry,
): Promise<ScopedModel[]> {
  const availableModels = modelRegistry.getAvailable();
  const scopedModels: ScopedModel[] = [];

  for (const pattern of patterns) {
    // Check if pattern contains glob characters
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
      // Extract optional thinking level suffix (e.g., "provider/*:high")
      const suffix = splitModelPatternSuffix(pattern);
      let globPattern = pattern;
      let thinkingLevel: ThinkingLevel | undefined;

      if (suffix && isValidThinkingLevel(suffix[1])) {
        thinkingLevel = suffix[1];
        globPattern = suffix[0];
      }

      // Match against "provider/modelId" format OR just model ID
      // This allows "*sonnet*" to match without requiring "anthropic/*sonnet*"
      const matchingModels = availableModels.filter((m) => {
        const fullId = `${m.provider}/${m.id}`;
        return (
          minimatch(fullId, globPattern, { nocase: true }) ||
          minimatch(m.id, globPattern, { nocase: true })
        );
      });

      if (matchingModels.length === 0) {
        console.warn(chalk.yellow(`Warning: No models match pattern "${pattern}"`));
        continue;
      }

      for (const model of matchingModels) {
        if (!scopedModels.some((sm) => modelsAreEqual(sm.model, model))) {
          scopedModels.push({ model, thinkingLevel });
        }
      }
      continue;
    }

    const { model, thinkingLevel, warning } = parseModelPattern(pattern, availableModels);

    if (warning) {
      console.warn(chalk.yellow(`Warning: ${warning}`));
    }

    if (!model) {
      console.warn(chalk.yellow(`Warning: No models match pattern "${pattern}"`));
      continue;
    }

    // Avoid duplicates
    if (!scopedModels.some((sm) => modelsAreEqual(sm.model, model))) {
      scopedModels.push({ model, thinkingLevel });
    }
  }

  return scopedModels;
}

export interface ResolveCliModelResult {
  model: Model | undefined;
  thinkingLevel?: ThinkingLevel;
  warning: string | undefined;
  /**
   * Error message suitable for CLI display.
   * When set, model will be undefined.
   */
  error: string | undefined;
}

/**
 * Resolve a single model from CLI flags.
 *
 * Supports:
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>
 * - Fuzzy matching (same rules as model scoping: exact id, then partial id/name)
 *
 * Note: This does not apply the thinking level by itself, but it may *parse* and
 * return a thinking level from "<pattern>:<thinking>" so the caller can apply it.
 */
export function resolveCliModel(options: {
  cliProvider?: string;
  cliModel?: string;
  cliThinking?: ThinkingLevel;
  modelRegistry: ModelRegistry;
}): ResolveCliModelResult {
  const { cliProvider, cliModel, cliThinking, modelRegistry } = options;

  if (!cliModel) {
    return { model: undefined, warning: undefined, error: undefined };
  }

  // Important: use *all* models here, not just models with pre-configured auth.
  // This allows "--api-key" to be used for first-time setup.
  const availableModels = modelRegistry.getAll();
  if (availableModels.length === 0) {
    return {
      model: undefined,
      warning: undefined,
      error: "No models available. Check your installation or add models to models.json.",
    };
  }

  let scopeGroups: ModelReferenceScope[][];
  if (cliProvider) {
    const models = scopeModelsToProvider(cliProvider, availableModels);
    if (!models.length) {
      return {
        model: undefined,
        warning: undefined,
        error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
      };
    }
    const prefix = `${cliProvider}/`;
    scopeGroups = [
      [
        [
          cliModel.toLowerCase().startsWith(prefix.toLowerCase())
            ? cliModel.slice(prefix.length)
            : cliModel,
          models,
        ],
      ],
    ];
  } else {
    scopeGroups = collectQualifiedModelScopes(cliModel.trim(), availableModels);
  }
  const parse = (pattern: string, models: Model[]) =>
    parseModelPattern(pattern, models, {
      allowInvalidThinkingLevelFallback: false,
    });
  const canonicalMatches = cliProvider
    ? []
    : collectModelPatternMatches(cliModel, availableModels, true);
  let parsed = canonicalMatches.length ? parse(cliModel, canonicalMatches) : undefined;
  for (const scopes of scopeGroups) {
    if (parsed) {
      break;
    }
    const matches = scopes
      .map(([scopePattern, models]) => {
        // Fuzzy ordering cannot choose between provider identities, including case-only variants.
        const candidates = models.some((entry) => entry.provider !== models[0]?.provider)
          ? collectModelPatternMatches(scopePattern, models)
          : models;
        return parse(scopePattern, candidates);
      })
      .filter((result) => result.model || result.warning);
    parsed =
      matches.find((result) => result.warning) ??
      (matches.length > 1
        ? { model: undefined, warning: ambiguousModelReference(cliModel) }
        : matches[0]);
  }
  // Preserve raw slash-id fallback after known provider patterns fail.
  parsed ??= cliProvider ? undefined : parse(cliModel, availableModels);
  if (parsed?.model || parsed?.warning) {
    return {
      model: parsed.model,
      thinkingLevel: parsed.thinkingLevel,
      warning: parsed.model ? parsed.warning : undefined,
      error: parsed.model ? undefined : parsed.warning,
    };
  }

  const fallbackScopes = scopeGroups.find((scopes) => scopes.length) ?? [];
  const providers = new Set(
    fallbackScopes.flatMap(([, models]) => models.map((entry) => entry.provider)),
  );
  if (providers.size > 1) {
    return { model: undefined, warning: undefined, error: ambiguousModelReference(cliModel) };
  }
  const [provider] = providers;
  const pattern = fallbackScopes[0]?.[0] ?? cliModel;
  if (provider) {
    let fallbackPattern = pattern;
    let fallbackThinking: ThinkingLevel | undefined;
    const suffix = splitModelPatternSuffix(pattern);
    if (!cliThinking && suffix && isValidThinkingLevel(suffix[1])) {
      fallbackPattern = suffix[0];
      fallbackThinking = suffix[1];
    }

    const fallbackModel = buildFallbackModel(provider, fallbackPattern, availableModels);
    if (fallbackModel) {
      const requestedThinking = cliThinking ?? fallbackThinking;
      const resolvedModel =
        requestedThinking && requestedThinking !== "off"
          ? { ...fallbackModel, reasoning: true }
          : fallbackModel;
      return {
        model: resolvedModel,
        thinkingLevel: requestedThinking,
        warning: `Model "${fallbackPattern}" not found for provider "${provider}". Using custom model id.`,
        error: undefined,
      };
    }
  }

  const display = provider ? `${provider}/${pattern}` : cliModel;
  return {
    model: undefined,
    thinkingLevel: undefined,
    warning: undefined,
    error: `Model "${display}" not found. Use --list-models to see available models.`,
  };
}

export interface InitialModelResult {
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  fallbackMessage: string | undefined;
}

/**
 * Find the initial model to use based on priority:
 * 1. CLI args (provider + model)
 * 2. First model from scoped models (if not continuing/resuming)
 * 3. Restored from session (if continuing/resuming)
 * 4. Saved default from settings
 * 5. First available model with valid API key
 */
export async function findInitialModel(options: {
  cliProvider?: string;
  cliModel?: string;
  scopedModels: ScopedModel[];
  isContinuing: boolean;
  defaultProvider?: string;
  defaultModelId?: string;
  defaultThinkingLevel?: ThinkingLevel;
  modelRegistry: ModelRegistry;
}): Promise<InitialModelResult> {
  const {
    cliProvider,
    cliModel,
    scopedModels,
    isContinuing,
    defaultProvider,
    defaultModelId,
    defaultThinkingLevel,
    modelRegistry,
  } = options;

  let model: Model | undefined;
  let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

  // 1. CLI args take priority
  if (cliProvider && cliModel) {
    const resolved = resolveCliModel({
      cliProvider,
      cliModel,
      modelRegistry,
    });
    if (resolved.error) {
      console.error(chalk.red(resolved.error));
      process.exit(1);
    }
    if (resolved.model) {
      return {
        model: resolved.model,
        thinkingLevel: resolved.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
        fallbackMessage: undefined,
      };
    }
  }

  // 2. Use first model from scoped models (skip if continuing/resuming)
  if (scopedModels.length > 0 && !isContinuing) {
    const scopedModel = scopedModels.at(0);
    if (!scopedModel) {
      throw new Error("Scoped model list became empty during selection");
    }
    return {
      model: scopedModel.model,
      thinkingLevel: scopedModel.thinkingLevel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
      fallbackMessage: undefined,
    };
  }

  // 3. Try saved default from settings when its auth is configured
  if (defaultProvider && defaultModelId) {
    const found = modelRegistry.find(defaultProvider, defaultModelId);
    if (found && modelRegistry.hasConfiguredAuth(found)) {
      model = found;
      if (defaultThinkingLevel) {
        thinkingLevel = defaultThinkingLevel;
      }
      return { model, thinkingLevel, fallbackMessage: undefined };
    }
  }

  // 4. Try first available model with valid API key
  const availableModels = modelRegistry.getAvailable();

  if (availableModels.length > 0) {
    return {
      model: selectAvailableFallbackModel(availableModels),
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      fallbackMessage: undefined,
    };
  }

  // 5. No model found
  return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}

/**
 * Restore model from session, with fallback to available models
 */
export async function restoreModelFromSession(
  savedProvider: string,
  savedModelId: string,
  currentModel: Model | undefined,
  shouldPrintMessages: boolean,
  modelRegistry: ModelRegistry,
): Promise<{ model: Model | undefined; fallbackMessage: string | undefined }> {
  const restoredModel = modelRegistry.find(savedProvider, savedModelId);

  // Check if restored model exists and still has auth configured
  const hasConfiguredAuth = restoredModel ? modelRegistry.hasConfiguredAuth(restoredModel) : false;

  if (restoredModel && hasConfiguredAuth) {
    if (shouldPrintMessages) {
      console.log(chalk.dim(`Restored model: ${savedProvider}/${savedModelId}`));
    }
    return { model: restoredModel, fallbackMessage: undefined };
  }

  // Model not found or no API key - fall back
  const reason = !restoredModel ? "model no longer exists" : "no auth configured";

  if (shouldPrintMessages) {
    console.error(
      chalk.yellow(
        `Warning: Could not restore model ${savedProvider}/${savedModelId} (${reason}).`,
      ),
    );
  }

  // If we already have a model, use it as fallback
  if (currentModel) {
    if (shouldPrintMessages) {
      console.log(chalk.dim(`Falling back to: ${currentModel.provider}/${currentModel.id}`));
    }
    return {
      model: currentModel,
      fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${currentModel.provider}/${currentModel.id}.`,
    };
  }

  // Try to find any available model
  const availableModels = modelRegistry.getAvailable();

  if (availableModels.length > 0) {
    const fallbackModel = selectAvailableFallbackModel(availableModels);
    if (!fallbackModel) {
      return {
        model: undefined,
        fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). No models available.`,
      };
    }

    if (shouldPrintMessages) {
      console.log(chalk.dim(`Falling back to: ${fallbackModel.provider}/${fallbackModel.id}`));
    }

    return {
      model: fallbackModel,
      fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${fallbackModel.provider}/${fallbackModel.id}.`,
    };
  }

  // No models available
  return { model: undefined, fallbackMessage: undefined };
}
