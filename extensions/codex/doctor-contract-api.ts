/**
 * Doctor contract hooks for Codex plugin config migrations and session-route
 * ownership warnings.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown) => boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasRetiredDynamicToolsProfile(value: unknown): boolean {
  return Object.hasOwn(asRecord(value) ?? {}, "codexDynamicToolsProfile");
}

function hasLegacyPluginDestructivePolicy(value: unknown): boolean {
  const codexPlugins = asRecord(value);
  if (!codexPlugins) {
    return false;
  }
  if (codexPlugins.allow_destructive_actions === "on-request") {
    return true;
  }
  const plugins = asRecord(codexPlugins.plugins);
  return Object.values(plugins ?? {}).some(
    (plugin) => asRecord(plugin)?.allow_destructive_actions === "on-request",
  );
}

function hasRetiredOnFailureApprovalPolicy(value: unknown): boolean {
  return asRecord(value)?.approvalPolicy === "on-failure";
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
      'plugins.entries.codex.config.appServer.approvalPolicy="on-failure" was retired by Codex 0.143; use "on-request". Run "openclaw doctor --fix".',
    match: hasRetiredOnFailureApprovalPolicy,
  },
];

/**
 * Removes retired Codex plugin config keys while preserving unrelated config.
 */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const rawEntry = asRecord(cfg.plugins?.entries?.codex);
  const rawPluginConfig = asRecord(rawEntry?.config);
  const rawCodexPlugins = asRecord(rawPluginConfig?.codexPlugins);
  const rawAppServer = asRecord(rawPluginConfig?.appServer);
  const shouldRemoveDynamicToolsProfile =
    rawPluginConfig !== null && hasRetiredDynamicToolsProfile(rawPluginConfig);
  const shouldRewriteDestructivePolicy = hasLegacyPluginDestructivePolicy(rawCodexPlugins);
  const shouldRewriteApprovalPolicy = hasRetiredOnFailureApprovalPolicy(rawAppServer);
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
  const nextPlugins = asRecord(nextConfig.plugins);
  const nextEntries = asRecord(nextPlugins?.entries);
  const nextEntry = asRecord(nextEntries?.codex);
  const nextPluginConfig = asRecord(nextEntry?.config);
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
    const nextCodexPlugins = asRecord(nextPluginConfig.codexPlugins);
    if (nextCodexPlugins?.allow_destructive_actions === "on-request") {
      nextCodexPlugins.allow_destructive_actions = "auto";
    }
    const nextPluginPolicies = asRecord(nextCodexPlugins?.plugins);
    for (const plugin of Object.values(nextPluginPolicies ?? {})) {
      const nextPlugin = asRecord(plugin);
      if (nextPlugin?.allow_destructive_actions === "on-request") {
        nextPlugin.allow_destructive_actions = "auto";
      }
    }
    changes.push(
      'Renamed plugins.entries.codex.config.codexPlugins allow_destructive_actions="on-request" values to "auto".',
    );
  }

  if (shouldRewriteApprovalPolicy) {
    const nextAppServer = asRecord(nextPluginConfig.appServer);
    if (nextAppServer?.approvalPolicy === "on-failure") {
      nextAppServer.approvalPolicy = "on-request";
    }
    changes.push(
      'Renamed plugins.entries.codex.config.appServer.approvalPolicy="on-failure" to "on-request".',
    );
  }

  return {
    config: nextConfig,
    changes,
  };
}

/** Session/auth ownership metadata used by doctor route-state checks. */
export const sessionRouteStateOwners: DoctorSessionRouteStateOwner[] = [
  {
    id: "codex",
    label: "Codex",
    providerIds: ["codex", "codex-cli", "openai-codex"],
    runtimeIds: ["codex", "codex-cli"],
    cliSessionKeys: ["codex-cli"],
    authProfilePrefixes: ["codex:", "codex-cli:", "openai-codex:"],
  },
];

export { stateMigrations } from "./src/migration/session-binding-sidecars.js";
