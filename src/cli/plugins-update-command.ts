import { loadConfig, readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import { updateNpmInstalledHookPacks } from "../hooks/update.js";
import { updateNpmInstalledPlugins } from "../plugins/update.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
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
  const cfg = loadConfig();
  const logger = {
    info: (msg: string) => defaultRuntime.log(msg),
    warn: (msg: string) => defaultRuntime.log(theme.warn(msg)),
  };
  const pluginSelection = resolvePluginUpdateSelection({
    installs: cfg.plugins?.installs ?? {},
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
    config: cfg,
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

  for (const outcome of pluginResult.outcomes) {
    if (outcome.status === "error") {
      defaultRuntime.log(theme.error(outcome.message));
      continue;
    }
    if (outcome.status === "skipped") {
      defaultRuntime.log(theme.warn(outcome.message));
      continue;
    }
    defaultRuntime.log(outcome.message);
  }

  for (const outcome of hookResult.outcomes) {
    if (outcome.status === "error") {
      defaultRuntime.log(theme.error(outcome.message));
      continue;
    }
    if (outcome.status === "skipped") {
      defaultRuntime.log(theme.warn(outcome.message));
      continue;
    }
    defaultRuntime.log(outcome.message);
  }

  if (!params.opts.dryRun && (pluginResult.changed || hookResult.changed)) {
    await replaceConfigFile({
      nextConfig: hookResult.config,
      baseHash: (await sourceSnapshotPromise)?.hash,
    });
    defaultRuntime.log("Restart the gateway to load plugins and hooks.");
  }
}
