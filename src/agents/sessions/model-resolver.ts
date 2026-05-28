/**
 * Model resolution, scoping, and initial selection
 */

import chalk from "chalk";
import { minimatch } from "minimatch";
import { modelsAreEqual } from "../../llm/model-utils.js";
import type { Model } from "../../llm/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import type { ThinkingLevel } from "../runtime/index.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type { ModelRegistry } from "./model-registry.js";

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function isValidThinkingLevel(level: string): level is ThinkingLevel {
  return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
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
  // Check if ID ends with -latest
  if (id.endsWith("-latest")) {
    return true;
  }

  // Check if ID ends with a date pattern (-YYYYMMDD)
  const datePattern = /-\d{8}$/;
  return !datePattern.test(id);
}

/**
 * Find an exact model reference match.
 * Supports either a bare model id or a canonical provider/modelId reference.
 * When matching by bare id, ambiguous matches across providers are rejected.
 */
export function findExactModelReferenceMatch(
  modelReference: string,
  availableModels: Model[],
): Model | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) {
    return undefined;
  }

  const normalizedReference = trimmedReference.toLowerCase();

  const canonicalMatches = availableModels.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length === 1) {
    return canonicalMatches[0];
  }
  if (canonicalMatches.length > 1) {
    return undefined;
  }

  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.slice(0, slashIndex).trim();
    const modelId = trimmedReference.slice(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter(
        (model) =>
          model.provider.toLowerCase() === provider.toLowerCase() &&
          model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) {
        return providerMatches[0];
      }
      if (providerMatches.length > 1) {
        return undefined;
      }
    }
  }

  const idMatches = availableModels.filter(
    (model) => model.id.toLowerCase() === normalizedReference,
  );
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

/**
 * Try to match a pattern to a model from the available models list.
 * Returns the matched model or undefined if no match found.
 */
function tryMatchModel(modelPattern: string, availableModels: Model[]): Model | undefined {
  const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
  if (exactMatch) {
    return exactMatch;
  }

  // No exact match - fall back to partial matching
  const matches = availableModels.filter(
    (m) =>
      m.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
      m.name?.toLowerCase().includes(modelPattern.toLowerCase()),
  );

  if (matches.length === 0) {
    return undefined;
  }

  // Separate into aliases and dated versions
  const aliases = matches.filter((m) => isAlias(m.id));
  const datedVersions = matches.filter((m) => !isAlias(m.id));

  if (aliases.length > 0) {
    // Prefer alias - if multiple aliases, pick the one that sorts highest
    aliases.sort((a, b) => b.id.localeCompare(a.id));
    return aliases[0];
  }
  // No alias found, pick latest dated version
  datedVersions.sort((a, b) => b.id.localeCompare(a.id));
  return datedVersions[0];
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
  const providerModels = availableModels.filter((m) => m.provider === provider);
  if (providerModels.length === 0) {
    return undefined;
  }

  const baseModel = providerModels[0];

  return {
    ...baseModel,
    id: modelId,
    name: modelId,
  };
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
 * 2. If found, return it with "off" thinking level
 * 3. If not found and has colons, split on last colon:
 *    - If suffix is valid thinking level, use it and recurse on prefix
 *    - If suffix is invalid, warn and recurse on prefix with "off"
 *
 * @internal Exported for testing
 */
export function parseModelPattern(
  pattern: string,
  availableModels: Model[],
  options?: { allowInvalidThinkingLevelFallback?: boolean },
): ParsedModelResult {
  // Try exact match first
  const exactMatch = tryMatchModel(pattern, availableModels);
  if (exactMatch) {
    return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
  }

  // No match - try splitting on last colon if present
  const lastColonIndex = pattern.lastIndexOf(":");
  if (lastColonIndex === -1) {
    // No colons, pattern simply doesn't match unknown model
    return { model: undefined, thinkingLevel: undefined, warning: undefined };
  }

  const prefix = pattern.slice(0, lastColonIndex);
  const suffix = pattern.slice(lastColonIndex + 1);

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
      const colonIdx = pattern.lastIndexOf(":");
      let globPattern = pattern;
      let thinkingLevel: ThinkingLevel | undefined;

      if (colonIdx !== -1) {
        const suffix = pattern.slice(colonIdx + 1);
        if (isValidThinkingLevel(suffix)) {
          thinkingLevel = suffix;
          globPattern = pattern.slice(0, colonIdx);
        }
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
  modelRegistry: ModelRegistry;
}): ResolveCliModelResult {
  const { cliProvider, cliModel, modelRegistry } = options;

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

  // Build canonical provider lookup (case-insensitive)
  const providerMap = new Map<string, string>();
  for (const m of availableModels) {
    providerMap.set(m.provider.toLowerCase(), m.provider);
  }

  let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
  if (cliProvider && !provider) {
    return {
      model: undefined,
      warning: undefined,
      error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
    };
  }

  // If no explicit --provider, try to interpret "provider/model" format first.
  // When the prefix before the first slash matches a known provider, prefer that
  // interpretation over matching models whose IDs literally contain slashes
  // (e.g. "zai/glm-5" should resolve to provider=zai, model=glm-5, not to a
  // vercel-ai-gateway model with id "zai/glm-5").
  let pattern = cliModel;
  let inferredProvider = false;

  if (!provider) {
    const slashIndex = cliModel.indexOf("/");
    if (slashIndex !== -1) {
      const maybeProvider = cliModel.slice(0, slashIndex);
      const canonical = providerMap.get(maybeProvider.toLowerCase());
      if (canonical) {
        provider = canonical;
        pattern = cliModel.slice(slashIndex + 1);
        inferredProvider = true;
      }
    }
  }

  // If no provider was inferred from the slash, try exact matches without provider inference.
  // This handles models whose IDs naturally contain slashes (e.g. OpenRouter-style IDs).
  if (!provider) {
    const lower = cliModel.toLowerCase();
    const exact = availableModels.find(
      (m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
    );
    if (exact) {
      return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
    }
  }

  if (cliProvider && provider) {
    // If both were provided, tolerate --model <provider>/<pattern> by stripping the provider prefix
    const prefix = `${provider}/`;
    if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
      pattern = cliModel.slice(prefix.length);
    }
  }

  const candidates = provider
    ? availableModels.filter((m) => m.provider === provider)
    : availableModels;
  const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
    allowInvalidThinkingLevelFallback: false,
  });

  if (model) {
    return { model, thinkingLevel, warning, error: undefined };
  }

  // If we inferred a provider from the slash but found no match within that provider,
  // fall back to matching the full input as a raw model id across all models.
  // This handles OpenRouter-style IDs like "openai/gpt-4o:extended" where "openai"
  // looks like a provider but the full string is actually a model id on openrouter.
  if (inferredProvider) {
    const lower = cliModel.toLowerCase();
    const exact = availableModels.find(
      (m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
    );
    if (exact) {
      return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
    }
    // Also try parseModelPattern on the full input against all models
    const fallback = parseModelPattern(cliModel, availableModels, {
      allowInvalidThinkingLevelFallback: false,
    });
    if (fallback.model) {
      return {
        model: fallback.model,
        thinkingLevel: fallback.thinkingLevel,
        warning: fallback.warning,
        error: undefined,
      };
    }
  }

  if (provider) {
    const fallbackModel = buildFallbackModel(provider, pattern, availableModels);
    if (fallbackModel) {
      const fallbackWarning = warning
        ? `${warning} Model "${pattern}" not found for provider "${provider}". Using custom model id.`
        : `Model "${pattern}" not found for provider "${provider}". Using custom model id.`;
      return {
        model: fallbackModel,
        thinkingLevel: undefined,
        warning: fallbackWarning,
        error: undefined,
      };
    }
  }

  const display = provider ? `${provider}/${pattern}` : cliModel;
  return {
    model: undefined,
    thinkingLevel: undefined,
    warning,
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
        thinkingLevel: DEFAULT_THINKING_LEVEL,
        fallbackMessage: undefined,
      };
    }
  }

  // 2. Use first model from scoped models (skip if continuing/resuming)
  if (scopedModels.length > 0 && !isContinuing) {
    return {
      model: scopedModels[0].model,
      thinkingLevel:
        scopedModels[0].thinkingLevel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
      fallbackMessage: undefined,
    };
  }

  // 3. Try saved default from settings
  if (defaultProvider && defaultModelId) {
    const found = modelRegistry.find(defaultProvider, defaultModelId);
    if (found) {
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
