// Doctor warnings and repairs for legacy OpenAI Codex model/provider routing.
import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeFastMode,
  normalizeOptionalLowercaseString as normalizeString,
} from "@openclaw/normalization-core/string-coerce";
import {
  isAgentRuntimeModelParam,
  resolveModelExtraParamSources,
} from "../../../agents/model-extra-params.js";
import { resolveModelRuntimePolicy } from "../../../agents/model-runtime-policy.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { detectWindowsSpawnCommandInlineArgs } from "../../../plugin-sdk/windows-spawn.js";
import { listMutableCodexRouteAgentEntries } from "./codex-route-agent-entries.js";
import {
  canAutoMigrateLegacyLosslessCompaction,
  collectLegacyLosslessCompactionConfigs,
  collectUnsupportedCodexCompactionOverrides,
  getSharedDefaultCompactionOverrideConsumers,
  LOSSLESS_CONTEXT_ENGINE_ID,
  readLosslessSummaryModel,
  sharedDefaultLosslessCompactionHasNonCodexConsumer,
} from "./codex-route-compaction-scan.js";
import {
  configRepairWouldClearLegacyRuntimePins,
  rewriteConfigModelRefs,
} from "./codex-route-config-repair.js";
import {
  codexPluginRepairIsBlocked,
  collectCodexRuntimeRouteHits,
  collectConfigModelRefs,
  collectDisabledCodexPluginRouteHits,
  collectDisabledCodexPluginRouteIssues,
  enableCodexPluginForRequiredRoutes,
} from "./codex-route-config-scan.js";
import { parseModelRef } from "./codex-route-model-ref.js";
import { maybeRepairCodexSessionRoutes } from "./codex-route-session-repair.js";
import type {
  CodexRouteHit,
  CodexRuntimeRouteHit,
  LegacyLosslessCompactionConfig,
  UnsupportedCodexCompactionOverride,
} from "./codex-route-types.js";
import {
  collectBlockedLegacyOpenAICodexProviderPlan,
  type BlockedLegacyOpenAICodexProviderPlan,
} from "./legacy-config-migrations.runtime.models.js";

function formatCodexRouteChange(hit: CodexRouteHit): string {
  return `${hit.path}: ${hit.model} -> ${hit.canonicalModel}.`;
}

function formatUnsupportedCompactionWarning(params: {
  hits: UnsupportedCodexCompactionOverride[];
  fixHint: string;
}): string {
  return [
    "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
    ...params.hits.map(
      (hit) => `- ${hit.path}: ${hit.value} is ignored while this agent uses Codex runtime.`,
    ),
    params.fixHint,
  ].join("\n");
}

function formatLegacyLosslessCompactionWarning(params: {
  hits: LegacyLosslessCompactionConfig[];
  canAutoFix: boolean;
}): string {
  const configLines: string[] = [];
  const providerPaths = new Set<string>();
  for (const hit of params.hits) {
    if (!providerPaths.has(hit.providerPath)) {
      providerPaths.add(hit.providerPath);
      configLines.push(
        `- ${hit.providerPath}: ${hit.providerValue} should become plugins.slots.contextEngine: ${LOSSLESS_CONTEXT_ENGINE_ID}.`,
      );
    }
    if (hit.modelPath && hit.modelValue) {
      configLines.push(
        `- ${hit.modelPath}: ${hit.modelValue} should become plugins.entries.${LOSSLESS_CONTEXT_ENGINE_ID}.config.summaryModel.`,
      );
    }
  }
  return [
    "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
    ...configLines,
    params.canAutoFix
      ? "- Run `openclaw doctor --fix`: it migrates legacy Lossless compaction config to the Lossless context-engine slot."
      : "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
  ].join("\n");
}

function formatDisabledCodexPluginWarning(params: {
  hits: CodexRuntimeRouteHit[];
  repairBlocked: boolean;
}): string {
  const fixHint = params.repairBlocked
    ? "- Enable plugins.entries.codex and plugin loading, and remove `codex` from plugins.deny; or set the affected OpenAI models to an OpenClaw runtime policy."
    : "- Run `openclaw doctor --fix`: it enables plugins.entries.codex, or set the affected OpenAI models to an OpenClaw runtime policy.";
  return [
    "- Codex runtime is selected, but the Codex plugin is disabled.",
    ...params.hits.map(
      (hit) =>
        `- ${hit.path}: ${hit.modelRef} resolves to ${hit.canonicalModel} with Codex runtime while the Codex plugin is disabled by config.`,
    ),
    fixHint,
  ].join("\n");
}

function collectCodexAppServerCommandWarnings(cfg: OpenClawConfig): string[] {
  const plugins = asMutableRecord(cfg.plugins);
  const entries = asMutableRecord(plugins?.entries);
  const codex = asMutableRecord(entries?.codex);
  const config = asMutableRecord(codex?.config);
  const appServer = asMutableRecord(config?.appServer);
  if (typeof appServer?.command !== "string" || !appServer.command.trim()) {
    return [];
  }
  const command = appServer.command.trim();
  const inlineArgs = detectWindowsSpawnCommandInlineArgs(command);
  return [
    ...(inlineArgs
      ? [
          [
            "- Codex app-server command override includes inline arguments.",
            `- plugins.entries.codex.config.appServer.command: "${command}" starts with "${inlineArgs.executable}" and embeds "${inlineArgs.arguments}". The command field must be only the executable path.`,
            "- Remove the override to use managed Codex startup, or move script/options to plugins.entries.codex.config.appServer.args.",
          ].join("\n"),
        ]
      : []),
    [
      "- Custom Codex app-server command bypasses OpenClaw's managed exact-version binary.",
      "- plugins.entries.codex.config.appServer.command: Doctor did not execute, inspect, or rewrite this command.",
      "- Remove the override to use managed Codex startup, or verify the custom binary matches the Codex version bundled with this OpenClaw release.",
    ].join("\n"),
  ];
}

const FAST_MODE_PARAM_KEYS = ["fastMode", "fast_mode"] as const;
const SERVICE_TIER_PARAM_KEYS = ["serviceTier", "service_tier"] as const;

type CodexModelParamHit = {
  key: string;
  modelRef: string;
  path: string;
  removable: boolean;
};

function ownValues(record: Record<string, unknown>, keys: readonly string[]): unknown[] {
  return keys.filter((key) => Object.hasOwn(record, key)).map((key) => record[key]);
}

function modelUsesCodexForEveryAgent(cfg: OpenClawConfig, modelRef: string): boolean {
  const parsed = parseModelRef(modelRef);
  if (!parsed || parsed.modelId === "*") {
    return false;
  }
  return listMutableCodexRouteAgentEntries(cfg).every(
    ({ agentId }) =>
      normalizeString(
        resolveModelRuntimePolicy({
          config: cfg,
          provider: parsed.provider,
          modelId: parsed.modelId,
          agentId,
        }).policy?.id,
      ) === "codex",
  );
}

function collectCodexModelParamHits(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): CodexModelParamHit[] {
  const hits: CodexModelParamHit[] = [];
  const seen = new Set<string>();
  const agentPaths = new Map(
    listMutableCodexRouteAgentEntries(cfg).map(({ agentId, path }) => [agentId, path]),
  );
  for (const route of collectCodexRuntimeRouteHits(cfg, env)) {
    const parsed = parseModelRef(route.canonicalModel);
    if (!parsed || parsed.provider !== "openai") {
      continue;
    }
    const sources = resolveModelExtraParamSources({
      config: cfg,
      provider: parsed.provider,
      modelId: parsed.modelId,
      agentId: route.agentId,
    });
    const modelParams = sources.modelParams;
    const fastModes = ownValues(modelParams ?? {}, FAST_MODE_PARAM_KEYS);
    const serviceTiers = ownValues(modelParams ?? {}, SERVICE_TIER_PARAM_KEYS);
    const canRemoveServiceTier =
      fastModes.length > 0 &&
      fastModes.every((configured) => normalizeFastMode(configured) === true) &&
      serviceTiers.length > 0 &&
      serviceTiers.every((configured) => normalizeString(configured) === "priority") &&
      modelUsesCodexForEveryAgent(cfg, route.canonicalModel);
    const paramSources = [
      { params: sources.defaultParams, path: "agents.defaults.params", modelScoped: false },
      {
        params: modelParams,
        path: `agents.defaults.models.${route.canonicalModel}.params`,
        modelScoped: true,
      },
      ...(route.agentId
        ? [
            {
              params: sources.agentParams,
              path: `${agentPaths.get(route.agentId) ?? `agents.entries.${route.agentId}`}.params`,
              modelScoped: false,
            },
          ]
        : []),
    ];
    for (const source of paramSources) {
      for (const [key, paramValue] of Object.entries(source.params ?? {})) {
        if (source.modelScoped && isAgentRuntimeModelParam(key, paramValue)) {
          continue;
        }
        const path = `${source.path}.${key}`;
        if (seen.has(path)) {
          continue;
        }
        seen.add(path);
        hits.push({
          key,
          path,
          modelRef: route.canonicalModel,
          removable:
            source.modelScoped &&
            canRemoveServiceTier &&
            SERVICE_TIER_PARAM_KEYS.some((alias) => alias === key),
        });
      }
    }
  }
  return hits;
}

function formatCodexModelParamWarning(hits: readonly CodexModelParamHit[]): string {
  const fixHint = hits.some((hit) => hit.removable)
    ? '- Run `openclaw doctor --fix` to remove only redundant priority service-tier params; remove any remaining params or set the affected route\'s agentRuntime.id to "openclaw".'
    : '- Remove these params or set the affected route\'s agentRuntime.id to "openclaw"; Doctor cannot migrate them without changing behavior.';
  return [
    "- Explicit native Codex model routes cannot reproduce authored request transport parameters.",
    ...hits.map(
      (hit) =>
        `- ${hit.path}: ${
          hit.removable
            ? "redundant because this model's fastMode already selects native priority service tier"
            : `authored ${hit.key} cannot be migrated automatically`
        }.`,
    ),
    fixHint,
  ].join("\n");
}

function repairRedundantCodexServiceTiers(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv) {
  const removable = collectCodexModelParamHits(cfg, env).filter((hit) => hit.removable);
  if (removable.length === 0) {
    return { config: cfg, changes: [] };
  }
  const config = structuredClone(cfg);
  const models = asMutableRecord(config.agents?.defaults?.models);
  const changes: string[] = [];
  for (const hit of removable) {
    const params = asMutableRecord(asMutableRecord(models?.[hit.modelRef])?.params);
    if (params) {
      delete params[hit.key];
      changes.push(
        `Removed redundant agents.defaults.models.${hit.modelRef}.params.${hit.key}; fastMode already selects native priority.`,
      );
    }
  }
  return { config, changes };
}

/** Collect non-executing Codex runtime compatibility diagnostics for Doctor and lint. */
export function collectCodexRuntimeCompatibilityWarnings(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): string[] {
  const warnings = collectCodexAppServerCommandWarnings(cfg);
  const modelParamHits = collectCodexModelParamHits(cfg, env);
  if (modelParamHits.length > 0) {
    warnings.push(formatCodexModelParamWarning(modelParamHits));
  }
  return warnings;
}

function collectCodexComputerUseWarnings(cfg: OpenClawConfig): string[] {
  const plugins = asMutableRecord(cfg.plugins);
  const entries = asMutableRecord(plugins?.entries);
  const codex = asMutableRecord(entries?.codex);
  const config = asMutableRecord(codex?.config);
  const computerUse = asMutableRecord(config?.computerUse);
  if (!computerUse) {
    return [];
  }
  const enabled =
    computerUse.enabled === true ||
    computerUse.autoInstall === true ||
    typeof computerUse.marketplaceSource === "string" ||
    typeof computerUse.marketplacePath === "string" ||
    typeof computerUse.marketplaceName === "string";
  if (!enabled) {
    return [];
  }
  const cadence =
    computerUse.healthCheckIntervalMinutes === 30 ||
    computerUse.healthCheckIntervalMinutes === 60 ||
    computerUse.healthCheckIntervalMinutes === 120 ||
    computerUse.healthCheckIntervalMinutes === 240
      ? computerUse.healthCheckIntervalMinutes
      : 60;
  const healthCheckLine =
    computerUse.healthCheckEnabled === true
      ? `- Periodic Computer Use health checks are enabled with a ${cadence}-minute cadence.`
      : "- Periodic Computer Use health checks are disabled by default; set `computerUse.healthCheckEnabled` to true to enable them.";
  const repairLine =
    computerUse.autoRepair === true
      ? "- Stale Computer Use MCP child repair is enabled and limited to SkyComputerUseClient children."
      : "- Stale Computer Use MCP child repair is disabled by default; set `computerUse.autoRepair` to true to repair before retrying a failed probe.";
  return [
    [
      "- Codex Computer Use is enabled.",
      "- Doctor config review found Computer Use enabled; run `/codex computer-use status` to inspect installation, exposure, and the live `list_apps` probe.",
      healthCheckLine,
      repairLine,
    ].join("\n"),
  ];
}

/** Collect doctor warnings for legacy Codex model refs, runtime pins, and compaction overrides. */
export function collectCodexRouteWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  blockedProviderPlan?: BlockedLegacyOpenAICodexProviderPlan;
}): string[] {
  const env = params.env ?? process.env;
  const blockedProviderPlan =
    params.blockedProviderPlan ?? collectBlockedLegacyOpenAICodexProviderPlan(params.cfg);
  const blockedModelIdentities = new Set(blockedProviderPlan.blockedModelIdentities);
  const hits = collectConfigModelRefs(params.cfg, blockedModelIdentities);
  const disabledCodexPluginHits = collectDisabledCodexPluginRouteHits(params.cfg, env);
  const ignoreLegacyAgentRuntimePins = configRepairWouldClearLegacyRuntimePins({
    cfg: params.cfg,
    blockedModelIdentities,
    env,
  });
  const legacyLosslessCompactionConfigs = collectLegacyLosslessCompactionConfigs({
    cfg: params.cfg,
    ignoreLegacyAgentRuntimePins,
    env,
  });
  const legacyLosslessCompactionPaths = new Set(
    legacyLosslessCompactionConfigs.flatMap((hit) =>
      hit.modelPath ? [hit.providerPath, hit.modelPath] : [hit.providerPath],
    ),
  );
  const unsupportedCompactionOverrides = collectUnsupportedCodexCompactionOverrides({
    cfg: params.cfg,
    ignoreLegacyAgentRuntimePins,
    env,
  }).filter((hit) => !legacyLosslessCompactionPaths.has(hit.path));
  const sharedDefaultCompactionConsumers = getSharedDefaultCompactionOverrideConsumers({
    cfg: params.cfg,
    ignoreLegacyAgentRuntimePins,
    env,
  });
  const sharedLosslessDefaultHasNonCodexConsumer =
    sharedDefaultLosslessCompactionHasNonCodexConsumer({
      cfg: params.cfg,
      ignoreLegacyAgentRuntimePins,
      env,
    });
  const warnings = [
    ...(blockedProviderPlan.warning ? [blockedProviderPlan.warning] : []),
    ...collectCodexRuntimeCompatibilityWarnings(params.cfg, env),
    ...collectCodexComputerUseWarnings(params.cfg),
  ];
  if (hits.length > 0) {
    warnings.push(
      [
        "- Legacy `codex/*` and `openai-codex/*` model refs should be rewritten to `openai/*`.",
        ...hits.map(
          (hit) =>
            `- ${hit.path}: ${hit.model} should become ${hit.canonicalModel}${
              hit.runtime ? `; current runtime is "${hit.runtime}"` : ""
            }.`,
        ),
        "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
      ].join("\n"),
    );
  }
  if (legacyLosslessCompactionConfigs.length > 0) {
    const plugins = asMutableRecord(params.cfg.plugins);
    const contextEngine = normalizeString(asMutableRecord(plugins?.slots)?.contextEngine);
    warnings.push(
      formatLegacyLosslessCompactionWarning({
        hits: legacyLosslessCompactionConfigs,
        canAutoFix:
          !sharedLosslessDefaultHasNonCodexConsumer &&
          canAutoMigrateLegacyLosslessCompaction({
            hits: legacyLosslessCompactionConfigs,
            contextEngine,
            summaryModel: readLosslessSummaryModel(plugins),
          }),
      }),
    );
  }
  if (disabledCodexPluginHits.length > 0) {
    warnings.push(
      formatDisabledCodexPluginWarning({
        hits: disabledCodexPluginHits,
        repairBlocked: codexPluginRepairIsBlocked(params.cfg),
      }),
    );
  }
  const preservedSharedDefaultHits = unsupportedCompactionOverrides.filter(
    (hit) =>
      hit.path.startsWith("agents.defaults.compaction.") &&
      sharedDefaultCompactionConsumers[hit.key],
  );
  const fixableHits = unsupportedCompactionOverrides.filter(
    (hit) =>
      !hit.path.startsWith("agents.defaults.compaction.") ||
      !sharedDefaultCompactionConsumers[hit.key],
  );
  if (preservedSharedDefaultHits.length > 0) {
    warnings.push(
      formatUnsupportedCompactionWarning({
        hits: preservedSharedDefaultHits,
        fixHint:
          "- Move or remove shared `agents.defaults.compaction.model/provider` settings manually; doctor keeps shared defaults while non-Codex agents can inherit them.",
      }),
    );
  }
  if (fixableHits.length > 0) {
    warnings.push(
      formatUnsupportedCompactionWarning({
        hits: fixableHits,
        fixHint:
          "- Run `openclaw doctor --fix`: it removes unsupported Codex compaction overrides.",
      }),
    );
  }
  return warnings;
}

/** Rewrite legacy Codex config routes to OpenAI refs and explicit runtime policy when allowed. */
export function maybeRepairCodexRoutes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  codexRuntimeReady?: boolean;
  blockedProviderPlan?: BlockedLegacyOpenAICodexProviderPlan;
}): { cfg: OpenClawConfig; warnings: string[]; changes: string[] } {
  const env = params.env ?? process.env;
  const blockedProviderPlan =
    params.blockedProviderPlan ?? collectBlockedLegacyOpenAICodexProviderPlan(params.cfg);
  const blockedModelIdentities = new Set(blockedProviderPlan.blockedModelIdentities);
  const hits = collectConfigModelRefs(params.cfg, blockedModelIdentities);
  const disabledCodexPluginHits = collectDisabledCodexPluginRouteHits(params.cfg, env);
  const ignoreLegacyAgentRuntimePins = configRepairWouldClearLegacyRuntimePins({
    cfg: params.cfg,
    blockedModelIdentities,
    env,
  });
  const unsupportedCompactionOverrides = collectUnsupportedCodexCompactionOverrides({
    cfg: params.cfg,
    ignoreLegacyAgentRuntimePins,
    env,
  });
  const legacyLosslessCompactionConfigs = collectLegacyLosslessCompactionConfigs({
    cfg: params.cfg,
    ignoreLegacyAgentRuntimePins,
    env,
  });
  const hasRemovableServiceTier = collectCodexModelParamHits(params.cfg, env).some(
    (hit) => hit.removable,
  );
  if (
    hits.length === 0 &&
    disabledCodexPluginHits.length === 0 &&
    unsupportedCompactionOverrides.length === 0 &&
    legacyLosslessCompactionConfigs.length === 0 &&
    !hasRemovableServiceTier &&
    !blockedProviderPlan.warning
  ) {
    return {
      cfg: params.cfg,
      warnings: collectCodexRouteWarnings({ cfg: params.cfg, env, blockedProviderPlan }),
      changes: [],
    };
  }
  if (!params.shouldRepair) {
    return {
      cfg: params.cfg,
      warnings: collectCodexRouteWarnings({
        cfg: params.cfg,
        env,
        blockedProviderPlan,
      }),
      changes: [],
    };
  }
  const repaired = rewriteConfigModelRefs({
    cfg: params.cfg,
    env,
    blockedModelIdentities,
  });
  const serviceTierRepair = repairRedundantCodexServiceTiers(repaired.cfg, env);
  const codexPluginRepair = enableCodexPluginForRequiredRoutes({
    cfg: serviceTierRepair.config,
    routeHits: collectDisabledCodexPluginRouteHits(serviceTierRepair.config, env),
  });
  const warnings = collectCodexRouteWarnings({
    cfg: codexPluginRepair.cfg,
    env,
    blockedProviderPlan,
  });
  const routeChanges =
    repaired.changes.length > 0
      ? [
          `Repaired Codex model routes:\n${repaired.changes
            .map((hit) => `- ${formatCodexRouteChange(hit)}`)
            .join("\n")}`,
        ]
      : [];
  return {
    cfg: codexPluginRepair.cfg,
    warnings,
    changes: [
      ...routeChanges,
      ...repaired.runtimePolicyChanges,
      ...repaired.runtimePinChanges,
      ...repaired.unsupportedCompactionChanges,
      ...codexPluginRepair.changes,
      ...serviceTierRepair.changes,
    ],
  };
}

export { collectDisabledCodexPluginRouteIssues, maybeRepairCodexSessionRoutes };
