import { getRuntimeConfig, readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import { updateNpmInstalledHookPacks } from "../hooks/update.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
  withPluginInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import { updateNpmInstalledPlugins } from "../plugins/update.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { commitPluginInstallRecordsWithConfig } from "./plugins-install-record-commit.js";
import { refreshPluginRegistryAfterConfigMutation } from "./plugins-registry-refresh.js";
import { logPluginUpdateOutcomes } from "./plugins-update-outcomes.js";
import {
  resolveHookPackUpdateSelection,
  resolvePluginUpdateSelection,
} from "./plugins-update-selection.js";
import { promptYesNo } from "./prompt.js";

export async function runPluginUpdateCommand(params: {
  id?: string;
  opts: { all?: boolean; dryRun?: boolean; dangerouslyForceUnsafeInstall?: boolean };
}) {
  const sourceSnapshotPromise = readConfigFileSnapshot().catch(() => null);
  const cfg = getRuntimeConfig();
  const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
  const cfgWithPluginInstallRecords = withPluginInstallRecords(cfg, pluginInstallRecords);
  const logger = {
    info: (msg: string) => defaultRuntime.log(msg),
    warn: (msg: string) => defaultRuntime.log(theme.warn(msg)),
  };
  const pluginSelection = resolvePluginUpdateSelection({
    installs: pluginInstallRecords,
    rawId: params.id,
    all: params.opts.all,
  });
  const hookSelection = resolveHookPackUpdateSelection({
    installs: cfg.hooks?.internal?.installs ?? {},
    rawId: params.id,
    all: params.opts.all,
  });

  if (pluginSelection.pluginIds.length === 0 && hookSelection.hookIds.length === 0) {
    if (params.opts.all) {
      defaultRuntime.log("No tracked plugins or hook packs to update.");
      return;
    }
    defaultRuntime.error("Provide a plugin or hook-pack id, or use --all.");
    return defaultRuntime.exit(1);
  }

  const pluginResult = await updateNpmInstalledPlugins({
    config: cfgWithPluginInstallRecords,
    pluginIds: pluginSelection.pluginIds,
    specOverrides: pluginSelection.specOverrides,
    dryRun: params.opts.dryRun,
    dangerouslyForceUnsafeInstall: params.opts.dangerouslyForceUnsafeInstall,
    logger,
    onIntegrityDrift: async (drift) => {
      const specLabel = drift.resolvedSpec ?? drift.spec;
      defaultRuntime.log(
        theme.warn(
          `Integrity drift detected for "${drift.pluginId}" (${specLabel})` +
            `\nExpected: ${drift.expectedIntegrity}` +
            `\nActual:   ${drift.actualIntegrity}`,
        ),
      );
      if (drift.dryRun) {
        return true;
      }
      return await promptYesNo(`Continue updating "${drift.pluginId}" with this artifact?`);
    },
  });
  const hookResult = await updateNpmInstalledHookPacks({
    config: pluginResult.config,
    hookIds: hookSelection.hookIds,
    specOverrides: hookSelection.specOverrides,
    dryRun: params.opts.dryRun,
    logger,
    onIntegrityDrift: async (drift) => {
      const specLabel = drift.resolvedSpec ?? drift.spec;
      defaultRuntime.log(
        theme.warn(
          `Integrity drift detected for hook pack "${drift.hookId}" (${specLabel})` +
            `\nExpected: ${drift.expectedIntegrity}` +
            `\nActual:   ${drift.actualIntegrity}`,
        ),
      );
      if (drift.dryRun) {
        return true;
      }
      return await promptYesNo(`Continue updating hook pack "${drift.hookId}" with this artifact?`);
    },
  });

  const outcomeSummary = logPluginUpdateOutcomes({
    outcomes: [...pluginResult.outcomes, ...hookResult.outcomes],
    log: (message) => defaultRuntime.log(message),
  });

  if (!params.opts.dryRun && (pluginResult.changed || hookResult.changed)) {
    const nextPluginInstallRecords = pluginResult.config.plugins?.installs ?? {};
    const shouldPersistPluginInstallIndex =
      pluginResult.changed || Object.keys(pluginInstallRecords).length > 0;
    const nextConfig = shouldPersistPluginInstallIndex
      ? withoutPluginInstallRecords(hookResult.config)
      : hookResult.config;
    if (shouldPersistPluginInstallIndex) {
      await commitPluginInstallRecordsWithConfig({
        previousInstallRecords: pluginInstallRecords,
        nextInstallRecords: nextPluginInstallRecords,
        nextConfig,
        baseHash: (await sourceSnapshotPromise)?.hash,
        writeOptions: {
          afterWrite: { mode: "restart", reason: "plugin source changed" },
        },
      });
    } else {
      await replaceConfigFile({
        nextConfig,
        baseHash: (await sourceSnapshotPromise)?.hash,
      });
    }
    if (pluginResult.changed) {
      await refreshPluginRegistryAfterConfigMutation({
        config: nextConfig,
        reason: "source-changed",
        installRecords: nextPluginInstallRecords,
        logger,
      });
    }
    defaultRuntime.log("Restart the gateway to load plugins and hooks.");
  }

  if (outcomeSummary.hasErrors) {
    defaultRuntime.exit(1);
  }
}
