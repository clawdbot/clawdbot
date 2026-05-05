import chalk from "chalk";
import { resolveDefaultAgentId, resolveAgentConfig } from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveFastModeState } from "../agents/fast-mode.js";
import {
  resolveConfiguredModelRef,
  resolveThinkingDefault,
  legacyModelKey,
  modelKey,
} from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getResolvedLoggerSettings } from "../logging.js";
import { collectEnabledInsecureOrDangerousFlags } from "../security/dangerous-config-flags.js";

type StartupThinkLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";

export function logGatewayStartup(params: {
  cfg: OpenClawConfig;
  bindHost: string;
  bindHosts?: string[];
  port: number;
  loadedPluginIds: readonly string[];
  startupStartedAt?: number;
  tlsEnabled?: boolean;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string) => void };
  isNixMode: boolean;
}) {
  const { provider: agentProvider, model: agentModel } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const modelRef = `${agentProvider}/${agentModel}`;
  const modelDetails = formatAgentModelStartupDetails({
    cfg: params.cfg,
    provider: agentProvider,
    model: agentModel,
  });
  params.log.info(`agent model: ${modelRef} (${modelDetails})`, {
    consoleMessage: `agent model: ${chalk.whiteBright(modelRef)} (${modelDetails})`,
  });
  const startupDurationMs =
    typeof params.startupStartedAt === "number" ? Date.now() - params.startupStartedAt : null;
  const startupDurationLabel =
    startupDurationMs == null ? null : `${(startupDurationMs / 1000).toFixed(1)}s`;
  params.log.info(
    `http server listening (${formatReadyDetails(params.loadedPluginIds, startupDurationLabel)})`,
  );
  params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
  if (params.isNixMode) {
    params.log.info("gateway: running in Nix mode (config managed externally)");
  }

  const enabledDangerousFlags = collectEnabledInsecureOrDangerousFlags(params.cfg);
  if (enabledDangerousFlags.length > 0) {
    const warning =
      `security warning: dangerous config flags enabled: ${enabledDangerousFlags.join(", ")}. ` +
      "Run `openclaw security audit`.";
    params.log.warn(warning);
  }
}

function normalizeStartupThinkLevel(value: unknown): StartupThinkLevel | undefined {
  return value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "adaptive" ||
    value === "max"
    ? value
    : undefined;
}

function resolveExplicitStartupThinking(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  defaultAgentThinking: unknown;
}): StartupThinkLevel | undefined {
  const models = params.cfg.agents?.defaults?.models;
  const canonicalKey = modelKey(params.provider, params.model);
  const legacyKey = legacyModelKey(params.provider, params.model);
  return (
    normalizeStartupThinkLevel(params.defaultAgentThinking) ??
    normalizeStartupThinkLevel(models?.[canonicalKey]?.params?.thinking) ??
    normalizeStartupThinkLevel(legacyKey ? models?.[legacyKey]?.params?.thinking : undefined) ??
    normalizeStartupThinkLevel(params.cfg.agents?.defaults?.thinkingDefault)
  );
}

export function formatAgentModelStartupDetails(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): string {
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const defaultAgentConfig = resolveAgentConfig(params.cfg, defaultAgentId);
  const explicitThinking = resolveExplicitStartupThinking({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    defaultAgentThinking: defaultAgentConfig?.thinkingDefault,
  });
  const resolvedThinking =
    explicitThinking ??
    resolveThinkingDefault({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
    });
  const thinking = explicitThinking ?? (resolvedThinking === "off" ? "medium" : resolvedThinking);
  const fast = resolveFastModeState({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    agentId: defaultAgentId,
  });

  return `thinking=${thinking}, fast=${fast.enabled ? "on" : "off"}`;
}

function formatReadyDetails(
  loadedPluginIds: readonly string[],
  startupDurationLabel: string | null,
) {
  const pluginIds = [...new Set(loadedPluginIds.map((id) => id.trim()).filter(Boolean))].toSorted(
    (a, b) => a.localeCompare(b),
  );
  const pluginSummary =
    pluginIds.length === 0
      ? "0 plugins"
      : `${pluginIds.length} ${pluginIds.length === 1 ? "plugin" : "plugins"}: ${pluginIds.join(", ")}`;

  if (!startupDurationLabel) {
    return pluginSummary;
  }
  return pluginIds.length === 0
    ? `${pluginSummary}, ${startupDurationLabel}`
    : `${pluginSummary}; ${startupDurationLabel}`;
}
