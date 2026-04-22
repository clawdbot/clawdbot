import type { OpenClawConfig } from "../../../config/types.openclaw.js";

type ChannelDoctorModule = typeof import("./channel-doctor.js");

let channelDoctorModulePromise: Promise<ChannelDoctorModule> | undefined;

function loadChannelDoctorModule(): Promise<ChannelDoctorModule> {
  channelDoctorModulePromise ??= import("./channel-doctor.js");
  return channelDoctorModulePromise;
}

function hasRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasChannels(cfg: OpenClawConfig): boolean {
  return hasRecord(cfg.channels);
}

function hasPlugins(cfg: OpenClawConfig): boolean {
  return hasRecord(cfg.plugins);
}

function hasPluginLoadPaths(cfg: OpenClawConfig): boolean {
  const plugins = cfg.plugins;
  if (!hasRecord(plugins)) {
    return false;
  }
  const load = plugins.load;
  return hasRecord(load) && Array.isArray(load.paths) && load.paths.length > 0;
}

function hasExplicitChannelPluginBlockerConfig(cfg: OpenClawConfig): boolean {
  if (cfg.plugins?.enabled === false) {
    return true;
  }
  const entries = cfg.plugins?.entries;
  if (!hasRecord(entries)) {
    return false;
  }
  return Object.values(entries).some(
    (entry) => hasRecord(entry) && "enabled" in entry && entry.enabled === false,
  );
}

function hasToolsBySenderKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasToolsBySenderKey);
  }
  if (!hasRecord(value)) {
    return false;
  }
  if (hasRecord(value.toolsBySender)) {
    return true;
  }
  return Object.entries(value).some(
    ([key, nested]) => key !== "toolsBySender" && hasToolsBySenderKey(nested),
  );
}

function hasConfiguredSafeBins(cfg: OpenClawConfig): boolean {
  const globalExec = cfg.tools?.exec;
  if (
    hasRecord(globalExec) &&
    Array.isArray(globalExec.safeBins) &&
    globalExec.safeBins.length > 0
  ) {
    return true;
  }
  return (cfg.agents?.list ?? []).some((agent) => {
    const agentExec = hasRecord(agent) && hasRecord(agent.tools) ? agent.tools.exec : undefined;
    return (
      hasRecord(agentExec) && Array.isArray(agentExec.safeBins) && agentExec.safeBins.length > 0
    );
  });
}

export async function collectDoctorPreviewWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const hasChannelConfig = hasChannels(params.cfg);
  const hasPluginConfig = hasPlugins(params.cfg);

  const channelPluginRuntime =
    hasChannelConfig && hasExplicitChannelPluginBlockerConfig(params.cfg)
      ? await import("./channel-plugin-blockers.js")
      : undefined;
  const channelPluginBlockerHits =
    channelPluginRuntime?.scanConfiguredChannelPluginBlockers(params.cfg, env) ?? [];
  if (channelPluginRuntime && channelPluginBlockerHits.length > 0) {
    warnings.push(
      channelPluginRuntime
        .collectConfiguredChannelPluginBlockerWarnings(channelPluginBlockerHits)
        .join("\n"),
    );
  }

  if (hasChannelConfig) {
    const { collectChannelDoctorPreviewWarnings } = await loadChannelDoctorModule();
    const channelDoctorWarnings = await collectChannelDoctorPreviewWarnings({
      cfg: params.cfg,
      doctorFixCommand: params.doctorFixCommand,
      env,
    });
    if (channelDoctorWarnings.length > 0) {
      warnings.push(...channelDoctorWarnings);
    }

    const { collectOpenPolicyAllowFromWarnings, maybeRepairOpenPolicyAllowFrom } =
      await import("./open-policy-allowfrom.js");
    const allowFromScan = maybeRepairOpenPolicyAllowFrom(params.cfg);
    if (allowFromScan.changes.length > 0) {
      warnings.push(
        collectOpenPolicyAllowFromWarnings({
          changes: allowFromScan.changes,
          doctorFixCommand: params.doctorFixCommand,
        }).join("\n"),
      );
    }
  }

  if (hasPluginConfig) {
    const {
      collectStalePluginConfigWarnings,
      isStalePluginAutoRepairBlocked,
      scanStalePluginConfig,
    } = await import("./stale-plugin-config.js");
    const stalePluginHits = scanStalePluginConfig(params.cfg, env);
    if (stalePluginHits.length > 0) {
      warnings.push(
        collectStalePluginConfigWarnings({
          hits: stalePluginHits,
          doctorFixCommand: params.doctorFixCommand,
          autoRepairBlocked: isStalePluginAutoRepairBlocked(params.cfg, env),
        }).join("\n"),
      );
    }
  }

  if (hasPluginLoadPaths(params.cfg)) {
    const { collectBundledPluginLoadPathWarnings, scanBundledPluginLoadPathMigrations } =
      await import("./bundled-plugin-load-paths.js");
    const bundledPluginLoadPathHits = scanBundledPluginLoadPathMigrations(params.cfg, env);
    if (bundledPluginLoadPathHits.length > 0) {
      warnings.push(
        collectBundledPluginLoadPathWarnings({
          hits: bundledPluginLoadPathHits,
          doctorFixCommand: params.doctorFixCommand,
        }).join("\n"),
      );
    }
  }

  if (hasChannelConfig) {
    const { createChannelDoctorEmptyAllowlistPolicyHooks } = await loadChannelDoctorModule();
    const { scanEmptyAllowlistPolicyWarnings } = await import("./empty-allowlist-scan.js");
    const emptyAllowlistHooks = createChannelDoctorEmptyAllowlistPolicyHooks({
      cfg: params.cfg,
      env,
    });
    const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(params.cfg, {
      doctorFixCommand: params.doctorFixCommand,
      extraWarningsForAccount: emptyAllowlistHooks.extraWarningsForAccount,
      shouldSkipDefaultEmptyGroupAllowlistWarning:
        emptyAllowlistHooks.shouldSkipDefaultEmptyGroupAllowlistWarning,
    }).filter(
      (warning) =>
        !(
          channelPluginRuntime?.isWarningBlockedByChannelPlugin(
            warning,
            channelPluginBlockerHits,
          ) ?? false
        ),
    );
    if (emptyAllowlistWarnings.length > 0) {
      const { sanitizeForLog } = await import("../../../terminal/ansi.js");
      warnings.push(emptyAllowlistWarnings.map((line) => sanitizeForLog(line)).join("\n"));
    }
  }

  if (hasToolsBySenderKey(params.cfg)) {
    const { collectLegacyToolsBySenderWarnings, scanLegacyToolsBySenderKeys } =
      await import("./legacy-tools-by-sender.js");
    const toolsBySenderHits = scanLegacyToolsBySenderKeys(params.cfg);
    if (toolsBySenderHits.length > 0) {
      warnings.push(
        collectLegacyToolsBySenderWarnings({
          hits: toolsBySenderHits,
          doctorFixCommand: params.doctorFixCommand,
        }).join("\n"),
      );
    }
  }

  if (hasConfiguredSafeBins(params.cfg)) {
    const {
      collectExecSafeBinCoverageWarnings,
      collectExecSafeBinTrustedDirHintWarnings,
      scanExecSafeBinCoverage,
      scanExecSafeBinTrustedDirHints,
    } = await import("./exec-safe-bins.js");
    const safeBinCoverage = scanExecSafeBinCoverage(params.cfg);
    if (safeBinCoverage.length > 0) {
      warnings.push(
        collectExecSafeBinCoverageWarnings({
          hits: safeBinCoverage,
          doctorFixCommand: params.doctorFixCommand,
        }).join("\n"),
      );
    }

    const safeBinTrustedDirHints = scanExecSafeBinTrustedDirHints(params.cfg);
    if (safeBinTrustedDirHints.length > 0) {
      warnings.push(collectExecSafeBinTrustedDirHintWarnings(safeBinTrustedDirHints).join("\n"));
    }
  }

  return warnings;
}
