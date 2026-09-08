// Implements model listing and provider catalog commands.
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { listCliRuntimeModelBackendBindings } from "../../agents/cli-backends.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { resolveModelAuthLabel } from "../../agents/model-auth-label.js";
import {
  modelCatalogBrowseRequiresFullDiscovery,
  MODEL_CATALOG_BROWSE_TIMEOUT_MS,
} from "../../agents/model-catalog-browse.js";
import {
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
  type ModelCatalogAuthChecker,
} from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { createProviderAuthChecker } from "../../agents/model-provider-auth.js";
import { isRetiredModelPickerProvider } from "../../agents/model-runtime-aliases.js";
import {
  dedupeModelCatalogEntries,
  LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH,
  modelCatalogLogicalKey,
} from "../../agents/model-selection-shared.js";
import {
  buildModelAliasIndex,
  normalizeProviderId,
  resolveBareModelDefaultProvider,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import { openAIModelCatalogRoutePolicy } from "../../agents/openai-model-routes.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../../agents/openai-routing.js";
import { PreparedModelCatalogConfigReplacedError } from "../../agents/prepared-model-catalog.errors.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentRuntimeLabel } from "../../status/agent-runtime-label.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../../utils/absolute-deadline.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { resolveRuntimeNormalization } from "./model-runtime-normalization.js";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const MODELS_ADD_DEPRECATED_TEXT =
  "⚠️ /models add is deprecated. Use /models to browse providers and /model to switch models.";

type ModelsCommandSessionEntry = Partial<
  Pick<SessionEntry, "authProfileOverride" | "modelProvider" | "model">
>;

export type ModelsProviderData = {
  byProvider: Map<string, Set<string>>;
  providers: string[];
  resolvedDefault: { provider: string; model: string };
  modelNames: Map<string, string>;
  runtimeChoicesByProvider?: Map<string, ModelsRuntimeChoice[]>;
};

type PreparedModelsProviderData = ModelsProviderData & {
  modelCatalog: ModelCatalogEntry[];
};

type ModelsBrowseOptions = {
  view?: "default" | "all";
  workspaceDir?: string;
};

type ModelsBrowseContext = ModelsBrowseOptions & { agentDir?: string };

export type ModelsRuntimeChoice = {
  id: string;
  label: string;
  description: string;
};

type ParsedModelsCommand =
  | { action: "providers" }
  | {
      action: "list";
      provider?: string;
      page: number;
      pageSize: number;
      all: boolean;
    }
  | {
      action: "add";
      provider?: string;
      modelId?: string;
    };

function isModelsBrowseVisibleProvider(provider: string): boolean {
  return !isRetiredModelPickerProvider(provider);
}

function normalizeRuntimeChoiceId(runtime: string | undefined): string {
  const normalized = normalizeLowercaseStringOrEmpty(runtime);
  if (!normalized || normalized === "auto" || normalized === "default") {
    return "openclaw";
  }
  return normalized;
}

function buildRuntimeChoice(params: {
  cfg: OpenClawConfig;
  provider: string;
  runtime: string;
  cli?: boolean;
}): ModelsRuntimeChoice {
  const id = normalizeRuntimeChoiceId(params.runtime);
  const label = resolveAgentRuntimeLabel({ config: params.cfg, resolvedHarness: id });
  return {
    id,
    label,
    description:
      id === "openclaw"
        ? "Use the built-in OpenClaw runtime."
        : params.cli
          ? `Run ${params.provider} models through ${label}.`
          : `Use the ${label} runtime selected by the effective harness policy.`,
  };
}

function buildDefaultRuntimeChoice(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  provider: string;
  modelId?: string;
}): ModelsRuntimeChoice {
  const harnessPolicy = resolveAgentHarnessPolicy({
    config: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
  });
  return buildRuntimeChoice({
    cfg: params.cfg,
    provider: params.provider,
    runtime: harnessPolicy.runtime,
  });
}

function addRuntimeChoice(
  choices: ModelsRuntimeChoice[],
  choice: ModelsRuntimeChoice,
): ModelsRuntimeChoice[] {
  if (!choices.some((existing) => existing.id === choice.id)) {
    choices.push(choice);
  }
  return choices;
}

export function buildPreparedModelsProviderData(
  cfg: OpenClawConfig,
  agentId?: string,
  options: ModelsBrowseOptions = {},
): Promise<PreparedModelsProviderData> {
  return buildPreparedModelsProviderDataWithContext(cfg, agentId, options);
}

async function buildPreparedModelsProviderDataWithContext(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  options: ModelsBrowseOptions,
  agentDir?: string,
): Promise<PreparedModelsProviderData> {
  const deadlineMs =
    options.view === "all" ? undefined : Date.now() + MODEL_CATALOG_BROWSE_TIMEOUT_MS;
  let currentAgentDir = agentDir;
  let currentConfig = cfg;
  const buildCurrentData = (control: { catalogFallback?: boolean; deadlineMs?: number }) =>
    buildPreparedDataForConfig(
      currentConfig,
      agentId,
      { ...options, agentDir: currentAgentDir },
      control,
    );
  for (;;) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      return buildCurrentData({ catalogFallback: true, deadlineMs });
    }
    try {
      return await buildCurrentData({ deadlineMs });
    } catch (error) {
      if (!isPreparedModelCatalogOwnerReplacement(error)) {
        throw error;
      }
    }
    const owner = await loadPublishedModelsOwner({
      agentId,
      deadlineMs,
      workspaceDir: options.workspaceDir,
    });
    if (!owner) {
      return buildCurrentData({ catalogFallback: true, deadlineMs });
    }
    currentConfig = owner.config;
    currentAgentDir = owner.agentDir;
  }
}

function isPreparedModelCatalogOwnerReplacement(error: unknown): boolean {
  return (
    error instanceof PreparedModelCatalogConfigReplacedError ||
    error instanceof PreparedModelRuntimePublicationSupersededError
  );
}

async function loadPublishedModelsOwner(params: {
  agentId?: string;
  deadlineMs?: number;
  workspaceDir?: string;
}): Promise<PreparedModelRuntimeSnapshot | undefined> {
  for (;;) {
    try {
      const owner = await awaitWithinDeadline(
        () =>
          preparedModelCatalog.loadPublishedPreparedModelCatalogOwnerSnapshot({
            readOnly: true,
            agentId: params.agentId,
            workspaceDir: params.workspaceDir,
          }),
        params.deadlineMs,
      );
      if (owner === ABSOLUTE_DEADLINE_EXPIRED) {
        return undefined;
      }
      return owner;
    } catch (error) {
      if (!isPreparedModelCatalogOwnerReplacement(error)) {
        throw error;
      }
    }
  }
}

async function buildPreparedDataForConfig(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  options: ModelsBrowseContext,
  control: { catalogFallback?: boolean; deadlineMs?: number },
): Promise<PreparedModelsProviderData> {
  const agentDir = options.agentDir ?? (agentId ? resolveAgentDir(cfg, agentId) : undefined);
  const catalogContext = {
    config: cfg,
    ...(agentId ? { agentId } : {}),
    ...(agentDir ? { agentDir } : {}),
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
  };
  const project = (owner?: PreparedModelRuntimeSnapshot) => {
    // Discovery can outlive the browse deadline; retain current configured rows and native auth.
    const preparedOwner =
      owner ??
      preparedModelCatalog.getPreparedModelCatalogOwnerSnapshot({
        ...catalogContext,
        readOnly: true,
      });
    return projectPreparedModelsProviderData(cfg, agentId, options, preparedOwner);
  };
  if (control.catalogFallback) {
    return project();
  }
  const result = await awaitWithinDeadline(
    () =>
      preparedModelCatalog.withPreparedModelCatalogOwner(
        {
          ...catalogContext,
          readOnly: !modelCatalogBrowseRequiresFullDiscovery({ cfg, agentId, view: options.view }),
          refreshFullCatalog: "stale",
        },
        project,
      ),
    control.deadlineMs,
  );
  return result === ABSOLUTE_DEADLINE_EXPIRED ? project() : result;
}

async function projectPreparedModelsProviderData(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  options: ModelsBrowseOptions,
  owner?: PreparedModelRuntimeSnapshot,
): Promise<PreparedModelsProviderData> {
  const runtimeNormalization = resolveRuntimeNormalization(cfg);
  const resolvedDefault = resolveDefaultModelForAgent({
    cfg,
    agentId,
    ...runtimeNormalization,
  });
  const workspaceDir =
    options.workspaceDir ??
    (agentId ? resolveAgentWorkspaceDir(cfg, agentId) : undefined) ??
    resolveDefaultAgentWorkspaceDir();
  const cliRuntimeProviders = new Set(
    listCliRuntimeModelBackendBindings().map((binding) => normalizeProviderId(binding.runtime)),
  );
  const snapshot = owner?.modelCatalog ?? { entries: [], routeVariants: [] };
  const authStore = owner && getPreparedModelRuntimeAuthStore(owner);
  const catalog = snapshot.entries;
  const visibilityPolicy = createModelVisibilityPolicy({
    cfg,
    catalog,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
    agentId,
    ...runtimeNormalization,
  });
  const authChecker = createProviderAuthChecker({
    cfg,
    workspaceDir,
    agentId,
    allowPluginSyntheticAuth: false,
    discoverExternalCliAuth: false,
    allowPreparedRuntimeAuth: true,
    ...(authStore && owner
      ? {
          preparedAuth: { authStore, authModes: owner.authModes },
          metadataSnapshot: owner.metadataSnapshot,
        }
      : {}),
  });
  const logicalModelKey = (entry: { provider: string; id: string }) =>
    openAIModelCatalogRoutePolicy.resolveIdentity(entry)?.key ?? modelCatalogLogicalKey(entry);
  // Configured/default rows may remain visible without auth, but must not
  // reintroduce a model that its provider route contract rejected.
  const incompatibleModelKeys = new Set<string>();
  const hasAuth: ModelCatalogAuthChecker = options.view === "all" ? async () => true : authChecker;
  const visibleCatalog = await resolveLogicalVisibleModelCatalog({
    cfg,
    catalog,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
    agentId,
    workspaceDir,
    view: options.view,
    policy: visibilityPolicy,
    routePolicy: openAIModelCatalogRoutePolicy,
    routeVariants: snapshot.routeVariants,
    evaluateEntry: async (entry, routeVariants) => {
      const identity = openAIModelCatalogRoutePolicy.resolveIdentity(entry);
      const evaluation = await authChecker.evaluateModelAuth(entry.provider, {
        modelId: identity?.id ?? entry.id,
        observedRoutes: routeVariants.map((variant) => ({
          api: variant.api,
          baseUrl: variant.baseUrl,
        })),
      });
      if (evaluation.routeResolution?.kind === "incompatible") {
        incompatibleModelKeys.add(logicalModelKey(entry));
      }
      return resolveLogicalModelCatalogEntryState({
        evaluation,
        authBacked: options.view === "all" || evaluation.availability === true,
        routePolicy: openAIModelCatalogRoutePolicy,
      });
    },
  });

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: resolvedDefault.provider,
    agentId,
    ...runtimeNormalization,
  });
  const restrictToProviderWildcards =
    options.view !== "all" && visibilityPolicy.hasProviderWildcards;
  // Preserve legacy/unrestricted CLI browsing without widening an explicit policy.
  const useUnfilteredCliCatalog =
    options.view === "all" ||
    visibilityPolicy.allowAny ||
    visibilityPolicy.allowConfigPath === LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH;

  const byProvider = new Map<string, Set<string>>();
  const add = (p: string, m: string) => {
    const key = normalizeProviderId(p);
    if (!isModelsBrowseVisibleProvider(key)) {
      return;
    }
    if (
      restrictToProviderWildcards &&
      !(useUnfilteredCliCatalog && cliRuntimeProviders.has(key)) &&
      !visibilityPolicy.allows({ provider: key, model: m })
    ) {
      return;
    }
    const set = byProvider.get(key) ?? new Set<string>();
    set.add(m);
    byProvider.set(key, set);
  };

  const addRawModelRef = (raw?: string) => {
    const trimmed = normalizeOptionalString(raw);
    if (!trimmed) {
      return;
    }
    const defaultProvider = !trimmed.includes("/")
      ? resolveBareModelDefaultProvider({
          cfg,
          catalog,
          model: trimmed,
          defaultProvider: resolvedDefault.provider,
          agentId,
          manifestPlugins: runtimeNormalization.manifestPlugins,
        })
      : resolvedDefault.provider;
    const resolved = resolveModelRefFromString({
      cfg,
      agentId,
      raw: trimmed,
      defaultProvider,
      aliasIndex,
      ...runtimeNormalization,
    });
    if (!resolved) {
      return;
    }
    if (
      incompatibleModelKeys.has(
        logicalModelKey({ provider: resolved.ref.provider, id: resolved.ref.model }),
      )
    ) {
      return;
    }
    add(resolved.ref.provider, resolved.ref.model);
  };

  const addModelConfigEntries = () => {
    const modelConfig = cfg.agents?.defaults?.model;
    if (typeof modelConfig === "string") {
      addRawModelRef(modelConfig);
    } else if (modelConfig && typeof modelConfig === "object") {
      addRawModelRef(modelConfig.primary);
      for (const fallback of modelConfig.fallbacks ?? []) {
        addRawModelRef(fallback);
      }
    }

    const imageConfig = cfg.agents?.defaults?.imageModel;
    if (typeof imageConfig === "string") {
      addRawModelRef(imageConfig);
    } else if (imageConfig && typeof imageConfig === "object") {
      addRawModelRef(imageConfig.primary);
      for (const fallback of imageConfig.fallbacks ?? []) {
        addRawModelRef(fallback);
      }
    }
  };

  for (const entry of visibleCatalog) {
    if (incompatibleModelKeys.has(logicalModelKey(entry))) {
      continue;
    }
    add(entry.provider, entry.id);
  }

  for (const entry of catalog) {
    if (
      useUnfilteredCliCatalog &&
      cliRuntimeProviders.has(normalizeProviderId(entry.provider)) &&
      (await hasAuth(entry.provider, {
        modelId: entry.id,
        api: entry.api,
        baseUrl: entry.baseUrl,
      }))
    ) {
      add(entry.provider, entry.id);
    }
  }

  for (const raw of visibilityPolicy.exactModelRefs) {
    addRawModelRef(raw);
  }

  if (
    !incompatibleModelKeys.has(
      logicalModelKey({ provider: resolvedDefault.provider, id: resolvedDefault.model }),
    )
  ) {
    add(resolvedDefault.provider, resolvedDefault.model);
  }
  addModelConfigEntries();

  const providers = [...byProvider.keys()].toSorted();

  const modelNames = new Map<string, string>();
  for (const entry of [...catalog, ...visibleCatalog]) {
    if (entry.name && entry.name !== entry.id) {
      modelNames.set(`${normalizeProviderId(entry.provider)}/${entry.id}`, entry.name);
    }
  }

  const runtimeChoicesByProvider = new Map<string, ModelsRuntimeChoice[]>();
  const runtimeBindings = [
    { provider: "openai", runtime: "codex", cli: false },
    ...listCliRuntimeModelBackendBindings().map((binding) => ({
      provider: binding.provider,
      runtime: binding.runtime,
      cli: true,
    })),
  ];
  for (const binding of runtimeBindings) {
    const provider = normalizeProviderId(binding.provider);
    const defaultModelId =
      provider === normalizeProviderId(resolvedDefault.provider)
        ? resolvedDefault.model
        : undefined;
    const choices = runtimeChoicesByProvider.get(provider) ?? [
      buildDefaultRuntimeChoice({
        cfg,
        agentId,
        provider,
        modelId: defaultModelId,
      }),
    ];
    addRuntimeChoice(choices, buildRuntimeChoice({ cfg, provider, runtime: "openclaw" }));
    addRuntimeChoice(
      choices,
      buildRuntimeChoice({
        cfg,
        provider,
        runtime: binding.runtime,
        cli: binding.cli,
      }),
    );
    runtimeChoicesByProvider.set(provider, choices);
  }

  // Auth and visibility cross awaits. Retired owners must restart the whole projection.
  if (owner && !owner.isCurrent()) {
    throw new PreparedModelRuntimePublicationSupersededError("model browse owner was superseded");
  }

  return {
    byProvider,
    providers,
    resolvedDefault,
    modelNames,
    // Selection needs the prepared capabilities, with selected physical routes
    // ahead of other inventory rows for the same logical model.
    modelCatalog: dedupeModelCatalogEntries([...visibleCatalog, ...catalog]),
    runtimeChoicesByProvider,
  };
}

function formatProviderLine(params: { provider: string; count: number }): string {
  return `- ${params.provider} (${params.count})`;
}

function parseListArgs(tokens: string[]): Extract<ParsedModelsCommand, { action: "list" }> {
  const provider = normalizeOptionalString(tokens[0]);

  let page = 1;
  let all = false;
  for (const token of tokens.slice(1)) {
    const lower = normalizeLowercaseStringOrEmpty(token);
    if (lower === "all" || lower === "--all") {
      all = true;
      continue;
    }
    if (lower.startsWith("page=")) {
      const value = parseStrictPositiveInteger(lower.slice("page=".length));
      if (value !== undefined) {
        page = value;
      }
      continue;
    }
    const pageToken = parseStrictPositiveInteger(lower);
    if (pageToken !== undefined) {
      page = pageToken;
    }
  }

  let pageSize = PAGE_SIZE_DEFAULT;
  for (const token of tokens) {
    const lower = normalizeLowercaseStringOrEmpty(token);
    if (lower.startsWith("limit=") || lower.startsWith("size=")) {
      const rawValue = lower.slice(lower.indexOf("=") + 1);
      const value = parseStrictPositiveInteger(rawValue);
      if (value !== undefined) {
        pageSize = Math.min(PAGE_SIZE_MAX, value);
      }
    }
  }

  return {
    action: "list",
    provider: provider ? normalizeProviderId(provider) : undefined,
    page,
    pageSize,
    all,
  };
}

function parseModelsArgs(raw: string): ParsedModelsCommand {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { action: "providers" };
  }

  const tokens = trimmed.split(/\s+/g).filter(Boolean);
  const first = normalizeLowercaseStringOrEmpty(tokens[0]);
  switch (first) {
    case "providers":
      return { action: "providers" };
    case "list":
      return parseListArgs(tokens.slice(1));
    case "add":
      return {
        action: "add",
        provider: normalizeOptionalString(tokens[1]),
        modelId: normalizeOptionalString(tokens.slice(2).join(" ")),
      };
    default:
      return parseListArgs(tokens);
  }
}

function resolveProviderLabel(params: {
  provider: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
}): string {
  const harnessPolicy = resolveAgentHarnessPolicy({
    config: params.cfg,
    provider: params.provider,
    agentId: params.agentId,
  });
  const acceptedProviderIds = listOpenAIAuthProfileProvidersForAgentRuntime({
    provider: params.provider,
    harnessRuntime: harnessPolicy.runtime,
    config: params.cfg,
  });
  const authLabel = resolveModelAuthLabel({
    provider: params.provider,
    acceptedProviderIds,
    cfg: params.cfg,
    sessionEntry: params.sessionEntry,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  if (!authLabel || authLabel === "unknown") {
    return params.provider;
  }
  return `${params.provider} · 🔑 ${authLabel}`;
}

export function formatModelsAvailableHeader(params: {
  provider: string;
  total: number;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
}): string {
  const providerLabel = resolveProviderLabel({
    provider: params.provider,
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    sessionEntry: params.sessionEntry,
  });
  return `Models (${providerLabel}) — ${params.total} available`;
}

function buildModelsMenuText(params: {
  providers: string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): string {
  return [
    "Providers:",
    ...params.providers.map((provider) =>
      formatProviderLine({
        provider,
        count: params.byProvider.get(provider)?.size ?? 0,
      }),
    ),
    "",
    "Use: /models <provider>",
    "Switch: /model <provider/model>",
  ].join("\n");
}

function buildProviderInfos(params: {
  providers: string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): Array<{ id: string; count: number }> {
  return params.providers.map((provider) => ({
    id: provider,
    count: params.byProvider.get(provider)?.size ?? 0,
  }));
}

export async function resolveModelsCommandReply(params: {
  cfg: OpenClawConfig;
  commandBodyNormalized: string;
  surface?: string;
  currentModel?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
}): Promise<ReplyPayload | null> {
  const body = params.commandBodyNormalized.trim();
  if (!body.startsWith("/models")) {
    return null;
  }

  const argText = body.replace(/^\/models\b/i, "").trim();
  const parsed = parseModelsArgs(argText);

  const { byProvider, providers, modelNames } = await buildPreparedModelsProviderDataWithContext(
    params.cfg,
    params.agentId,
    {
      ...(parsed.action === "list" && parsed.all ? { view: "all" as const } : {}),
      workspaceDir: params.workspaceDir,
    },
    params.agentDir,
  );
  const commandPlugin = params.surface ? getChannelPlugin(params.surface) : null;
  const providerInfos = buildProviderInfos({ providers, byProvider });

  if (parsed.action === "providers") {
    const channelData =
      commandPlugin?.commands?.buildModelsMenuChannelData?.({
        providers: providerInfos,
      }) ??
      commandPlugin?.commands?.buildModelsProviderChannelData?.({
        providers: providerInfos,
      });
    if (channelData) {
      return {
        text: "Select a provider:",
        channelData,
      };
    }
    return {
      text: buildModelsMenuText({ providers, byProvider }),
    };
  }

  if (parsed.action === "add") {
    return { text: MODELS_ADD_DEPRECATED_TEXT };
  }

  const { provider, page, pageSize, all } = parsed;

  if (!provider) {
    const channelData = commandPlugin?.commands?.buildModelsProviderChannelData?.({
      providers: providerInfos,
    });
    if (channelData) {
      return {
        text: "Select a provider:",
        channelData,
      };
    }
    return {
      text: buildModelsMenuText({ providers, byProvider }),
    };
  }

  if (!byProvider.has(provider)) {
    return {
      text: [
        `Unknown provider: ${provider}`,
        "",
        "Available providers:",
        ...providers.map((entry) => `- ${entry}`),
        "",
        "Use: /models <provider>",
      ].join("\n"),
    };
  }

  const models = [...(byProvider.get(provider) ?? new Set<string>())].toSorted();
  const total = models.length;

  if (total === 0) {
    const emptyProviderLabel = resolveProviderLabel({
      provider,
      cfg: params.cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      sessionEntry: params.sessionEntry,
    });
    return {
      text: [
        `Models (${emptyProviderLabel}) — none`,
        "",
        "Browse: /models",
        "Switch: /model <provider/model>",
      ].join("\n"),
    };
  }

  const interactivePageSize = 8;
  const interactiveTotalPages = Math.max(1, Math.ceil(total / interactivePageSize));
  const interactivePage = Math.max(1, Math.min(page, interactiveTotalPages));
  const interactiveChannelData = commandPlugin?.commands?.buildModelsListChannelData?.({
    provider,
    models,
    currentModel: params.currentModel,
    currentPage: interactivePage,
    totalPages: interactiveTotalPages,
    pageSize: interactivePageSize,
    modelNames,
  });
  if (interactiveChannelData) {
    return {
      text: formatModelsAvailableHeader({
        provider,
        total,
        cfg: params.cfg,
        agentId: params.agentId,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        sessionEntry: params.sessionEntry,
      }),
      channelData: interactiveChannelData,
    };
  }

  const effectivePageSize = all ? total : pageSize;
  const pageCount = effectivePageSize > 0 ? Math.ceil(total / effectivePageSize) : 1;
  const safePage = all ? 1 : Math.max(1, Math.min(page, pageCount));

  if (!all && page !== safePage) {
    return {
      text: [
        `Page out of range: ${page} (valid: 1-${pageCount})`,
        "",
        `Try: /models list ${provider} ${safePage}`,
        `All: /models list ${provider} all`,
      ].join("\n"),
    };
  }

  const startIndex = (safePage - 1) * effectivePageSize;
  const endIndexExclusive = Math.min(total, startIndex + effectivePageSize);
  const pageModels = models.slice(startIndex, endIndexExclusive);
  const providerLabel = resolveProviderLabel({
    provider,
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    sessionEntry: params.sessionEntry,
  });
  const lines = [
    `Models (${providerLabel}) — showing ${startIndex + 1}-${endIndexExclusive} of ${total} (page ${safePage}/${pageCount})`,
  ];
  for (const id of pageModels) {
    lines.push(`- ${provider}/${id}`);
  }
  lines.push("", "Switch: /model <provider/model>");
  if (!all && safePage < pageCount) {
    lines.push(`More: /models list ${provider} ${safePage + 1}`);
  }
  if (!all) {
    lines.push(`All: /models list ${provider} all`);
  }
  return { text: lines.join("\n") };
}

export const handleModelsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const commandBodyNormalized = params.command.commandBodyNormalized.trim();
  if (!commandBodyNormalized.startsWith("/models")) {
    return null;
  }
  const parsed = parseModelsArgs(commandBodyNormalized.replace(/^\/models\b/i, "").trim());
  const unauthorized = rejectUnauthorizedCommand(params, "/models");
  if (unauthorized) {
    return unauthorized;
  }

  if (parsed.action === "add") {
    return { shouldContinue: false, reply: { text: MODELS_ADD_DEPRECATED_TEXT } };
  }

  const modelsAgentId = params.sessionKey
    ? resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: params.cfg,
      })
    : (params.agentId ?? "main");
  const currentAgentId = params.agentId ?? "main";
  const modelsAgentDir =
    modelsAgentId === currentAgentId && params.agentDir
      ? params.agentDir
      : resolveAgentDir(params.cfg, modelsAgentId);
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;

  const reply = await resolveModelsCommandReply({
    cfg: params.cfg,
    commandBodyNormalized,
    surface: params.ctx.Surface,
    currentModel: params.model ? `${params.provider}/${params.model}` : undefined,
    agentId: modelsAgentId,
    agentDir: modelsAgentDir,
    workspaceDir:
      targetSessionEntry?.spawnedWorkspaceDir ??
      (modelsAgentId === currentAgentId ? params.workspaceDir : undefined),
    sessionEntry: targetSessionEntry,
  });
  if (!reply) {
    return null;
  }
  return { reply, shouldContinue: false };
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
