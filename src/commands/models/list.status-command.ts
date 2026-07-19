/** Implementation of `openclaw models status`. */
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { colorize, theme } from "../../../packages/terminal-core/src/theme.js";
import {
  resolveAgentDir,
  resolveAgentExplicitModelPrimary,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  formatRemainingShort,
} from "../../agents/auth-health.js";
import { resolveAuthStorePathForDisplay } from "../../agents/auth-profiles/paths.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  getRuntimeAuthProfileStoreSnapshot,
} from "../../agents/auth-profiles/store.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { resolveProfileUnusableUntilForDisplay } from "../../agents/auth-profiles/usage.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import {
  resolveAgentHarnessOwnerPluginIds,
  resolveAgentHarnessRuntimeAvailability,
  type AgentHarnessRuntimeAvailability,
} from "../../agents/harness/runtime-plugin.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityEvaluation,
  type ModelAuthAvailabilityResolver,
} from "../../agents/model-auth-availability.js";
import {
  listProviderEnvAuthLookupKeys,
  resolveProviderEnvAuthLookupMaps,
} from "../../agents/model-auth-env-vars.js";
import { resolveEnvApiKey } from "../../agents/model-auth.js";
import { loadModelCatalogSnapshot } from "../../agents/model-catalog.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import {
  modelCatalogLogicalKey,
  resolveConfiguredModelPolicyAllow,
} from "../../agents/model-selection-shared.js";
import {
  buildModelAliasIndex,
  isCliProvider,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { OPENAI_PROVIDER_ID } from "../../agents/openai-routing.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import {
  readUtilityModelSetting,
  resolveUtilityModelRefForAgent,
} from "../../agents/utility-model.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { requestExitAfterOneShotOutput } from "../../cli/one-shot-exit.js";
import { createConfigIO } from "../../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import { resolveMergedModelProviderConfig } from "../../config/model-provider-config.js";
import {
  parseStrictFiniteNumber,
  parseStrictPositiveInteger,
} from "../../infra/parse-finite-number.js";
import { getShellEnvAppliedKeys, shouldEnableShellEnvFallback } from "../../infra/shell-env.js";
import type { ProviderModelRouteCandidate } from "../../plugin-sdk/provider-model-types.js";
import {
  captureCurrentPluginMetadataSnapshotState,
  getCurrentPluginMetadataSnapshot,
  restoreCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshot,
} from "../../plugins/current-plugin-metadata-snapshot.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderSyntheticAuthResult } from "../../plugins/provider-external-auth.types.js";
import { resolveProviderSyntheticAuthWithPlugin } from "../../plugins/provider-runtime.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../../plugins/synthetic-auth.runtime.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveUserPath, shortenHomePath } from "../../utils.js";
import { resolveProviderAuthOverview } from "./list.auth-overview.js";
import { isRich } from "./list.format.js";
import type { AuthProbeSummary } from "./list.probe.js";
import type { ProviderAuthOverview } from "./list.types.js";
import { loadModelsConfig } from "./load-config.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  ensureFlagCompatibility,
  resolveKnownAgentId,
} from "./shared.js";

type ProviderUsageRuntime = typeof import("../../infra/provider-usage.js");
type ProgressRuntime = typeof import("../../cli/progress.js");

function resolveEnvAgentDirOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  return override ? resolveUserPath(override, env) : undefined;
}
type TerminalTableRuntime = typeof import("../../../packages/terminal-core/src/table.js");
type ListProbeRuntime = typeof import("./list.probe.js");

const providerUsageRuntimeLoader = createLazyImportLoader<ProviderUsageRuntime>(
  () => import("../../infra/provider-usage.js"),
);
const progressRuntimeLoader = createLazyImportLoader<ProgressRuntime>(
  () => import("../../cli/progress.js"),
);
const terminalTableRuntimeLoader = createLazyImportLoader<TerminalTableRuntime>(
  () => import("../../../packages/terminal-core/src/table.js"),
);
const listProbeRuntimeLoader = createLazyImportLoader<ListProbeRuntime>(
  () => import("./list.probe.js"),
);

const DISPLAY_MODEL_PARSE_OPTIONS = { allowPluginNormalization: false } as const;

type StatusSyntheticAuth = {
  value: string;
  source: string;
  credential?: string;
  mode?: ProviderSyntheticAuthResult["mode"];
  expiresAt?: number;
};

type StatusProviderRouteAuth =
  | {
      /** Provider artifact unavailable; retain the shipped provider-wide behavior. */
      kind: "legacy";
      evaluation: ModelAuthAvailabilityEvaluation;
      usesCodexRuntimeAuth: boolean;
      runtimeAvailability?: AgentHarnessRuntimeAvailability;
    }
  | {
      kind: "route";
      route: ProviderModelRouteCandidate;
      evaluation: ModelAuthAvailabilityEvaluation;
      usesCodexRuntimeAuth: boolean;
      runtimeAvailability?: AgentHarnessRuntimeAvailability;
    }
  | {
      kind: "indeterminate";
      evaluation: ModelAuthAvailabilityEvaluation;
      usesCodexRuntimeAuth: boolean;
      runtimeAvailability?: AgentHarnessRuntimeAvailability;
    }
  | {
      kind: "incompatible";
      code: string;
      message: string;
      evaluation: ModelAuthAvailabilityEvaluation;
      usesCodexRuntimeAuth: false;
      runtimeAvailability?: undefined;
    };

type StatusProviderUseRef = {
  provider: string;
  model: string;
  allowCodexRuntimeFallback: boolean;
  /** Text uses get per-model route analysis; image auth stays provider-wide. */
  routeScope: "text" | "image";
};

type StatusProviderUse = {
  provider: string;
  model: string;
  allowCodexRuntimeFallback: boolean;
  routeAuth: StatusProviderRouteAuth;
};

type StatusRuntimeAuthStatus = "usable" | "missing" | "indeterminate";

type StatusRuntimeAuthRouteBase = {
  provider: string;
  runtime: string;
  authProvider: string;
  effective: ProviderAuthOverview["effective"];
};

type StatusRuntimeAuthRoute =
  | (StatusRuntimeAuthRouteBase & {
      status: StatusRuntimeAuthStatus;
    })
  | (StatusRuntimeAuthRouteBase & {
      status: "unavailable";
      authStatus: StatusRuntimeAuthStatus;
      runtimeStatus: "unavailable";
      runtimeReason: Extract<AgentHarnessRuntimeAvailability, { status: "unavailable" }>["reason"];
      runtimeDetail: string;
      runtimePluginIds: string[];
    });

type StatusModelRouteIssue =
  | {
      kind: "incompatible";
      provider: string;
      model: string;
      code: string;
      message: string;
    }
  | {
      kind: "indeterminate";
      provider: string;
      model: string;
      evidence?: ModelAuthAvailabilityEvaluation["evidence"];
      message: string;
    }
  | {
      kind: "missing-auth";
      provider: string;
      model: string;
      authRequirement: ProviderModelRouteCandidate["authRequirement"];
      message: string;
    };

function loadProviderUsageRuntime(): Promise<ProviderUsageRuntime> {
  return providerUsageRuntimeLoader.load();
}

function loadProgressRuntime(): Promise<ProgressRuntime> {
  return progressRuntimeLoader.load();
}

function loadTerminalTableRuntime(): Promise<TerminalTableRuntime> {
  return terminalTableRuntimeLoader.load();
}

function loadListProbeRuntime(): Promise<ListProbeRuntime> {
  return listProbeRuntimeLoader.load();
}

function parseOptionalPositiveFiniteOption(raw: unknown, label: string, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const parsed = parseStrictFiniteNumber(raw);
  if (parsed === undefined || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return parsed;
}

function parseOptionalPositiveIntegerOption(raw: unknown, label: string, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed === undefined) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function isCompletePluginMetadataSnapshot(value: unknown): value is PluginMetadataSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snapshot = value as Partial<PluginMetadataSnapshot>;
  return (
    typeof snapshot.policyHash === "string" &&
    snapshot.index !== undefined &&
    snapshot.manifestRegistry !== undefined
  );
}

function installCommandPluginMetadataSnapshot(params: {
  snapshot: PluginMetadataSnapshot;
  config: Awaited<ReturnType<typeof loadModelsConfig>>;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): () => void {
  if (!isCompletePluginMetadataSnapshot(params.snapshot)) {
    return () => {};
  }
  const current = getCurrentPluginMetadataSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  if (current) {
    return () => {};
  }
  const previousState = captureCurrentPluginMetadataSnapshotState();
  setCurrentPluginMetadataSnapshot(params.snapshot, {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return () => {
    restoreCurrentPluginMetadataSnapshotState(previousState);
  };
}

function syntheticAuthCredential(
  provider: string,
  auth: StatusSyntheticAuth,
): AuthProfileCredential | undefined {
  if (!auth.mode) {
    return undefined;
  }
  if (auth.mode === "api-key") {
    return {
      type: "api_key",
      provider,
      key: auth.credential,
    };
  }
  if (auth.mode === "token" || auth.mode === "oauth") {
    // Plugin synthetic OAuth is already materialized as a bearer token. Keep
    // it token-shaped so non-expiring credentials do not require refresh data.
    return {
      type: "token",
      provider,
      token: auth.credential,
      expires: auth.expiresAt,
    };
  }
  return undefined;
}

function finishModelsStatusOutput(
  runtime: RuntimeEnv,
  check: boolean | undefined,
  checkStatus: number,
): void {
  if (check) {
    if (!requestExitAfterOneShotOutput(runtime, checkStatus)) {
      runtime.exit(checkStatus);
    }
    return;
  }
  requestExitAfterOneShotOutput(runtime);
}

/** Prints model default, auth, provider, and optional probe status. */
export async function modelsStatusCommand(
  opts: {
    json?: boolean;
    plain?: boolean;
    check?: boolean;
    probe?: boolean;
    probeProvider?: string;
    probeProfile?: string | string[];
    probeTimeout?: string;
    probeConcurrency?: string;
    probeMaxTokens?: string;
    agent?: string;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  if (opts.plain && opts.probe) {
    throw new Error("--probe cannot be used with --plain output.");
  }
  const configPath = createConfigIO().configPath;
  const cfg = await loadModelsConfig({ commandName: "models status", runtime });
  const agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent });
  const workspaceAgentId = agentId ?? resolveDefaultAgentId(cfg);
  const agentDir = agentId
    ? resolveAgentDir(cfg, agentId)
    : (resolveEnvAgentDirOverride() ?? resolveAgentDir(cfg, workspaceAgentId));
  const workspaceDir =
    resolveAgentWorkspaceDir(cfg, workspaceAgentId) ?? resolveDefaultAgentWorkspaceDir();
  const agentModelPrimary = agentId ? resolveAgentExplicitModelPrimary(cfg, agentId) : undefined;
  const agentFallbacksOverride = agentId
    ? resolveAgentModelFallbacksOverride(cfg, agentId)
    : undefined;
  const resolvedConfig =
    agentModelPrimary && agentModelPrimary.length > 0
      ? {
          ...cfg,
          agents: {
            ...cfg.agents,
            defaults: {
              ...cfg.agents?.defaults,
              model: {
                ...(typeof cfg.agents?.defaults?.model === "object"
                  ? cfg.agents.defaults.model
                  : {}),
                primary: agentModelPrimary,
              },
            },
          },
        }
      : cfg;
  const metadataSnapshot = loadManifestMetadataSnapshot({
    config: cfg,
    workspaceDir,
    env: process.env,
  });
  const selectedPluginRootDirs = new Map(
    [...metadataSnapshot.byPluginId].map(([pluginId, plugin]) => [pluginId, plugin.rootDir]),
  );
  const { runPluginPayloadSmokeCheckForManifestRecords } =
    await import("../../cli/update-cli/plugin-payload-validation.js");
  const codexRuntimeAvailabilityByProvider = new Map<
    string,
    Promise<AgentHarnessRuntimeAvailability>
  >();
  const resolveCodexRuntimeAvailability = (
    provider: string,
  ): Promise<AgentHarnessRuntimeAvailability> => {
    const cached = codexRuntimeAvailabilityByProvider.get(provider);
    if (cached) {
      return cached;
    }
    const pending = (async () => {
      const ownerPluginIds = resolveAgentHarnessOwnerPluginIds({
        runtime: "codex",
        provider,
        config: cfg,
        workspaceDir,
      });
      const pluginPayloadSmoke = await runPluginPayloadSmokeCheckForManifestRecords({
        plugins: ownerPluginIds.flatMap((pluginId) => {
          const plugin = metadataSnapshot.byPluginId.get(pluginId);
          return plugin ? [plugin] : [];
        }),
        env: process.env,
      });
      return resolveAgentHarnessRuntimeAvailability({
        runtime: "codex",
        provider,
        config: cfg,
        workspaceDir,
        payloadFailures: pluginPayloadSmoke.failures,
        payloadCheckedPluginIds: pluginPayloadSmoke.checked,
        selectedPluginRootDirs,
      });
    })();
    codexRuntimeAvailabilityByProvider.set(provider, pending);
    return pending;
  };
  const cleanupPluginMetadataSnapshot = installCommandPluginMetadataSnapshot({
    snapshot: metadataSnapshot,
    config: cfg,
    workspaceDir,
    env: process.env,
  });
  try {
    const resolved = resolveConfiguredModelRef({
      cfg: resolvedConfig,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
      ...DISPLAY_MODEL_PARSE_OPTIONS,
    });

    const rawDefaultsModel = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ?? "";
    const rawModel = agentModelPrimary ?? rawDefaultsModel;
    const resolvedLabel = modelKey(resolved.provider, resolved.model);
    const defaultLabel = rawModel || resolvedLabel;
    const defaultsFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
    const fallbacks = agentFallbacksOverride ?? defaultsFallbacks;
    const imageModel = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel) ?? "";
    const imageFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel);
    // Narration/titles ride the utility model on a plain API auth path that can
    // differ from the primary's (e.g. OAuth primary, api_key utility); show the
    // resolved ref so a broken utility credential is inspectable here.
    const utilitySetting = readUtilityModelSetting(cfg, workspaceAgentId);
    const utilityModelRef = resolveUtilityModelRefForAgent({ cfg, agentId: workspaceAgentId });
    // resolveUtilityModelRefForAgent never falls back to the primary model: an
    // unset setting yields the provider-declared default or undefined, so a
    // non-null auto result really is a provider default (unlike the runtime's
    // simple-completion selection, which does fall back to the primary).
    const utilityModelSource =
      utilitySetting.kind === "explicit"
        ? "config"
        : utilitySetting.kind === "disabled"
          ? "disabled"
          : utilityModelRef
            ? "provider-default"
            : "none";
    const aliases = Object.entries(cfg.agents?.defaults?.models ?? {}).reduce<
      Record<string, string>
    >((acc, [key, entry]) => {
      const alias = normalizeOptionalString(entry?.alias);
      if (alias) {
        acc[alias] = key;
      }
      return acc;
    }, {});
    const allowed = [...resolveConfiguredModelPolicyAllow({ cfg, agentId: workspaceAgentId }).refs];

    const modelsPath = path.join(agentDir, "models.json");
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      ...DISPLAY_MODEL_PARSE_OPTIONS,
    });
    const resolveStatusModelRef = (raw: string | undefined) => {
      const modelRef = raw?.trim();
      if (!modelRef) {
        return undefined;
      }
      return resolveModelRefFromString({
        cfg,
        raw: modelRef,
        defaultProvider: DEFAULT_PROVIDER,
        aliasIndex,
        ...DISPLAY_MODEL_PARSE_OPTIONS,
      })?.ref;
    };
    const textUsesOpenAI = [defaultLabel, ...fallbacks].some(
      (raw) =>
        normalizeProviderId(resolveStatusModelRef(raw)?.provider ?? "") === OPENAI_PROVIDER_ID,
    );
    // Match execution's read-only, provider-scoped Codex CLI overlay. This lets
    // status select the same OpenAI subscription profile without scanning
    // unrelated external CLIs or prompting the keychain.
    const store = textUsesOpenAI
      ? ensureAuthProfileStore(agentDir, {
          allowKeychainPrompt: false,
          config: cfg,
          externalCliProviderIds: [OPENAI_PROVIDER_ID],
          readOnly: true,
        })
      : ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
    const providersFromStore = new Set(
      Object.values(store.profiles)
        .map((profile) => normalizeProviderId(profile.provider))
        .filter((p): p is string => Boolean(p)),
    );
    const providersFromConfig = new Set(
      Object.keys(cfg.models?.providers ?? {})
        .map((p) => (typeof p === "string" ? normalizeProviderId(p) : ""))
        .filter(Boolean),
    );
    const providersFromModels = new Set<string>();
    const providerUseRefs: StatusProviderUseRef[] = [];
    const addProviderUse = (
      raw: string | undefined,
      allowCodexRuntimeFallback: boolean,
      routeScope: StatusProviderUseRef["routeScope"],
    ) => {
      const ref = resolveStatusModelRef(raw);
      if (ref?.provider) {
        const provider = normalizeProviderId(ref.provider);
        providerUseRefs.push({
          provider,
          model: ref.model,
          allowCodexRuntimeFallback,
          routeScope,
        });
      }
    };
    for (const raw of [
      defaultLabel,
      ...fallbacks,
      imageModel,
      ...imageFallbacks,
      utilityModelRef ?? "",
      ...allowed,
    ]) {
      const ref = resolveStatusModelRef(raw);
      if (ref?.provider) {
        providersFromModels.add(normalizeProviderId(ref.provider));
      }
    }
    for (const raw of [defaultLabel, ...fallbacks]) {
      addProviderUse(raw, true, "text");
    }
    for (const raw of [imageModel, ...imageFallbacks]) {
      addProviderUse(raw, false, "image");
    }
    // Utility completions (narration/titles) are a text-route auth consumer in
    // their own right: an OAuth-healthy primary does not prove the utility's
    // plain API path, so the ref gets full route analysis without inheriting
    // the primary's codex-runtime fallback.
    addProviderUse(utilityModelRef, false, "text");
    // Display the canonical provider/model: utilityModel accepts aliases, and
    // route issues/probes always report the resolved ref.
    const resolvedUtilityRef = utilityModelRef ? resolveStatusModelRef(utilityModelRef) : undefined;
    const utilityModelDisplayRef = resolvedUtilityRef
      ? modelKey(normalizeProviderId(resolvedUtilityRef.provider), resolvedUtilityRef.model)
      : (utilityModelRef ?? null);

    const providersFromEnv = new Set<string>();
    // Use the shared provider-env registry so `models status` stays aligned with
    // env-backed providers beyond the text-model defaults (for example image-gen).
    const envLookupParams = {
      config: cfg,
      workspaceDir,
      env: process.env,
      metadataSnapshot,
    };
    const { aliasMap, envCandidateMap, authEvidenceMap } =
      resolveProviderEnvAuthLookupMaps(envLookupParams);
    for (const provider of listProviderEnvAuthLookupKeys({ envCandidateMap, authEvidenceMap })) {
      if (
        resolveEnvApiKey(provider, process.env, {
          config: cfg,
          workspaceDir,
          aliasMap,
          candidateMap: envCandidateMap,
          authEvidenceMap,
          skipSetupProviderFallback: true,
        })
      ) {
        providersFromEnv.add(provider);
      }
    }
    const syntheticAuthProviderRefs = new Set(
      resolveRuntimeSyntheticAuthProviderRefs({
        index: metadataSnapshot.index,
        registryDiagnostics: metadataSnapshot.registryDiagnostics,
      }).map((provider) => normalizeProviderId(provider)),
    );
    const catalog = await loadModelCatalogSnapshot({
      config: cfg,
      readOnly: true,
      metadataSnapshot,
    });
    const routeSourcesByModel = new Map<
      string,
      Array<{ api?: (typeof catalog.routeVariants)[number]["api"]; baseUrl?: string }>
    >();
    for (const entry of catalog.routeVariants) {
      if (entry.api === undefined && entry.baseUrl === undefined) {
        continue;
      }
      const key = modelCatalogLogicalKey(entry);
      const sources = routeSourcesByModel.get(key) ?? [];
      sources.push({ api: entry.api, baseUrl: entry.baseUrl });
      routeSourcesByModel.set(key, sources);
    }
    const createStatusAuthResolver = (
      authStore: Parameters<typeof createModelAuthAvailabilityResolver>[0]["authStore"],
    ) =>
      createModelAuthAvailabilityResolver({
        cfg,
        authStore,
        agentDir,
        workspaceDir,
        env: process.env,
        // A generic Codex runtime marker proves only that the harness can be
        // contacted. It is not an OpenAI model credential.
        syntheticAuthProviderRefs: [...syntheticAuthProviderRefs].filter(
          (provider) => provider !== "codex",
        ),
        metadataSnapshot,
      });
    let authResolver = createStatusAuthResolver(store);
    const resolveProviderUses = async (
      resolver: ModelAuthAvailabilityResolver,
    ): Promise<StatusProviderUse[]> =>
      await Promise.all(
        providerUseRefs.map(async (usage) => {
          const observedRoutes = routeSourcesByModel.get(
            modelCatalogLogicalKey({ provider: usage.provider, id: usage.model }),
          );
          const ref = {
            modelId: usage.model,
            ...(observedRoutes ? { observedRoutes } : {}),
          };
          // Image tools own their provider auth behavior. The text-route artifact
          // must not reinterpret image auth as an OpenAI text transport.
          const rawEvaluation: ModelAuthAvailabilityEvaluation =
            usage.routeScope === "text"
              ? resolver.evaluateModelAuth(usage.provider, ref)
              : {
                  availability: resolver.resolveProviderAuthAvailability(usage.provider, ref),
                  routeResolution: null,
                };
          const routeAuth: StatusProviderRouteAuth = await (async () => {
            if (rawEvaluation.routeResolution?.kind === "incompatible") {
              return {
                kind: "incompatible",
                code: rawEvaluation.routeResolution.code,
                message: rawEvaluation.routeResolution.message,
                evaluation: rawEvaluation,
                usesCodexRuntimeAuth: false,
              };
            }
            const usesCodexRuntimeAuth =
              usage.allowCodexRuntimeFallback &&
              resolveAgentHarnessPolicy({
                provider: usage.provider,
                modelId: usage.model,
                ...(rawEvaluation.selectedRoute
                  ? {
                      modelApi: rawEvaluation.selectedRoute.api,
                      modelBaseUrl: rawEvaluation.selectedRoute.baseUrl,
                    }
                  : {}),
                config: cfg,
                agentId: workspaceAgentId,
              }).runtime === "codex";
            if (
              usesCodexRuntimeAuth &&
              usage.provider !== OPENAI_PROVIDER_ID &&
              usage.provider !== "codex"
            ) {
              return {
                kind: "incompatible",
                code: "unsupported-codex-runtime-provider",
                message: `The Codex runtime does not support provider ${usage.provider}.`,
                evaluation: rawEvaluation,
                usesCodexRuntimeAuth: false,
              };
            }
            const runtimeAvailability = usesCodexRuntimeAuth
              ? await resolveCodexRuntimeAvailability(usage.provider)
              : undefined;
            const evaluation = rawEvaluation;
            if (evaluation.selectedRoute) {
              return {
                kind: "route",
                route: evaluation.selectedRoute,
                evaluation,
                usesCodexRuntimeAuth,
                runtimeAvailability,
              };
            }
            if (
              evaluation.routeResolution?.kind === "routes" ||
              evaluation.routeResolution?.kind === "indeterminate"
            ) {
              return {
                kind: "indeterminate",
                evaluation,
                usesCodexRuntimeAuth,
                runtimeAvailability,
              };
            }
            return {
              kind: "legacy",
              evaluation,
              usesCodexRuntimeAuth,
              runtimeAvailability,
            };
          })();
          return {
            provider: usage.provider,
            model: usage.model,
            allowCodexRuntimeFallback: usage.allowCodexRuntimeFallback,
            routeAuth,
          };
        }),
      );
    let providerUses = await resolveProviderUses(authResolver);
    const syntheticAuthByProvider = new Map<string, StatusSyntheticAuth>();
    const runtimeSyntheticAuthByProvider = new Map<string, StatusSyntheticAuth>();
    const cliRuntimeAuthUsages = providerUses
      // Codex harness auth is already modeled by the selected OpenAI route.
      // CLI-runtime aliases are only for distinct backends such as Gemini CLI.
      .filter((usage) => usage.allowCodexRuntimeFallback && !usage.routeAuth.usesCodexRuntimeAuth)
      .map((usage) => {
        const runtimeProvider = resolveCliRuntimeExecutionProvider({
          provider: usage.provider,
          modelId: usage.model,
          cfg,
          agentId: workspaceAgentId,
        });
        const normalizedRuntime = runtimeProvider
          ? normalizeProviderId(runtimeProvider)
          : undefined;
        return normalizedRuntime && normalizedRuntime !== usage.provider
          ? {
              provider: usage.provider,
              model: usage.model,
              allowCodexRuntimeFallback: usage.allowCodexRuntimeFallback,
              runtime: normalizedRuntime,
            }
          : undefined;
      })
      .filter((usage): usage is NonNullable<typeof usage> => Boolean(usage));

    const providers = Array.from(
      new Set([
        ...providersFromStore,
        ...providersFromConfig,
        ...providersFromModels,
        ...providersFromEnv,
        ...cliRuntimeAuthUsages.map((usage) => usage.runtime),
      ]),
    )
      .map((p) => normalizeOptionalString(p) ?? "")
      .filter(Boolean)
      .toSorted((a, b) => a.localeCompare(b));
    const syntheticProvidersToProbe = new Set(
      providers.map((provider) => normalizeProviderId(provider)),
    );
    const codexProvider = normalizeProviderId(OPENAI_PROVIDER_ID);
    const codexProviderAlias = aliasMap[codexProvider] ?? codexProvider;
    let codexRuntimeAuthUsages = providerUses.filter(
      (usage) => usage.routeAuth.usesCodexRuntimeAuth,
    );
    if (codexRuntimeAuthUsages.length > 0) {
      syntheticProvidersToProbe.add(codexProvider);
      syntheticProvidersToProbe.add(codexProviderAlias);
      syntheticProvidersToProbe.add("codex");
    }
    for (const provider of syntheticProvidersToProbe) {
      const normalized = normalizeProviderId(provider);
      if (!syntheticAuthProviderRefs.has(normalized)) {
        continue;
      }
      const resolvedLocal = resolveProviderSyntheticAuthWithPlugin({
        provider: normalized,
        config: cfg,
        context: {
          config: cfg,
          provider: normalized,
          providerConfig: resolveMergedModelProviderConfig(cfg, normalized),
        },
      });
      if (!resolvedLocal) {
        continue;
      }
      const syntheticAuth: StatusSyntheticAuth = {
        value: "plugin-owned",
        source: resolvedLocal.source,
        credential: resolvedLocal.apiKey,
        mode: resolvedLocal.mode,
        expiresAt: resolvedLocal.expiresAt,
      };
      syntheticAuthByProvider.set(normalized, syntheticAuth);
      // The generic Codex token authenticates the local harness, not an
      // OpenAI model route. Only provider-owned synthetic credentials may
      // become concrete evaluator profiles.
      if (normalized !== "codex") {
        runtimeSyntheticAuthByProvider.set(normalized, syntheticAuth);
      }
      if (normalized !== "codex" && normalized === codexProviderAlias) {
        syntheticAuthByProvider.set(codexProvider, syntheticAuth);
      }
    }
    const runtimeCredentialsByProvider = new Map(
      Array.from(runtimeSyntheticAuthByProvider.entries())
        .map(([provider, auth]) => [provider, syntheticAuthCredential(provider, auth)] as const)
        .filter((entry): entry is readonly [string, AuthProfileCredential] => Boolean(entry[1])),
    );
    if (runtimeCredentialsByProvider.size > 0) {
      const syntheticProfiles = Object.fromEntries(
        Array.from(runtimeCredentialsByProvider.entries()).map(([provider, credential]) => [
          `${provider}:runtime-synthetic`,
          credential,
        ]),
      );
      authResolver = createStatusAuthResolver({
        ...store,
        profiles: { ...store.profiles, ...syntheticProfiles },
      });
      providerUses = await resolveProviderUses(authResolver);
      codexRuntimeAuthUsages = providerUses.filter((usage) => usage.routeAuth.usesCodexRuntimeAuth);
    }

    const applied = getShellEnvAppliedKeys();
    const shellFallbackEnabled =
      shouldEnableShellEnvFallback(process.env) || cfg.env?.shellEnv?.enabled === true;

    const providerAuth = Array.from(
      new Set([
        ...providers,
        ...(codexRuntimeAuthUsages.length > 0 && syntheticAuthByProvider.has(codexProvider)
          ? [codexProvider]
          : []),
      ]),
    )
      .toSorted((a, b) => a.localeCompare(b))
      .map((provider) =>
        resolveProviderAuthOverview({
          provider,
          cfg,
          store,
          modelsPath,
          agentDir,
          workspaceDir,
          syntheticAuth: syntheticAuthByProvider.get(provider),
          aliasMap,
          envCandidateMap,
          authEvidenceMap,
        }),
      )
      .filter((entry) => {
        const hasAny =
          entry.profiles.count > 0 ||
          Boolean(entry.env) ||
          Boolean(entry.modelsJson) ||
          Boolean(entry.syntheticAuth);
        return hasAny;
      });
    const providerAuthMap = new Map(providerAuth.map((entry) => [entry.provider, entry]));
    const missingProviderAuthEffective: ProviderAuthOverview["effective"] = {
      kind: "missing",
      detail: "missing",
    };
    const runtimeAuthStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
    const healthStore = runtimeAuthStore
      ? {
          ...store,
          profiles: { ...store.profiles, ...runtimeAuthStore.profiles },
        }
      : store;
    const authHealth = buildAuthHealthSummary({
      store: healthStore,
      cfg,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
      runtimeCredentialsByProvider,
      allowKeychainPrompt: false,
    });
    const authProfileHealthById = new Map(
      authHealth.profiles.map((profile) => [profile.profileId, profile]),
    );
    const resolveProviderAuthHealthId = (provider: string): string =>
      resolveProviderIdForAuth(provider, envLookupParams);
    const resolveRuntimeAuthRouteEffective = (
      provider: string,
      evaluation?: ModelAuthAvailabilityEvaluation,
    ): ProviderAuthOverview["effective"] => {
      if (!evaluation) {
        return providerAuthMap.get(provider)?.effective ?? missingProviderAuthEffective;
      }
      if (evaluation?.availability === false) {
        return missingProviderAuthEffective;
      }
      const candidates = Array.from(
        new Set([normalizeProviderId(provider), resolveProviderAuthHealthId(provider)]),
      );
      const profileId = evaluation.selectedProfileId;
      if (profileId) {
        const credentialProvider = store.profiles[profileId]?.provider ?? provider;
        const source = providerAuthMap.get(
          resolveProviderAuthHealthId(credentialProvider),
        )?.effective;
        return source && source.kind !== "missing"
          ? source
          : { kind: "profiles", detail: profileId };
      }
      for (const candidate of candidates) {
        const auth = providerAuthMap.get(candidate);
        if (evaluation.evidence === "environment" && auth?.env) {
          return { kind: "env", detail: auth.env.value };
        }
        if (
          (evaluation.evidence === "provider-config" || evaluation.evidence === "runtime") &&
          auth?.modelsJson
        ) {
          return { kind: "models.json", detail: auth.modelsJson.value };
        }
        if (evaluation.evidence === "synthetic" && syntheticAuthByProvider.has(candidate)) {
          return {
            kind: "synthetic",
            detail: syntheticAuthByProvider.get(candidate)?.source ?? "plugin-owned",
          };
        }
      }
      const direct = providerAuthMap.get(provider)?.effective;
      return direct ?? missingProviderAuthEffective;
    };
    const resolveCliRuntimeAuthProvider = (usage: (typeof providerUses)[number]) =>
      cliRuntimeAuthUsages.find(
        (candidate) =>
          candidate.provider === usage.provider &&
          candidate.model === usage.model &&
          candidate.allowCodexRuntimeFallback === usage.allowCodexRuntimeFallback,
      )?.runtime;
    const hasUsableAuthForProviderInUse = (usage: (typeof providerUses)[number]): boolean => {
      const cliRuntimeAuthProvider = resolveCliRuntimeAuthProvider(usage);
      if (cliRuntimeAuthProvider) {
        return authResolver.resolveProviderAuthAvailability(cliRuntimeAuthProvider) !== false;
      }
      if (usage.routeAuth.kind === "incompatible") {
        // Route contract failures are reported separately from missing auth.
        return true;
      }
      // Unknown evidence is reported as indeterminate, not missing auth.
      return usage.routeAuth.evaluation.availability !== false;
    };
    const codexRuntimeUsagesByProvider = new Map<string, StatusProviderUse[]>();
    for (const usage of codexRuntimeAuthUsages) {
      const usages = codexRuntimeUsagesByProvider.get(usage.provider) ?? [];
      usages.push(usage);
      codexRuntimeUsagesByProvider.set(usage.provider, usages);
    }
    const runtimeAuthRouteEntries: Array<readonly [string, StatusRuntimeAuthRoute]> = [
      ...Array.from(codexRuntimeUsagesByProvider.entries()).map(([provider, usages]) => {
        const representative =
          usages.find((usage) => usage.routeAuth.evaluation.availability === true) ?? usages[0];
        const effective = resolveRuntimeAuthRouteEffective(
          codexProvider,
          representative?.routeAuth.evaluation,
        );
        const availabilities = usages.map((usage) => usage.routeAuth.evaluation.availability);
        const authStatus = availabilities.every((availability) => availability === true)
          ? "usable"
          : availabilities.some((availability) => availability === false)
            ? "missing"
            : "indeterminate";
        const runtimeAvailability = representative?.routeAuth.runtimeAvailability;
        const route: StatusRuntimeAuthRoute =
          runtimeAvailability?.status === "unavailable"
            ? {
                provider,
                runtime: "codex",
                authProvider: codexProvider,
                status: "unavailable",
                effective,
                authStatus,
                runtimeStatus: runtimeAvailability.status,
                runtimeReason: runtimeAvailability.reason,
                runtimeDetail: runtimeAvailability.detail,
                runtimePluginIds: runtimeAvailability.ownerPluginIds,
              }
            : {
                provider,
                runtime: "codex",
                authProvider: codexProvider,
                status: authStatus,
                effective,
              };
        return [`${provider}:codex:${codexProvider}`, route] as const;
      }),
      ...cliRuntimeAuthUsages.map((usage) => {
        const evaluation = authResolver.evaluateModelAuth(usage.runtime);
        const effective = resolveRuntimeAuthRouteEffective(usage.runtime, evaluation);
        return [
          `${usage.provider}:${usage.runtime}:${usage.runtime}`,
          {
            provider: usage.provider,
            runtime: usage.runtime,
            authProvider: usage.runtime,
            status:
              evaluation.availability === true
                ? "usable"
                : evaluation.availability === false
                  ? "missing"
                  : "indeterminate",
            effective,
          },
        ] as const;
      }),
    ];
    const runtimeAuthRoutes = Array.from(
      new Map<string, StatusRuntimeAuthRoute>(runtimeAuthRouteEntries).values(),
    ).toSorted((a, b) => a.provider.localeCompare(b.provider));
    const modelRouteIssues = providerUses.flatMap<StatusModelRouteIssue>((usage) => {
      const cliRuntimeAuthProvider = resolveCliRuntimeAuthProvider(usage);
      const evaluation = cliRuntimeAuthProvider
        ? authResolver.evaluateModelAuth(cliRuntimeAuthProvider)
        : usage.routeAuth.evaluation;
      if (usage.routeAuth.kind === "incompatible") {
        return [
          {
            kind: "incompatible" as const,
            provider: usage.provider,
            model: usage.model,
            code: usage.routeAuth.code,
            message: usage.routeAuth.message,
          },
        ];
      }
      if (evaluation.availability === undefined) {
        return [
          {
            kind: "indeterminate" as const,
            provider: usage.provider,
            model: usage.model,
            ...(evaluation.evidence ? { evidence: evaluation.evidence } : {}),
            message: `Auth readiness could not be confirmed for ${usage.provider}/${usage.model}.`,
          },
        ];
      }
      if (usage.routeAuth.kind !== "route" || evaluation.availability) {
        return [];
      }
      const authRequirement = usage.routeAuth.route.authRequirement;
      return [
        {
          kind: "missing-auth" as const,
          provider: usage.provider,
          model: usage.model,
          authRequirement,
          message: `No usable ${authRequirement} authentication is available for ${usage.provider}/${usage.model}.`,
        },
      ];
    });
    // Utility (or duplicate fallback) refs can repeat a configured model;
    // identical diagnostics collapse while genuinely different evaluations
    // for the same model (e.g. codex-fallback vs plain route) stay separate.
    const seenRouteIssues = new Set<string>();
    const dedupedModelRouteIssues = modelRouteIssues.filter((issue) => {
      const key = JSON.stringify(issue);
      if (seenRouteIssues.has(key)) {
        return false;
      }
      seenRouteIssues.add(key);
      return true;
    });
    const missingProvidersInUse = Array.from(
      new Set(
        providerUses
          .filter((usage) => !hasUsableAuthForProviderInUse(usage))
          .map((usage) => resolveCliRuntimeAuthProvider(usage) ?? usage.provider),
      ),
    )
      .filter(
        (provider) =>
          !isCliProvider(provider, cfg) ||
          cliRuntimeAuthUsages.some((usage) => usage.runtime === provider),
      )
      .toSorted((a, b) => a.localeCompare(b));

    const probeProfileIds = (() => {
      if (!opts.probeProfile) {
        return [];
      }
      const raw = Array.isArray(opts.probeProfile) ? opts.probeProfile : [opts.probeProfile];
      return raw
        .flatMap((value) => (value ?? "").split(","))
        .map((value) => value.trim())
        .filter(Boolean);
    })();
    const probeTimeoutMs = parseOptionalPositiveFiniteOption(
      opts.probeTimeout,
      "--probe-timeout",
      8000,
    );
    const probeConcurrency = parseOptionalPositiveIntegerOption(
      opts.probeConcurrency,
      "--probe-concurrency",
      2,
    );
    const probeMaxTokens = parseOptionalPositiveIntegerOption(
      opts.probeMaxTokens,
      "--probe-max-tokens",
      8,
    );

    const rawCandidates = [
      rawModel || resolvedLabel,
      ...fallbacks,
      imageModel,
      ...imageFallbacks,
      // Probe the configured utility model itself; an arbitrary catalog model
      // from the same provider can sit on a different auth route.
      utilityModelRef ?? "",
      ...allowed,
    ].filter(Boolean);
    const resolvedCandidates = rawCandidates
      .map(
        (raw) =>
          resolveModelRefFromString({
            raw: raw ?? "",
            defaultProvider: DEFAULT_PROVIDER,
            aliasIndex,
            ...DISPLAY_MODEL_PARSE_OPTIONS,
          })?.ref,
      )
      .filter((ref): ref is { provider: string; model: string } => Boolean(ref));
    const modelCandidates = resolvedCandidates.map((ref) => `${ref.provider}/${ref.model}`);

    let probeSummary: AuthProbeSummary | undefined;
    if (opts.probe) {
      const [{ withProgressTotals }, { runAuthProbes }] = await Promise.all([
        loadProgressRuntime(),
        loadListProbeRuntime(),
      ]);
      probeSummary = await withProgressTotals(
        { label: "Probing auth profiles…", total: 1 },
        async (update) => {
          return await runAuthProbes({
            cfg,
            agentId: workspaceAgentId,
            agentDir,
            workspaceDir,
            providers,
            modelCandidates,
            options: {
              provider: opts.probeProvider,
              profileIds: probeProfileIds,
              timeoutMs: probeTimeoutMs,
              concurrency: probeConcurrency,
              maxTokens: probeMaxTokens,
            },
            onProgress: update,
          });
        },
      );
    }

    const providersWithOauth = providerAuth
      .filter(
        (entry) =>
          entry.profiles.oauth > 0 ||
          entry.profiles.token > 0 ||
          entry.env?.value === "OAuth (env)",
      )
      .map((entry) => {
        const count =
          entry.profiles.oauth +
          entry.profiles.token +
          (entry.env?.value === "OAuth (env)" ? 1 : 0);
        return `${entry.provider} (${count})`;
      });

    const oauthProfiles = authHealth.profiles.filter(
      (profile) => profile.type === "oauth" || profile.type === "token",
    );

    const unusableProfiles = (() => {
      const now = Date.now();
      const out: Array<{
        profileId: string;
        provider?: string;
        kind: "cooldown" | "disabled";
        reason?: string;
        until: number;
        remainingMs: number;
      }> = [];
      for (const profileId of Object.keys(store.usageStats ?? {})) {
        const unusableUntil = resolveProfileUnusableUntilForDisplay(store, profileId);
        if (!unusableUntil || now >= unusableUntil) {
          continue;
        }
        const stats = store.usageStats?.[profileId];
        const kind =
          typeof stats?.disabledUntil === "number" && now < stats.disabledUntil
            ? "disabled"
            : "cooldown";
        out.push({
          profileId,
          provider: store.profiles[profileId]?.provider,
          kind,
          reason: stats?.disabledReason,
          until: unusableUntil,
          remainingMs: unusableUntil - now,
        });
      }
      return out.toSorted((a, b) => a.remainingMs - b.remainingMs);
    })();

    const checkStatus = (() => {
      type RequirementHealth = "ok" | "expiring" | "missing" | "indeterminate";
      const resolveRouteAuthHealth = (usage: StatusProviderUse): RequirementHealth => {
        if (usage.routeAuth.kind === "incompatible") {
          return "missing";
        }
        const cliRuntimeAuthProvider = resolveCliRuntimeAuthProvider(usage);
        const evaluation = cliRuntimeAuthProvider
          ? authResolver.evaluateModelAuth(cliRuntimeAuthProvider)
          : usage.routeAuth.evaluation;
        if (evaluation.availability === undefined) {
          return "indeterminate";
        }
        if (!evaluation.availability) {
          return "missing";
        }
        const profileId = evaluation.selectedProfileId;
        if (!profileId) {
          return "ok";
        }
        const health = authProfileHealthById.get(profileId);
        if (health?.status === "expiring") {
          return "expiring";
        }
        if (health?.status === "expired" || health?.status === "missing") {
          return "missing";
        }
        return "ok";
      };
      const routeAuthHealth = new Set(providerUses.map(resolveRouteAuthHealth));
      const hasExpiredOrMissing =
        dedupedModelRouteIssues.some(
          (issue) => issue.kind === "incompatible" || issue.kind === "indeterminate",
        ) ||
        routeAuthHealth.has("missing") ||
        routeAuthHealth.has("indeterminate") ||
        runtimeAuthRoutes.some((route) => route.status === "unavailable") ||
        missingProvidersInUse.length > 0;
      const hasExpiring = routeAuthHealth.has("expiring");
      if (hasExpiredOrMissing) {
        return 1;
      }
      if (hasExpiring) {
        return 2;
      }
      return 0;
    })();

    if (opts.json) {
      writeRuntimeJson(runtime, {
        configPath,
        ...(agentId ? { agentId } : {}),
        agentDir,
        defaultModel: defaultLabel,
        resolvedDefault: resolvedLabel,
        fallbacks,
        imageModel: imageModel || null,
        imageFallbacks,
        utilityModel: { ref: utilityModelDisplayRef, source: utilityModelSource },
        ...(agentId
          ? {
              modelConfig: {
                defaultSource: agentModelPrimary ? "agent" : "defaults",
                fallbacksSource: agentFallbacksOverride !== undefined ? "agent" : "defaults",
              },
            }
          : {}),
        aliases,
        allowed,
        auth: {
          storePath: resolveAuthStorePathForDisplay(agentDir),
          shellEnvFallback: {
            enabled: shellFallbackEnabled,
            appliedKeys: applied,
          },
          providersWithOAuth: providersWithOauth,
          missingProvidersInUse,
          modelRouteIssues: dedupedModelRouteIssues,
          runtimeAuthRoutes,
          providers: providerAuth,
          unusableProfiles,
          oauth: {
            warnAfterMs: authHealth.warnAfterMs,
            profiles: authHealth.profiles,
            providers: authHealth.providers,
          },
          probes: probeSummary,
        },
      });
      finishModelsStatusOutput(runtime, opts.check, checkStatus);
      return;
    }

    if (opts.plain) {
      runtime.log(resolvedLabel);
      finishModelsStatusOutput(runtime, opts.check, checkStatus);
      return;
    }

    const rich = isRich(opts);
    type ModelConfigSource = "agent" | "defaults";
    const label = (value: string) => colorize(rich, theme.accent, value.padEnd(14));
    const labelWithSource = (value: string, source?: ModelConfigSource) =>
      label(source ? `${value} (${source})` : value);
    const displayDefault =
      rawModel && rawModel !== resolvedLabel
        ? `${resolvedLabel} (from ${rawModel})`
        : resolvedLabel;

    runtime.log(
      `${label("Config")}${colorize(rich, theme.muted, ":")} ${colorize(rich, theme.info, shortenHomePath(configPath))}`,
    );
    runtime.log(
      `${label("Agent dir")}${colorize(rich, theme.muted, ":")} ${colorize(
        rich,
        theme.info,
        shortenHomePath(agentDir),
      )}`,
    );
    runtime.log(
      `${labelWithSource("Default", agentId ? (agentModelPrimary ? "agent" : "defaults") : undefined)}${colorize(
        rich,
        theme.muted,
        ":",
      )} ${colorize(rich, theme.success, displayDefault)}`,
    );
    runtime.log(
      `${labelWithSource(
        `Fallbacks (${fallbacks.length || 0})`,
        agentId ? (agentFallbacksOverride !== undefined ? "agent" : "defaults") : undefined,
      )}${colorize(rich, theme.muted, ":")} ${colorize(
        rich,
        fallbacks.length ? theme.warn : theme.muted,
        fallbacks.length ? fallbacks.join(", ") : "-",
      )}`,
    );
    runtime.log(
      `${label("Utility model")}${colorize(rich, theme.muted, ":")} ${colorize(
        rich,
        utilityModelDisplayRef ? theme.success : theme.muted,
        utilityModelDisplayRef
          ? `${utilityModelDisplayRef}${utilityModelSource === "provider-default" ? " (provider default)" : ""}`
          : utilityModelSource === "disabled"
            ? "off"
            : "-",
      )}`,
    );
    runtime.log(
      `${labelWithSource("Image model", agentId ? "defaults" : undefined)}${colorize(
        rich,
        theme.muted,
        ":",
      )} ${colorize(rich, imageModel ? theme.accentBright : theme.muted, imageModel || "-")}`,
    );
    runtime.log(
      `${labelWithSource(
        `Image fallbacks (${imageFallbacks.length || 0})`,
        agentId ? "defaults" : undefined,
      )}${colorize(rich, theme.muted, ":")} ${colorize(
        rich,
        imageFallbacks.length ? theme.accentBright : theme.muted,
        imageFallbacks.length ? imageFallbacks.join(", ") : "-",
      )}`,
    );
    runtime.log(
      `${label(`Aliases (${Object.keys(aliases).length || 0})`)}${colorize(rich, theme.muted, ":")} ${colorize(
        rich,
        Object.keys(aliases).length ? theme.accent : theme.muted,
        Object.keys(aliases).length
          ? Object.entries(aliases)
              .map(([alias, target]) =>
                rich
                  ? `${theme.accentDim(alias)} ${theme.muted("->")} ${theme.info(target)}`
                  : `${alias} -> ${target}`,
              )
              .join(", ")
          : "-",
      )}`,
    );
    runtime.log(
      `${label(`Allowed models (${allowed.length || 0})`)}${colorize(rich, theme.muted, ":")} ${colorize(
        rich,
        allowed.length ? theme.info : theme.muted,
        allowed.length ? allowed.join(", ") : "all",
      )}`,
    );

    runtime.log("");
    runtime.log(colorize(rich, theme.heading, "Auth overview"));
    runtime.log(
      `${label("Auth store")}${colorize(rich, theme.muted, ":")} ${colorize(
        rich,
        theme.info,
        shortenHomePath(resolveAuthStorePathForDisplay(agentDir)),
      )}`,
    );
    runtime.log(
      `${label("Shell env")}${colorize(rich, theme.muted, ":")} ${colorize(
        rich,
        shellFallbackEnabled ? theme.success : theme.muted,
        shellFallbackEnabled ? "on" : "off",
      )}${applied.length ? colorize(rich, theme.muted, ` (applied: ${applied.join(", ")})`) : ""}`,
    );
    runtime.log(
      `${label(`Providers w/ OAuth/tokens (${providersWithOauth.length || 0})`)}${colorize(
        rich,
        theme.muted,
        ":",
      )} ${colorize(
        rich,
        providersWithOauth.length ? theme.info : theme.muted,
        providersWithOauth.length ? providersWithOauth.join(", ") : "-",
      )}`,
    );

    const formatKey = (key: string) => colorize(rich, theme.warn, key);
    const formatKeyValue = (key: string, value: string) =>
      `${formatKey(key)}=${colorize(rich, theme.info, value)}`;
    const formatSeparator = () => colorize(rich, theme.muted, " | ");

    for (const entry of providerAuth) {
      const separator = formatSeparator();
      const bits: string[] = [];
      bits.push(
        formatKeyValue(
          "effective",
          `${colorize(rich, theme.accentBright, entry.effective.kind)}:${colorize(
            rich,
            theme.muted,
            entry.effective.detail,
          )}`,
        ),
      );
      if (entry.profiles.count > 0) {
        bits.push(
          formatKeyValue(
            "profiles",
            `${entry.profiles.count} (oauth=${entry.profiles.oauth}, token=${entry.profiles.token}, api_key=${entry.profiles.apiKey})`,
          ),
        );
        if (entry.profiles.labels.length > 0) {
          bits.push(colorize(rich, theme.info, entry.profiles.labels.join(", ")));
        }
      }
      if (entry.env) {
        bits.push(
          formatKeyValue(
            "env",
            `${entry.env.value}${separator}${formatKeyValue("source", entry.env.source)}`,
          ),
        );
      }
      if (entry.modelsJson) {
        bits.push(
          formatKeyValue(
            "models.json",
            `${entry.modelsJson.value}${separator}${formatKeyValue("source", entry.modelsJson.source)}`,
          ),
        );
      }
      if (entry.syntheticAuth) {
        bits.push(
          formatKeyValue(
            "synthetic",
            `${entry.syntheticAuth.value}${separator}${formatKeyValue("source", entry.syntheticAuth.source)}`,
          ),
        );
      }
      runtime.log(`- ${theme.heading(entry.provider)} ${bits.join(separator)}`);
    }

    if (runtimeAuthRoutes.length > 0) {
      runtime.log("");
      runtime.log(colorize(rich, theme.heading, "Runtime auth"));
      for (const route of runtimeAuthRoutes) {
        const runtimeAvailability =
          route.status === "unavailable"
            ? `${formatSeparator()}${formatKeyValue(
                "auth",
                route.authStatus,
              )}${formatSeparator()}${formatKeyValue("runtime", route.runtimeStatus)}${
                route.runtimeDetail
                  ? `${formatSeparator()}${colorize(rich, theme.muted, route.runtimeDetail)}`
                  : ""
              }`
            : "";
        runtime.log(
          `- ${theme.heading(route.provider)} via ${colorize(
            rich,
            theme.accentBright,
            route.runtime,
          )} uses ${theme.heading(route.authProvider)} ${formatKeyValue(
            "effective",
            `${colorize(rich, theme.accentBright, route.effective.kind)}:${colorize(
              rich,
              theme.muted,
              route.effective.detail,
            )}`,
          )}${formatSeparator()}${formatKeyValue("status", route.status)}${runtimeAvailability}`,
        );
      }
    }

    if (dedupedModelRouteIssues.length > 0) {
      runtime.log("");
      runtime.log(colorize(rich, theme.heading, "Model route issues"));
      for (const issue of dedupedModelRouteIssues) {
        const modelRef = `${issue.provider}/${issue.model}`;
        if (issue.kind === "incompatible") {
          runtime.log(`- ${theme.heading(modelRef)} [${issue.code}] ${issue.message}`);
          continue;
        }
        if (issue.kind === "indeterminate") {
          runtime.log(`- ${theme.heading(modelRef)} [indeterminate] ${issue.message}`);
          continue;
        }
        runtime.log(
          `- ${theme.heading(modelRef)} requires ${issue.authRequirement} auth: ${issue.message}`,
        );
      }
    }

    if (missingProvidersInUse.length > 0) {
      const { buildProviderAuthRecoveryHint } =
        await import("../../agents/provider-auth-recovery-hint.js");
      runtime.log("");
      runtime.log(colorize(rich, theme.heading, "Missing auth"));
      for (const provider of missingProvidersInUse) {
        const requiresSubscription = dedupedModelRouteIssues.some(
          (issue) =>
            issue.kind === "missing-auth" &&
            issue.provider === provider &&
            issue.authRequirement === "subscription",
        );
        const hint = buildProviderAuthRecoveryHint({
          provider,
          config: cfg,
          includeEnvVar: !requiresSubscription,
        });
        runtime.log(`- ${theme.heading(provider)} ${hint}`);
      }
    }

    runtime.log("");
    runtime.log(colorize(rich, theme.heading, "OAuth/token status"));
    if (oauthProfiles.length === 0) {
      runtime.log(colorize(rich, theme.muted, "- none"));
    } else {
      const { formatUsageWindowSummary, loadProviderUsageSummary, resolveUsageProviderId } =
        await loadProviderUsageRuntime();
      const usageByProvider = new Map<string, string>();
      const usageProviders = Array.from(
        new Set(
          oauthProfiles
            .map((profile) =>
              resolveUsageProviderId(profile.provider, { credentialType: profile.type }),
            )
            .filter((provider): provider is NonNullable<typeof provider> => Boolean(provider)),
        ),
      );
      if (usageProviders.length > 0) {
        try {
          const usageSummary = await loadProviderUsageSummary({
            providers: usageProviders,
            agentDir,
            timeoutMs: 3500,
          });
          for (const snapshot of usageSummary.providers) {
            const formatted = formatUsageWindowSummary(snapshot, {
              now: Date.now(),
              maxWindows: 2,
              includeResets: true,
            });
            if (formatted) {
              usageByProvider.set(snapshot.provider, formatted);
            }
          }
        } catch {
          // ignore usage failures
        }
      }

      const formatStatus = (status: string) => {
        if (status === "ok") {
          return colorize(rich, theme.success, "ok");
        }
        if (status === "static") {
          return colorize(rich, theme.muted, "static");
        }
        if (status === "expiring") {
          return colorize(rich, theme.warn, "expiring");
        }
        if (status === "missing") {
          return colorize(rich, theme.warn, "unknown");
        }
        return colorize(rich, theme.error, "expired");
      };

      const profilesByProvider = new Map<string, typeof oauthProfiles>();
      for (const profile of oauthProfiles) {
        const current = profilesByProvider.get(profile.provider);
        if (current) {
          current.push(profile);
        } else {
          profilesByProvider.set(profile.provider, [profile]);
        }
      }

      for (const [provider, profiles] of profilesByProvider) {
        const usageProfile = profiles.find(
          (profile) => profile.type === "oauth" || profile.type === "token",
        );
        const usageKey = resolveUsageProviderId(provider, {
          credentialType: usageProfile?.type,
        });
        const usage = usageKey ? usageByProvider.get(usageKey) : undefined;
        const usageSuffix = usage ? colorize(rich, theme.muted, ` usage: ${usage}`) : "";
        runtime.log(`- ${colorize(rich, theme.heading, provider)}${usageSuffix}`);
        for (const profile of profiles) {
          const labelText = profile.label || profile.profileId;
          const labelLocal = colorize(rich, theme.accent, labelText);
          const status = formatStatus(profile.status);
          const expiry =
            profile.status === "static"
              ? ""
              : profile.expiresAt
                ? ` expires in ${formatRemainingShort(profile.remainingMs)}`
                : " expires unknown";
          runtime.log(`  - ${labelLocal} ${status}${expiry}`);
        }
      }
    }

    if (probeSummary) {
      const [
        { getTerminalTableWidth, renderTable },
        { describeProbeSummary, formatProbeLatency, sortProbeResults },
      ] = await Promise.all([loadTerminalTableRuntime(), loadListProbeRuntime()]);
      runtime.log("");
      runtime.log(colorize(rich, theme.heading, "Auth probes"));
      if (probeSummary.results.length === 0) {
        runtime.log(colorize(rich, theme.muted, "- none"));
      } else {
        const tableWidth = getTerminalTableWidth();
        const sorted = sortProbeResults(probeSummary.results);
        const statusColor = (status: string) => {
          if (status === "ok") {
            return theme.success;
          }
          if (status === "rate_limit") {
            return theme.warn;
          }
          if (status === "timeout" || status === "billing") {
            return theme.warn;
          }
          if (status === "auth" || status === "format") {
            return theme.error;
          }
          if (status === "no_model") {
            return theme.muted;
          }
          return theme.muted;
        };
        const rows = sorted.map((result) => {
          const status = colorize(rich, statusColor(result.status), result.status);
          const latency = formatProbeLatency(result.latencyMs);
          const modelLabel = result.model ?? `${result.provider}/-`;
          const modeLabel = result.mode
            ? ` ${colorize(rich, theme.muted, `(${result.mode})`)}`
            : "";
          const profile = `${colorize(rich, theme.accent, result.label)}${modeLabel}`;
          const detail = result.error?.trim();
          const detailLabel = detail ? `\n${colorize(rich, theme.muted, `↳ ${detail}`)}` : "";
          const statusLabel = `${status}${colorize(rich, theme.muted, ` · ${latency}`)}${detailLabel}`;
          return {
            Model: colorize(rich, theme.heading, modelLabel),
            Profile: profile,
            Status: statusLabel,
          };
        });
        runtime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Model", header: "Model", minWidth: 18 },
              { key: "Profile", header: "Profile", minWidth: 24 },
              { key: "Status", header: "Status", minWidth: 12 },
            ],
            rows,
          }).trimEnd(),
        );
        runtime.log(colorize(rich, theme.muted, describeProbeSummary(probeSummary)));
      }
    }
    finishModelsStatusOutput(runtime, opts.check, checkStatus);
  } finally {
    cleanupPluginMetadataSnapshot();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
