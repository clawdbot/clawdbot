/**
 * Doctor contract hooks for Codex plugin config and state migrations.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { codexOrphanedSessionBindingMigration } from "./src/migration/session-binding-orphans.js";
import { stateMigrations as legacyStateMigrations } from "./src/migration/session-binding-sidecars.js";

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

// These keys shipped in v2026.8.1; only Doctor consumes them after retirement.
const RETIRED_TURN_IDLE_TIMEOUT_KEYS = [
  "turnCompletionIdleTimeoutMs",
  "turnAssistantCompletionIdleTimeoutMs",
  "postToolRawAssistantCompletionIdleTimeoutMs",
] as const;

function hasRetiredTurnIdleTimeout(value: unknown): boolean {
  const appServer = asNullableRecord(value);
  return (
    appServer !== null &&
    RETIRED_TURN_IDLE_TIMEOUT_KEYS.some((key) => Object.hasOwn(appServer, key))
  );
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
  {
    path: ["plugins", "entries", "codex", "config", "appServer"],
    message:
      'Codex app-server turn idle timeouts are retired; native Codex owns provider liveness and turn completion. The existing agents.defaults.timeoutSeconds run limit remains unchanged. Run "openclaw doctor --fix" to remove the old settings.',
    match: hasRetiredTurnIdleTimeout,
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
  const shouldRemoveTurnIdleTimeouts = hasRetiredTurnIdleTimeout(rawAppServer);
  if (
    !rawPluginConfig ||
    (!shouldRemoveDynamicToolsProfile &&
      !shouldRewriteDestructivePolicy &&
      !shouldRewriteApprovalPolicy &&
      !shouldRemoveTurnIdleTimeouts)
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

  const nextAppServer = asNullableRecord(nextPluginConfig.appServer);
  if (nextAppServer && shouldRemoveTurnIdleTimeouts) {
    for (const key of RETIRED_TURN_IDLE_TIMEOUT_KEYS) {
      if (Object.hasOwn(nextAppServer, key)) {
        delete nextAppServer[key];
        changes.push(
          `Removed retired plugins.entries.codex.config.appServer.${key}; native Codex owns provider liveness and turn completion. agents.defaults.timeoutSeconds was not changed.`,
        );
      }
    }
  }

  if (shouldRewriteApprovalPolicy) {
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

export const stateMigrations: PluginDoctorStateMigration[] = [
  ...legacyStateMigrations,
  codexOrphanedSessionBindingMigration,
];
