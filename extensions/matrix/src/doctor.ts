// Matrix plugin module implements doctor behavior.
import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
  removePluginFromConfig,
} from "openclaw/plugin-sdk/runtime-doctor";
import {
  legacyConfigRules as MATRIX_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeMatrixCompatibilityConfig,
} from "./doctor-contract.js";

export async function collectMatrixInstallPathWarnings(cfg: OpenClawConfig): Promise<string[]> {
  const issue = await detectPluginInstallPathIssue({
    pluginId: "matrix",
    install: cfg.plugins?.installs?.matrix,
  });
  if (!issue) {
    return [];
  }
  return formatPluginInstallPathIssue({
    issue,
    pluginLabel: "Matrix",
    defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
  }).map((entry) => `- ${entry}`);
}

export async function cleanStaleMatrixPluginConfig(cfg: OpenClawConfig) {
  const issue = await detectPluginInstallPathIssue({
    pluginId: "matrix",
    install: cfg.plugins?.installs?.matrix,
  });
  if (!issue || issue.kind !== "missing-path") {
    return { config: cfg, changes: [] };
  }
  const { config, actions } = removePluginFromConfig(cfg, "matrix");
  const removed: string[] = [];
  if (actions.install) {
    removed.push("install record");
  }
  if (actions.loadPath) {
    removed.push("load path");
  }
  if (actions.entry) {
    removed.push("plugin entry");
  }
  if (actions.allowlist) {
    removed.push("allowlist entry");
  }
  if (removed.length === 0) {
    return { config: cfg, changes: [] };
  }
  return {
    config,
    changes: [
      `Removed stale Matrix plugin references (${removed.join(", ")}). The previous install path no longer exists: ${issue.path}`,
    ],
  };
}

export async function runMatrixDoctorSequence(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): Promise<{ changeNotes: string[]; warningNotes: string[] }> {
  const warningNotes: string[] = [];
  const installWarnings = await collectMatrixInstallPathWarnings(params.cfg);
  if (installWarnings.length > 0) {
    warningNotes.push(installWarnings.join("\n"));
  }
  return { changeNotes: [], warningNotes };
}

export const matrixDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "nestedOnly",
  groupModel: "sender",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: true,
  legacyConfigRules: MATRIX_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeMatrixCompatibilityConfig,
  runConfigSequence: async ({ cfg, env, shouldRepair }) =>
    await runMatrixDoctorSequence({ cfg, env, shouldRepair }),
  cleanStaleConfig: async ({ cfg }) => await cleanStaleMatrixPluginConfig(cfg),
};
