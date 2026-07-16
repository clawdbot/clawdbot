// Doctor warnings and repairs for legacy OpenAI Codex model/provider routing.
import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { detectWindowsSpawnCommandInlineArgs } from "../../../plugin-sdk/windows-spawn.js";
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
  codexPluginIsBlockedOutsideEntry,
  collectConfigModelRefs,
  collectDisabledCodexPluginRouteHits,
  collectDisabledCodexPluginRouteIssues,
  enableCodexPluginForRequiredRoutes,
} from "./codex-route-config-scan.js";
import { maybeRepairCodexSessionRoutes } from "./codex-route-session-repair.js";
import type {
  CodexRouteHit,
  DisabledCodexPluginRouteHit,
  LegacyLosslessCompactionConfig,
  UnsupportedCodexCompactionOverride,
} from "./codex-route-types.js";

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
  hits: DisabledCodexPluginRouteHit[];
  blockedOutsideEntry: boolean;
}): string {
  const fixHint = params.blockedOutsideEntry
    ? "- Enable plugin loading and remove `codex` from plugins.deny, or set the affected OpenAI models to an OpenClaw runtime policy."
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
  const command = typeof appServer?.command === "string" ? appServer.command.trim() : "";
  if (!command) {
    return [];
  }
  const inlineArgs = detectWindowsSpawnCommandInlineArgs(command);
  if (!inlineArgs) {
    return [];
  }
  return [
    [
      "- Codex app-server command override includes inline arguments.",
      `- plugins.entries.codex.config.appServer.command: "${command}" starts with "${inlineArgs.executable}" and embeds "${inlineArgs.arguments}". The command field must be only the executable path.`,
      "- Remove the override to use managed Codex startup, or move script/options to plugins.entries.codex.config.appServer.args.",
    ].join("\n"),
  ];
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
}): string[] {
  const env = params.env ?? process.env;
  const hits = collectConfigModelRefs(params.cfg);
  const disabledCodexPluginHits = collectDisabledCodexPluginRouteHits(params.cfg, env);
  const ignoreLegacyAgentRuntimePins = configRepairWouldClearLegacyRuntimePins({
    cfg: params.cfg,
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
    ...collectCodexAppServerCommandWarnings(params.cfg),
    ...collectCodexComputerUseWarnings(params.cfg),
  ];
  if (hits.length > 0) {
    warnings.push(
      [
        "- Legacy `openai-codex/*` model refs should be rewritten to `openai/*`.",
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
        blockedOutsideEntry: codexPluginIsBlockedOutsideEntry(params.cfg),
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
}): { cfg: OpenClawConfig; warnings: string[]; changes: string[] } {
  const env = params.env ?? process.env;
  const hits = collectConfigModelRefs(params.cfg);
  const disabledCodexPluginHits = collectDisabledCodexPluginRouteHits(params.cfg, env);
  const ignoreLegacyAgentRuntimePins = configRepairWouldClearLegacyRuntimePins({
    cfg: params.cfg,
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
  if (
    hits.length === 0 &&
    disabledCodexPluginHits.length === 0 &&
    unsupportedCompactionOverrides.length === 0 &&
    legacyLosslessCompactionConfigs.length === 0
  ) {
    return { cfg: params.cfg, warnings: [], changes: [] };
  }
  if (!params.shouldRepair) {
    return {
      cfg: params.cfg,
      warnings: collectCodexRouteWarnings({ cfg: params.cfg, env }),
      changes: [],
    };
  }
  const repaired = rewriteConfigModelRefs({ cfg: params.cfg, env });
  const codexPluginRepair = enableCodexPluginForRequiredRoutes({
    cfg: repaired.cfg,
    routeHits: collectDisabledCodexPluginRouteHits(repaired.cfg, env),
  });
  const warnings = collectCodexRouteWarnings({ cfg: codexPluginRepair.cfg, env });
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
    ],
  };
}

export { collectDisabledCodexPluginRouteIssues, maybeRepairCodexSessionRoutes };
