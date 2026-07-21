import {
  resolveAgentExplicitModelPrimary,
  resolveAgentModelFallbacksOverride,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import type { loadPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import { containsEnvVarReference, resolveConfigEnvVars } from "../config/env-substitution.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { formatCliCommand } from "./command-format.js";

type TouchedModelRef = {
  path: string;
  value: string;
  agentId?: string;
  fallback: boolean;
  authProfileId?: string;
  dependency?: boolean;
};

type ConfigModelRefResolver = (params: {
  config: OpenClawConfig;
  ref: TouchedModelRef;
}) => Promise<string | undefined>;

type ConfigModelRefCheckResult = {
  refsChecked: number;
  refsTotal: number;
  errors: string[];
};

type AgentEntriesConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>;

function resolveAgentEntries(config: OpenClawConfig): AgentEntriesConfig | undefined {
  const entries: unknown = config.agents?.entries;
  return entries && typeof entries === "object" && !Array.isArray(entries)
    ? (entries as AgentEntriesConfig)
    : undefined;
}

function isPathPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

function collectTextModelConfigRefs(params: {
  model: unknown;
  path: string;
  agentId?: string;
}): TouchedModelRef[] {
  if (typeof params.model === "string") {
    const value = params.model.trim();
    return [
      {
        path: params.path,
        value,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        fallback: false,
      },
    ];
  }
  if (!params.model || typeof params.model !== "object" || Array.isArray(params.model)) {
    return [];
  }
  const model = params.model as { primary?: unknown; fallbacks?: unknown };
  const refs: TouchedModelRef[] = [];
  if (typeof model.primary === "string") {
    const value = model.primary.trim();
    refs.push({
      path: `${params.path}.primary`,
      value,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      fallback: false,
    });
  }
  if (Array.isArray(model.fallbacks)) {
    for (const [index, fallback] of model.fallbacks.entries()) {
      if (typeof fallback !== "string") {
        continue;
      }
      refs.push({
        path: `${params.path}.fallbacks.${index}`,
        value: fallback.trim(),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        fallback: true,
      });
    }
  }
  return refs;
}

function collectTextModelRefs(config: OpenClawConfig): TouchedModelRef[] {
  const refs = collectTextModelConfigRefs({
    model: config.agents?.defaults?.model,
    path: "agents.defaults.model",
  });
  const agentEntries = resolveAgentEntries(config);
  if (agentEntries) {
    for (const [agentId, agent] of Object.entries(agentEntries)) {
      if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
        continue;
      }
      refs.push(
        ...collectTextModelConfigRefs({
          model: (agent as { model?: unknown }).model,
          path: `agents.entries.${agentId}.model`,
          agentId,
        }),
      );
    }
  }
  for (const ref of refs) {
    // Runtime preserves an auth-profile suffix only for configured primaries. Fallback
    // candidates carry provider/model pairs, so validation must mirror that behavior.
    if (ref.fallback) {
      continue;
    }
    const authProfileId = splitTrailingAuthProfile(ref.value).profile;
    if (authProfileId) {
      ref.authProfileId = authProfileId;
    }
  }
  return refs;
}

function modelRefComparisonKey(ref: TouchedModelRef): string {
  if (ref.agentId) {
    const prefix = `agents.entries.${ref.agentId}.`;
    const relativePath = ref.path.startsWith(prefix) ? ref.path.slice(prefix.length) : ref.path;
    return `agent:${normalizeAgentId(ref.agentId)}:${relativePath}`;
  }
  return `path:${ref.path}`;
}

function collectTouchedTextModelRefs(params: {
  config: OpenClawConfig;
  previousConfig?: OpenClawConfig;
  touchedPaths: readonly (readonly string[])[];
}): TouchedModelRef[] {
  const defaultPrimaryPath = ["agents", "defaults", "model", "primary"];
  const defaultPrimaryTouched = params.touchedPaths.some(
    (touchedPath) =>
      isPathPrefix(touchedPath, defaultPrimaryPath) ||
      isPathPrefix(defaultPrimaryPath, touchedPath),
  );
  const refs = collectTextModelRefs(params.config);
  const previousRefs = params.previousConfig
    ? collectTextModelRefs(params.previousConfig)
    : undefined;
  const previousRefsByIdentity = previousRefs
    ? new Map(previousRefs.map((ref) => [modelRefComparisonKey(ref), ref]))
    : undefined;
  const defaultPrimaryProviderChanged =
    defaultPrimaryTouched &&
    (!previousRefs ||
      resolveDefaultModelForAgent({ cfg: params.config }).provider !==
        resolveDefaultModelForAgent({ cfg: params.previousConfig ?? {} }).provider);
  const touchedRefs = refs.filter((ref) => {
    if (ref.fallback && defaultPrimaryProviderChanged) {
      const previousRef = previousRefsByIdentity?.get(modelRefComparisonKey(ref));
      const nextResolved = resolveCanonicalFallbackRef(params.config, ref.value);
      const previousResolved =
        params.previousConfig && previousRef
          ? resolveCanonicalFallbackRef(params.previousConfig, previousRef.value)
          : undefined;
      if (
        !nextResolved ||
        !previousResolved ||
        nextResolved.provider !== previousResolved.provider ||
        nextResolved.model !== previousResolved.model
      ) {
        ref.dependency = true;
        return true;
      }
    }
    const refPath = ref.path.split(".");
    const touched = params.touchedPaths.some(
      (touchedPath) => isPathPrefix(touchedPath, refPath) || isPathPrefix(refPath, touchedPath),
    );
    if (!touched || !previousRefsByIdentity) {
      return touched;
    }
    const previousRef = previousRefsByIdentity.get(modelRefComparisonKey(ref));
    const ownerChanged = previousRef?.agentId !== ref.agentId;
    if (ownerChanged) {
      ref.dependency = true;
    }
    return previousRef?.value !== ref.value || ownerChanged;
  });
  const defaultRefs = refs.filter((ref) => ref.agentId === undefined);
  const agentEntries = resolveAgentEntries(params.config);
  if (defaultRefs.length === 0) {
    return touchedRefs;
  }
  if (!agentEntries || Object.keys(agentEntries).length === 0) {
    const entriesPath = ["agents", "entries"];
    const entriesTouched = params.touchedPaths.some(
      (touchedPath) =>
        isPathPrefix(touchedPath, entriesPath) || isPathPrefix(entriesPath, touchedPath),
    );
    const previousEntries = params.previousConfig
      ? resolveAgentEntries(params.previousConfig)
      : undefined;
    if (!entriesTouched || !previousEntries || Object.keys(previousEntries).length === 0) {
      return touchedRefs;
    }
    const previousDefaultAgentId = resolveDefaultAgentId(params.previousConfig ?? {});
    for (const defaultRef of defaultRefs) {
      const previouslyInherited = params.previousConfig
        ? defaultRef.fallback
          ? resolveAgentModelFallbacksOverride(params.previousConfig, previousDefaultAgentId) ===
            undefined
          : resolveAgentExplicitModelPrimary(params.previousConfig, previousDefaultAgentId) ===
            undefined
        : false;
      const alreadySelected = touchedRefs.some(
        (ref) => ref.agentId === undefined && ref.path === defaultRef.path,
      );
      if (!previouslyInherited && !alreadySelected) {
        touchedRefs.push({ ...defaultRef, dependency: true });
      }
    }
    return touchedRefs;
  }
  for (const agentId of Object.keys(agentEntries)) {
    const agentEntryPath = ["agents", "entries", agentId];
    const agentModelPath = [...agentEntryPath, "model"];
    const ownershipTouched = params.touchedPaths.some(
      (touchedPath) =>
        isPathPrefix(touchedPath, agentEntryPath) ||
        isPathPrefix(agentEntryPath, touchedPath) ||
        isPathPrefix(touchedPath, agentModelPath) ||
        isPathPrefix(agentModelPath, touchedPath),
    );
    if (!ownershipTouched) {
      continue;
    }
    for (const defaultRef of defaultRefs) {
      const inherits = defaultRef.fallback
        ? resolveAgentModelFallbacksOverride(params.config, agentId) === undefined
        : resolveAgentExplicitModelPrimary(params.config, agentId) === undefined;
      const previousAgentExists = Object.keys(
        params.previousConfig ? (resolveAgentEntries(params.previousConfig) ?? {}) : {},
      ).some((entryId) => normalizeAgentId(entryId) === normalizeAgentId(agentId));
      const previouslyInherited =
        previousAgentExists && params.previousConfig
          ? defaultRef.fallback
            ? resolveAgentModelFallbacksOverride(params.previousConfig, agentId) === undefined
            : resolveAgentExplicitModelPrimary(params.previousConfig, agentId) === undefined
          : false;
      if (inherits && !previouslyInherited) {
        touchedRefs.push({ ...defaultRef, agentId, dependency: true });
      }
    }
  }
  return touchedRefs;
}

function resolveCanonicalPrimaryRef(
  config: OpenClawConfig,
  value: string,
): { provider: string; model: string } | undefined {
  const validationConfig: OpenClawConfig = {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        model: value,
      },
    },
  };
  const resolved = resolveConfiguredModelRef({
    cfg: validationConfig,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: "",
    allowPluginNormalization: true,
  });
  return resolved.model ? resolved : undefined;
}

function resolveFallbackRef(config: OpenClawConfig, value: string) {
  const defaultProvider = resolveDefaultModelForAgent({ cfg: config }).provider;
  return resolveModelRefFromString({
    cfg: config,
    raw: value,
    defaultProvider,
    aliasIndex: buildModelAliasIndex({
      cfg: config,
      defaultProvider,
      allowPluginNormalization: true,
    }),
    allowPluginNormalization: true,
  });
}

function resolveCanonicalFallbackRef(
  config: OpenClawConfig,
  value: string,
): { provider: string; model: string } | undefined {
  return resolveFallbackRef(config, value)?.ref;
}

function hasUnresolvedInheritedFallbackProvider(
  config: OpenClawConfig,
  ref: TouchedModelRef,
): boolean {
  if (!ref.fallback || ref.value.includes("/")) {
    return false;
  }
  const primary = resolveAgentModelPrimaryValue(config.agents?.defaults?.model);
  if (!primary) {
    return false;
  }
  const primaryModel = splitTrailingAuthProfile(primary).model;
  const slash = primaryModel.indexOf("/");
  const provider = slash > 0 ? primaryModel.slice(0, slash) : primaryModel;
  const fallback = resolveFallbackRef(config, ref.value);
  return Boolean(fallback && !fallback.alias && containsEnvVarReference(provider));
}

function expandInheritedDefaultRefs(
  config: OpenClawConfig,
  refs: TouchedModelRef[],
): TouchedModelRef[] {
  const agentEntries = resolveAgentEntries(config);
  if (!agentEntries) {
    return refs;
  }
  const defaultAgentId = resolveDefaultAgentId(config);
  const expanded: TouchedModelRef[] = [];
  const seen = new Set<string>();
  const push = (ref: TouchedModelRef) => {
    const key = `${ref.path}\u0000${ref.agentId ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      expanded.push(ref);
    }
  };
  for (const ref of refs) {
    if (ref.agentId !== undefined) {
      push(ref);
      continue;
    }
    const defaultAgentConfigured = Object.keys(agentEntries).some(
      (agentId) => normalizeAgentId(agentId) === normalizeAgentId(defaultAgentId),
    );
    const defaultAgentInherits =
      !defaultAgentConfigured ||
      (ref.fallback
        ? resolveAgentModelFallbacksOverride(config, defaultAgentId) === undefined
        : resolveAgentExplicitModelPrimary(config, defaultAgentId) === undefined);
    if (defaultAgentInherits) {
      push(ref);
    }
    for (const agentId of Object.keys(agentEntries)) {
      if (normalizeAgentId(agentId) === normalizeAgentId(defaultAgentId)) {
        continue;
      }
      const inherits = ref.fallback
        ? resolveAgentModelFallbacksOverride(config, agentId) === undefined
        : resolveAgentExplicitModelPrimary(config, agentId) === undefined;
      if (inherits) {
        push({ ...ref, agentId });
      }
    }
  }
  return expanded;
}

function validateModelRefSyntax(config: OpenClawConfig, ref: TouchedModelRef): string | undefined {
  if (!ref.value) {
    return "Model reference is empty";
  }
  if (containsEnvVarReference(ref.value)) {
    return "Model reference contains an unresolved environment variable";
  }
  const resolved = ref.fallback
    ? resolveCanonicalFallbackRef(config, ref.value)
    : resolveCanonicalPrimaryRef(config, ref.value);
  return resolved ? undefined : "Invalid model reference or configured model alias target";
}

async function createRuntimeModelRefResolver(): Promise<ConfigModelRefResolver> {
  const [agentScope, modelSelection] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../agents/model-selection.js"),
  ]);
  const preparedByAgent = new Map<
    string,
    Awaited<ReturnType<typeof loadPreparedModelCatalogOwnerSnapshot>>
  >();
  let modelModules:
    | Promise<
        [
          typeof import("../agents/embedded-agent-runner/model.js"),
          typeof import("../agents/prepared-model-catalog.js"),
        ]
      >
    | undefined;
  const loadModelModules = () =>
    (modelModules ??= Promise.all([
      import("../agents/embedded-agent-runner/model.js"),
      import("../agents/prepared-model-catalog.js"),
    ]));

  return async ({ config, ref }) => {
    const targetAgentId = ref.agentId ?? agentScope.resolveDefaultAgentId(config);
    const agentDir = agentScope.resolveAgentDir(config, targetAgentId);
    const workspaceDir = agentScope.resolveAgentWorkspaceDir(config, targetAgentId);
    const resolvedRef = ref.fallback
      ? resolveCanonicalFallbackRef(config, ref.value)
      : resolveCanonicalPrimaryRef(config, ref.value);
    if (!resolvedRef) {
      return `Unknown model: ${ref.value}`;
    }
    // CLI backends own model validation; their model ids do not need embedded catalog rows.
    if (modelSelection.isCliProvider(resolvedRef.provider, config)) {
      return undefined;
    }
    const [modelRuntime, preparedCatalog] = await loadModelModules();

    let prepared = preparedByAgent.get(targetAgentId);
    if (!prepared) {
      prepared = await preparedCatalog.loadPreparedModelCatalogOwnerSnapshot({
        agentId: targetAgentId,
        agentDir,
        config,
        readOnly: true,
        workspaceDir,
      });
      preparedByAgent.set(targetAgentId, prepared);
    }
    const stores = prepared.createStores();
    const resolution = await modelRuntime.resolveModelAsync(
      resolvedRef.provider,
      resolvedRef.model,
      agentDir,
      config,
      {
        agentId: targetAgentId,
        allowBundledStaticCatalogFallback: true,
        authStorage: stores.authStorage,
        ...(ref.authProfileId ? { authProfileId: ref.authProfileId } : {}),
        modelRegistry: stores.modelRegistry,
        workspaceDir,
      },
    );
    return resolution.model
      ? undefined
      : (resolution.error ?? `Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
  };
}

function formatModelRefError(
  ref: TouchedModelRef,
  error: string,
  authoredValue = ref.value,
  options?: { suppressDetail?: boolean },
): string {
  const safeError =
    options?.suppressDetail || authoredValue !== ref.value
      ? "Unable to resolve authored model reference"
      : error;
  const detail = safeError.endsWith(".") ? safeError : `${safeError}.`;
  return `Cannot set model reference "${authoredValue}" at ${ref.path}: ${detail} Run ${formatCliCommand("openclaw models list")} to list available models.`;
}

export async function checkTouchedTextModelRefs(params: {
  config: OpenClawConfig;
  previousConfig?: OpenClawConfig;
  touchedPaths: readonly (readonly string[])[];
  env?: NodeJS.ProcessEnv;
  resolveModelRef?: ConfigModelRefResolver;
  createModelRefResolver?: () => Promise<ConfigModelRefResolver>;
  redactDependencyValues?: boolean;
}): Promise<ConfigModelRefCheckResult> {
  const authoredRefs = collectTouchedTextModelRefs(params);
  const authoredValuesByPath = new Map(
    collectTextModelRefs(params.config).map((ref) => [ref.path, ref.value]),
  );
  const previousAuthoredValuesByPath = new Map(
    collectTextModelRefs(params.previousConfig ?? {}).map((ref) => [ref.path, ref.value]),
  );
  let validationConfig: OpenClawConfig;
  let validationPreviousConfig: OpenClawConfig | undefined;
  try {
    const env = params.env ?? process.env;
    validationConfig = resolveConfigEnvVars(params.config, env, {
      onMissing: () => {},
    }) as OpenClawConfig;
    validationPreviousConfig = params.previousConfig
      ? (resolveConfigEnvVars(params.previousConfig, env, {
          onMissing: () => {},
        }) as OpenClawConfig)
      : undefined;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      refsChecked: 0,
      refsTotal: authoredRefs.length,
      errors: [`Unable to validate changed model references before writing: ${detail}`],
    };
  }
  const validationValuesByPath = new Map(
    collectTextModelRefs(validationConfig).map((ref) => [ref.path, ref.value]),
  );
  const modelEnvWasExpanded = [...authoredValuesByPath].some(
    ([path, value]) => validationValuesByPath.get(path) !== value,
  );
  const formatError = (ref: TouchedModelRef, error: string) => {
    const redactDependency = Boolean(params.redactDependencyValues && ref.dependency);
    return formatModelRefError(
      ref,
      error,
      redactDependency ? "<configured model reference>" : authoredValuesByPath.get(ref.path),
      { suppressDetail: modelEnvWasExpanded || redactDependency },
    );
  };
  const validationRefsByPath = new Map(
    collectTextModelRefs(validationConfig).map((ref) => [ref.path, ref]),
  );
  const refsByKey = new Map(
    collectTouchedTextModelRefs({
      config: validationConfig,
      previousConfig: validationPreviousConfig,
      touchedPaths: params.touchedPaths,
    }).map((ref) => [modelRefComparisonKey(ref), ref]),
  );
  for (const authoredRef of authoredRefs) {
    if (
      authoredRef.dependency &&
      previousAuthoredValuesByPath.get(authoredRef.path) === authoredRef.value
    ) {
      continue;
    }
    const validationRef = validationRefsByPath.get(authoredRef.path);
    if (!validationRef) {
      continue;
    }
    const key = modelRefComparisonKey(validationRef);
    const expandedRef = refsByKey.get(key);
    refsByKey.set(key, {
      ...validationRef,
      ...(authoredRef.dependency || expandedRef?.dependency ? { dependency: true } : {}),
    });
  }
  const refs = expandInheritedDefaultRefs(validationConfig, [...refsByKey.values()]);
  if (refs.length === 0) {
    return { refsChecked: 0, refsTotal: 0, errors: [] };
  }
  // A bare fallback cannot be accepted while its inherited provider is env-unresolved;
  // leave it unchecked until runtime can determine that provider.
  const refsToValidate = refs.filter(
    (ref) => !hasUnresolvedInheritedFallbackProvider(validationConfig, ref),
  );
  const validatedRefs = refsToValidate.map((ref) => ({
    ref,
    error: validateModelRefSyntax(validationConfig, ref),
  }));
  const syntaxFailures = validatedRefs.filter(
    (entry): entry is { ref: TouchedModelRef; error: string } => Boolean(entry.error),
  );
  const refsToResolve = validatedRefs.filter((entry) => !entry.error).map((entry) => entry.ref);
  const errors = syntaxFailures.map(({ ref, error }) => formatError(ref, error));
  if (refsToResolve.length === 0) {
    return { refsChecked: syntaxFailures.length, refsTotal: refs.length, errors };
  }
  let resolveModelRef = params.resolveModelRef;
  if (!resolveModelRef) {
    try {
      resolveModelRef = await (params.createModelRefResolver ?? createRuntimeModelRefResolver)();
    } catch (cause) {
      const detail =
        modelEnvWasExpanded ||
        Boolean(params.redactDependencyValues && refs.some((ref) => ref.dependency))
          ? "model resolver setup failed"
          : cause instanceof Error
            ? cause.message
            : String(cause);
      return {
        refsChecked: syntaxFailures.length,
        refsTotal: refs.length,
        errors: [
          ...errors,
          `Unable to validate changed model references before writing: ${detail}`,
        ],
      };
    }
  }
  let refsChecked = syntaxFailures.length;
  for (const ref of refsToResolve) {
    let error: string | undefined;
    try {
      error = await resolveModelRef({ config: validationConfig, ref });
      refsChecked += 1;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      errors.push(formatError(ref, `Unable to validate model reference: ${detail}`));
      continue;
    }
    if (!error) {
      continue;
    }
    errors.push(formatError(ref, error));
  }
  return { refsChecked, refsTotal: refs.length, errors };
}
