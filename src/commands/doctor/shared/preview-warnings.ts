import { pickSandboxToolPolicy } from "../../../agents/sandbox-tool-policy.js";
import { isToolAllowedByPolicies } from "../../../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../../agents/tool-policy.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AgentToolsConfig, ToolsConfig } from "../../../config/types.tools.js";

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

type VisibleReplyPolicyProvenance = "default" | "global-explicit" | "group-explicit";

function resolveMessageToolAvailability(params: {
  globalTools?: ToolsConfig;
  agentTools?: AgentToolsConfig;
}): boolean {
  const profile = params.agentTools?.profile ?? params.globalTools?.profile;
  const profileAlsoAllow = Array.isArray(params.agentTools?.alsoAllow)
    ? params.agentTools.alsoAllow
    : Array.isArray(params.globalTools?.alsoAllow)
      ? params.globalTools.alsoAllow
      : undefined;
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), profileAlsoAllow);
  return isToolAllowedByPolicies("message", [
    profilePolicy,
    pickSandboxToolPolicy(params.globalTools),
    pickSandboxToolPolicy(params.agentTools),
  ]);
}

function collectMessageToolUnavailableTargets(cfg: OpenClawConfig): string[] {
  const agents = cfg.agents?.list ?? [];
  if (agents.length === 0) {
    return resolveMessageToolAvailability({ globalTools: cfg.tools })
      ? []
      : ["default tool policy"];
  }
  return agents.flatMap((agent) =>
    resolveMessageToolAvailability({ globalTools: cfg.tools, agentTools: agent.tools })
      ? []
      : [`agent "${agent.id}"`],
  );
}

function resolveGroupVisibleReplyProvenance(cfg: OpenClawConfig): {
  path: "messages.groupChat.visibleReplies" | "messages.visibleReplies";
  provenance: VisibleReplyPolicyProvenance;
  value: "automatic" | "message_tool";
} {
  const groupVisibleReplies = cfg.messages?.groupChat?.visibleReplies;
  if (groupVisibleReplies) {
    return {
      path: "messages.groupChat.visibleReplies",
      provenance: "group-explicit",
      value: groupVisibleReplies,
    };
  }
  const globalVisibleReplies = cfg.messages?.visibleReplies;
  if (globalVisibleReplies) {
    return {
      path: "messages.visibleReplies",
      provenance: "global-explicit",
      value: globalVisibleReplies,
    };
  }
  return {
    path: "messages.groupChat.visibleReplies",
    provenance: "default",
    value: "message_tool",
  };
}

function formatTargets(targets: string[]): string {
  if (targets.length <= 2) {
    return targets.join(" and ");
  }
  return `${targets.slice(0, 2).join(", ")}, and ${targets.length - 2} more`;
}

export function collectVisibleReplyToolPolicyWarnings(cfg: OpenClawConfig): string[] {
  const targets = collectMessageToolUnavailableTargets(cfg);
  if (targets.length === 0) {
    return [];
  }
  const groupPolicy = resolveGroupVisibleReplyProvenance(cfg);
  const warnings: string[] = [];
  if (groupPolicy.value === "message_tool") {
    if (groupPolicy.provenance === "default" && !hasChannels(cfg)) {
      return warnings;
    }
    const targetSummary = formatTargets(targets);
    if (groupPolicy.provenance === "default") {
      warnings.push(
        `- messages.groupChat.visibleReplies defaults to "message_tool", but the message tool is unavailable for ${targetSummary}; OpenClaw falls back to automatic group/channel replies to avoid silent responses. Enable the message tool or set messages.groupChat.visibleReplies explicitly.`,
      );
    } else {
      warnings.push(
        `- ${groupPolicy.path} is set to "message_tool", but the message tool is unavailable for ${targetSummary}; OpenClaw falls back to automatic visible replies, so normal replies may post to the source chat. Enable the message tool or set ${groupPolicy.path} to "automatic".`,
      );
    }
  }

  const globalVisibleReplies = cfg.messages?.visibleReplies;
  if (globalVisibleReplies === "message_tool" && groupPolicy.path !== "messages.visibleReplies") {
    warnings.push(
      `- messages.visibleReplies is set to "message_tool", but the message tool is unavailable for ${formatTargets(
        targets,
      )}; OpenClaw falls back to automatic direct-chat replies, so normal replies may post to the source chat. Enable the message tool or set messages.visibleReplies to "automatic".`,
    );
  }
  return warnings;
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

  warnings.push(...collectVisibleReplyToolPolicyWarnings(params.cfg));

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

  if ((hasPluginConfig || hasChannelConfig) && params.cfg.plugins?.enabled !== false) {
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

  if (hasPluginConfig) {
    const { collectCodexRouteWarnings } = await import("./codex-route-warnings.js");
    warnings.push(...collectCodexRouteWarnings({ cfg: params.cfg, env }));
  }
  const { collectCodexNativeAssetWarnings } = await import("./codex-native-assets.js");
  warnings.push(...(await collectCodexNativeAssetWarnings({ cfg: params.cfg, env })));

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
