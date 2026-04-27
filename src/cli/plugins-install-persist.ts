import { replaceConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type HookInstallUpdate, recordHookInstall } from "../hooks/installs.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import {
  loadInstalledPluginIndexInstallRecords,
  recordPluginInstallInRecords,
  withoutPluginInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import type { PluginInstallUpdate } from "../plugins/installs.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import {
  applySlotSelectionForPlugin,
  enableInternalHookEntries,
  logHookPackRestartHint,
  logSlotWarnings,
} from "./plugins-command-helpers.js";
import { commitPluginInstallRecordsWithConfig } from "./plugins-install-record-commit.js";
import { refreshPluginRegistryAfterConfigMutation } from "./plugins-registry-refresh.js";

function addInstalledPluginToAllowlist(cfg: OpenClawConfig, pluginId: string): OpenClawConfig {
  const allow = cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0 || allow.includes(pluginId)) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, pluginId].toSorted(),
    },
  };
}

function removeInstalledPluginFromDenylist(cfg: OpenClawConfig, pluginId: string): OpenClawConfig {
  const deny = cfg.plugins?.deny;
  if (!Array.isArray(deny) || !deny.includes(pluginId)) {
    return cfg;
  }
  const nextDeny = deny.filter((id) => id !== pluginId);
  const plugins = {
    ...cfg.plugins,
    ...(nextDeny.length > 0 ? { deny: nextDeny } : {}),
  };
  if (nextDeny.length === 0) {
    delete plugins.deny;
  }
  return {
    ...cfg,
    plugins,
  };
}

export type ConfigSnapshotForInstallPersist = {
  config: OpenClawConfig;
  baseHash: string | undefined;
};

export async function persistPluginInstall(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  pluginId: string;
  install: Omit<PluginInstallUpdate, "pluginId">;
  enable?: boolean;
  successMessage?: string;
  warningMessage?: string;
}): Promise<OpenClawConfig> {
  const installConfig =
    params.enable === false
      ? params.snapshot.config
      : removeInstalledPluginFromDenylist(
          addInstalledPluginToAllowlist(params.snapshot.config, params.pluginId),
          params.pluginId,
        );
  let next =
    params.enable === false
      ? installConfig
      : enablePluginInConfig(installConfig, params.pluginId, {
          updateChannelConfig: false,
        }).config;
  const installRecords = await loadInstalledPluginIndexInstallRecords();
  const nextInstallRecords = recordPluginInstallInRecords(installRecords, {
    pluginId: params.pluginId,
    ...params.install,
  });
  const slotResult =
    params.enable === false
      ? { config: next, warnings: [] }
      : applySlotSelectionForPlugin(next, params.pluginId);
  next = withoutPluginInstallRecords(slotResult.config);
  await commitPluginInstallRecordsWithConfig({
    previousInstallRecords: installRecords,
    nextInstallRecords,
    nextConfig: next,
    baseHash: params.snapshot.baseHash,
  });
  await refreshPluginRegistryAfterConfigMutation({
    config: next,
    reason: "source-changed",
    installRecords: nextInstallRecords,
    logger: {
      warn: (message) => defaultRuntime.log(theme.warn(message)),
    },
  });
  logSlotWarnings(slotResult.warnings);
  if (params.warningMessage) {
    defaultRuntime.log(theme.warn(params.warningMessage));
  }
  defaultRuntime.log(params.successMessage ?? `Installed plugin: ${params.pluginId}`);
  defaultRuntime.log("Restart the gateway to load plugins.");
  return next;
}

export async function persistHookPackInstall(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  hookPackId: string;
  hooks: string[];
  install: Omit<HookInstallUpdate, "hookId" | "hooks">;
  successMessage?: string;
}): Promise<OpenClawConfig> {
  let next = enableInternalHookEntries(params.snapshot.config, params.hooks);
  next = recordHookInstall(next, {
    hookId: params.hookPackId,
    hooks: params.hooks,
    ...params.install,
  });
  await replaceConfigFile({
    nextConfig: next,
    baseHash: params.snapshot.baseHash,
  });
  defaultRuntime.log(params.successMessage ?? `Installed hook pack: ${params.hookPackId}`);
  logHookPackRestartHint();
  return next;
}
