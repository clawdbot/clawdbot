/**
 * Doctor contract hooks for Codex plugin config and state migrations.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown) => boolean;
};

function hasRetiredDynamicToolsProfile(value: unknown): boolean {
  return Object.hasOwn(asNullableRecord(value) ?? {}, "codexDynamicToolsProfile");
}

function hasLegacyPluginDestructivePolicy(value: unknown): boolean {
  const codexPlugins = asNullableRecord(value);
  if (!codexPlugins) {
    return false;
  }
  if (codexPlugins.allow_destructive_actions === "on-request") {
    return true;
  }
  const plugins = asNullableRecord(codexPlugins.plugins);
  return Object.values(plugins ?? {}).some(
    (plugin) => asNullableRecord(plugin)?.allow_destructive_actions === "on-request",
  );
}

function hasRetiredApprovalPolicy(value: unknown): boolean {
  const approvalPolicy = asNullableRecord(value)?.approvalPolicy;
  return approvalPolicy === "on-failure" || approvalPolicy === "untrusted";
}

/** Legacy Codex config keys that doctor should report or repair. */
export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["plugins", "entries", "codex", "config"],
    message:
      'plugins.entries.codex.config.codexDynamicToolsProfile is retired; Codex app-server always keeps Codex-native workspace tools native. Run "openclaw doctor --fix".',
    match: hasRetiredDynamicToolsProfile,
  },
  {
    path: ["plugins", "entries", "codex", "config", "codexPlugins"],
    message:
      'plugins.entries.codex.config.codexPlugins.allow_destructive_actions="on-request" was renamed to "auto". Run "openclaw doctor --fix".',
    match: hasLegacyPluginDestructivePolicy,
  },
  {
    path: ["plugins", "entries", "codex", "config", "appServer"],
    message:
      'plugins.entries.codex.config.appServer.approvalPolicy values "on-failure" and "untrusted" are retired; use "on-request". Run "openclaw doctor --fix".',
    match: hasRetiredApprovalPolicy,
  },
];

/**
 * Removes retired Codex plugin config keys while preserving unrelated config.
 */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const rawEntry = asNullableRecord(cfg.plugins?.entries?.codex);
  const rawPluginConfig = asNullableRecord(rawEntry?.config);
  const rawCodexPlugins = asNullableRecord(rawPluginConfig?.codexPlugins);
  const rawAppServer = asNullableRecord(rawPluginConfig?.appServer);
  const shouldRemoveDynamicToolsProfile =
    rawPluginConfig !== null && hasRetiredDynamicToolsProfile(rawPluginConfig);
  const shouldRewriteDestructivePolicy = hasLegacyPluginDestructivePolicy(rawCodexPlugins);
  const shouldRewriteApprovalPolicy = hasRetiredApprovalPolicy(rawAppServer);
  if (
    !rawPluginConfig ||
    (!shouldRemoveDynamicToolsProfile &&
      !shouldRewriteDestructivePolicy &&
      !shouldRewriteApprovalPolicy)
  ) {
    return { config: cfg, changes: [] };
  }

  const nextConfig = structuredClone(cfg) as OpenClawConfig & {
    plugins?: Record<string, unknown>;
  };
  const nextPlugins = asNullableRecord(nextConfig.plugins);
  const nextEntries = asNullableRecord(nextPlugins?.entries);
  const nextEntry = asNullableRecord(nextEntries?.codex);
  const nextPluginConfig = asNullableRecord(nextEntry?.config);
  if (!nextPluginConfig) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  if (shouldRemoveDynamicToolsProfile) {
    delete nextPluginConfig.codexDynamicToolsProfile;
    changes.push(
      "Removed retired plugins.entries.codex.config.codexDynamicToolsProfile; Codex app-server always keeps Codex-native workspace tools native.",
    );
  }

  if (shouldRewriteDestructivePolicy) {
    const nextCodexPlugins = asNullableRecord(nextPluginConfig.codexPlugins);
    if (nextCodexPlugins?.allow_destructive_actions === "on-request") {
      nextCodexPlugins.allow_destructive_actions = "auto";
    }
    const nextPluginPolicies = asNullableRecord(nextCodexPlugins?.plugins);
    for (const plugin of Object.values(nextPluginPolicies ?? {})) {
      const nextPlugin = asNullableRecord(plugin);
      if (nextPlugin?.allow_destructive_actions === "on-request") {
        nextPlugin.allow_destructive_actions = "auto";
      }
    }
    changes.push(
      'Renamed plugins.entries.codex.config.codexPlugins allow_destructive_actions="on-request" values to "auto".',
    );
  }

  if (shouldRewriteApprovalPolicy) {
    const nextAppServer = asNullableRecord(nextPluginConfig.appServer);
    if (
      nextAppServer?.approvalPolicy === "on-failure" ||
      nextAppServer?.approvalPolicy === "untrusted"
    ) {
      nextAppServer.approvalPolicy = "on-request";
    }
    changes.push(
      'Renamed retired plugins.entries.codex.config.appServer.approvalPolicy to "on-request".',
    );
  }

  return {
    config: nextConfig,
    changes,
  };
}

export { stateMigrations } from "./src/migration/session-binding-sidecars.js";
