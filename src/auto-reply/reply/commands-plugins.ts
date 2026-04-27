import fs from "node:fs";
import { buildNpmInstallRecordFields } from "../../cli/npm-resolution.js";
import {
  buildPreferredClawHubSpec,
  createPluginInstallLogger,
  decidePreferredClawHubFallback,
  resolveFileNpmSpecToLocalPath,
} from "../../cli/plugins-command-helpers.js";
import { persistPluginInstall } from "../../cli/plugins-install-persist.js";
import type { ConfigSnapshotForInstallPersist } from "../../cli/plugins-install-persist.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../cli/plugins-registry-refresh.js";
import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { resolveArchiveKind } from "../../infra/archive.js";
import { parseClawHubPluginSpec } from "../../infra/clawhub.js";
import { installPluginFromClawHub } from "../../plugins/clawhub.js";
import { installPluginFromNpmSpec, installPluginFromPath } from "../../plugins/install.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { clearPluginManifestRegistryCache } from "../../plugins/manifest-registry.js";
import type { PluginRecord } from "../../plugins/registry.js";
import {
  buildAllPluginInspectReports,
  buildPluginDiagnosticsReport,
  buildPluginInspectReport,
  buildPluginRegistrySnapshotReport,
  formatPluginCompatibilityNotice,
  type PluginStatusReport,
} from "../../plugins/status.js";
import { setPluginEnabledInConfig } from "../../plugins/toggle-config.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { resolveUserPath } from "../../utils.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScopeForInternalChannel,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { parsePluginsCommand } from "./plugins-commands.js";

function renderJsonBlock(label: string, value: unknown): string {
  return `${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function buildPluginInspectJson(params: {
  id: string;
  config: OpenClawConfig;
  installRecords: Record<string, PluginInstallRecord>;
  report: PluginStatusReport;
}): {
  inspect: NonNullable<ReturnType<typeof buildPluginInspectReport>>;
  compatibilityWarnings: Array<{
    code: string;
    severity: string;
    message: string;
  }>;
  install: PluginInstallRecord | null;
} | null {
  const inspect = buildPluginInspectReport({
    id: params.id,
    config: params.config,
    report: params.report,
  });
  if (!inspect) {
    return null;
  }
  return {
    inspect,
    compatibilityWarnings: inspect.compatibility.map((warning) => ({
      code: warning.code,
      severity: warning.severity,
      message: formatPluginCompatibilityNotice(warning),
    })),
    install: params.installRecords[inspect.plugin.id] ?? null,
  };
}

function buildAllPluginInspectJson(params: {
  config: OpenClawConfig;
  installRecords: Record<string, PluginInstallRecord>;
  report: PluginStatusReport;
}): Array<{
  inspect: ReturnType<typeof buildAllPluginInspectReports>[number];
  compatibilityWarnings: Array<{
    code: string;
    severity: string;
    message: string;
  }>;
  install: PluginInstallRecord | null;
}> {
  return buildAllPluginInspectReports({
    config: params.config,
    report: params.report,
  }).map((inspect) => ({
    inspect,
    compatibilityWarnings: inspect.compatibility.map((warning) => ({
      code: warning.code,
      severity: warning.severity,
      message: formatPluginCompatibilityNotice(warning),
    })),
    install: params.installRecords[inspect.plugin.id] ?? null,
  }));
}

function formatPluginLabel(plugin: PluginRecord): string {
  if (!plugin.name || plugin.name === plugin.id) {
    return plugin.id;
  }
  return `${plugin.name} (${plugin.id})`;
}

function formatPluginsList(report: PluginStatusReport): string {
  if (report.plugins.length === 0) {
    return `🔌 No plugins found for workspace ${report.workspaceDir ?? "(unknown workspace)"}.`;
  }

  const loaded = report.plugins.filter((plugin) => plugin.status === "loaded").length;
  const lines = [
    `🔌 Plugins (${loaded}/${report.plugins.length} loaded)`,
    ...report.plugins.map((plugin) => {
      const format = plugin.bundleFormat
        ? `${plugin.format ?? "openclaw"}/${plugin.bundleFormat}`
        : (plugin.format ?? "openclaw");
      return `- ${formatPluginLabel(plugin)} [${plugin.status}] ${format}`;
    }),
  ];
  return lines.join("\n");
}

function findPlugin(report: PluginStatusReport, rawName: string): PluginRecord | undefined {
  const target = normalizeOptionalLowercaseString(rawName);
  if (!target) {
    return undefined;
  }
  return report.plugins.find(
    (plugin) =>
      normalizeOptionalLowercaseString(plugin.id) === target ||
      normalizeOptionalLowercaseString(plugin.name) === target,
  );
}

function looksLikeLocalPluginInstallSpec(raw: string): boolean {
  return (
    raw.startsWith(".") ||
    raw.startsWith("~") ||
    raw.startsWith("/") ||
    raw.endsWith(".ts") ||
    raw.endsWith(".js") ||
    raw.endsWith(".mjs") ||
    raw.endsWith(".cjs") ||
    raw.endsWith(".tgz") ||
    raw.endsWith(".tar.gz") ||
    raw.endsWith(".tar") ||
    raw.endsWith(".zip")
  );
}

async function installPluginFromPluginsCommand(params: {
  raw: string;
  snapshot: ConfigSnapshotForInstallPersist;
}): Promise<{ ok: true; pluginId: string } | { ok: false; error: string }> {
  const fileSpec = resolveFileNpmSpecToLocalPath(params.raw);
  if (fileSpec && !fileSpec.ok) {
    return { ok: false, error: fileSpec.error };
  }
  const normalized = fileSpec && fileSpec.ok ? fileSpec.path : params.raw;
  const resolved = resolveUserPath(normalized);

  if (fs.existsSync(resolved)) {
    const result = await installPluginFromPath({
      path: resolved,
      logger: createPluginInstallLogger(),
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    clearPluginManifestRegistryCache();
    const source: "archive" | "path" = resolveArchiveKind(resolved) ? "archive" : "path";
    await persistPluginInstall({
      snapshot: params.snapshot,
      pluginId: result.pluginId,
      install: {
        source,
        sourcePath: resolved,
        installPath: result.targetDir,
        version: result.version,
      },
    });
    return { ok: true, pluginId: result.pluginId };
  }

  if (looksLikeLocalPluginInstallSpec(params.raw)) {
    return { ok: false, error: `Path not found: ${resolved}` };
  }

  const clawhubSpec = parseClawHubPluginSpec(params.raw);
  if (clawhubSpec) {
    const result = await installPluginFromClawHub({
      spec: params.raw,
      logger: createPluginInstallLogger(),
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    clearPluginManifestRegistryCache();
    await persistPluginInstall({
      snapshot: params.snapshot,
      pluginId: result.pluginId,
      install: {
        source: "clawhub",
        spec: params.raw,
        installPath: result.targetDir,
        version: result.version,
        integrity: result.clawhub.integrity,
        resolvedAt: result.clawhub.resolvedAt,
        clawhubUrl: result.clawhub.clawhubUrl,
        clawhubPackage: result.clawhub.clawhubPackage,
        clawhubFamily: result.clawhub.clawhubFamily,
        clawhubChannel: result.clawhub.clawhubChannel,
      },
    });
    return { ok: true, pluginId: result.pluginId };
  }

  const preferredClawHubSpec = buildPreferredClawHubSpec(params.raw);
  if (preferredClawHubSpec) {
    const clawhubResult = await installPluginFromClawHub({
      spec: preferredClawHubSpec,
      logger: createPluginInstallLogger(),
    });
    if (clawhubResult.ok) {
      clearPluginManifestRegistryCache();
      await persistPluginInstall({
        snapshot: params.snapshot,
        pluginId: clawhubResult.pluginId,
        install: {
          source: "clawhub",
          spec: preferredClawHubSpec,
          installPath: clawhubResult.targetDir,
          version: clawhubResult.version,
          integrity: clawhubResult.clawhub.integrity,
          resolvedAt: clawhubResult.clawhub.resolvedAt,
          clawhubUrl: clawhubResult.clawhub.clawhubUrl,
          clawhubPackage: clawhubResult.clawhub.clawhubPackage,
          clawhubFamily: clawhubResult.clawhub.clawhubFamily,
          clawhubChannel: clawhubResult.clawhub.clawhubChannel,
        },
      });
      return { ok: true, pluginId: clawhubResult.pluginId };
    }
    if (decidePreferredClawHubFallback(clawhubResult) !== "fallback_to_npm") {
      return { ok: false, error: clawhubResult.error };
    }
  }

  const result = await installPluginFromNpmSpec({
    spec: params.raw,
    logger: createPluginInstallLogger(),
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  clearPluginManifestRegistryCache();
  const installRecord = buildNpmInstallRecordFields({
    spec: params.raw,
    installPath: result.targetDir,
    version: result.version,
    resolution: result.npmResolution,
  });
  await persistPluginInstall({
    snapshot: params.snapshot,
    pluginId: result.pluginId,
    install: installRecord,
  });
  return { ok: true, pluginId: result.pluginId };
}

async function loadPluginCommandState(
  workspaceDir: string,
  options?: { loadModules?: boolean },
): Promise<
  | {
      ok: true;
      path: string;
      config: OpenClawConfig;
      report: PluginStatusReport;
    }
  | { ok: false; path: string; error: string }
> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    return {
      ok: false,
      path: snapshot.path,
      error: "Config file is invalid; fix it before using /plugins.",
    };
  }
  const config = structuredClone(snapshot.resolved);
  return {
    ok: true,
    path: snapshot.path,
    config,
    report:
      options?.loadModules === true
        ? buildPluginDiagnosticsReport({ config, workspaceDir })
        : buildPluginRegistrySnapshotReport({ config, workspaceDir }),
  };
}

async function loadPluginCommandConfig(): Promise<
  | { ok: true; path: string; snapshot: ConfigSnapshotForInstallPersist }
  | { ok: false; path: string; error: string }
> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    return {
      ok: false,
      path: snapshot.path,
      error: "Config file is invalid; fix it before using /plugins.",
    };
  }
  return {
    ok: true,
    path: snapshot.path,
    snapshot: {
      config: structuredClone(snapshot.sourceConfig),
      baseHash: snapshot.hash,
    },
  };
}

export const handlePluginsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const pluginsCommand = parsePluginsCommand(params.command.commandBodyNormalized);
  if (!pluginsCommand) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/plugins");
  if (unauthorized) {
    return unauthorized;
  }
  const allowInternalReadOnly =
    (pluginsCommand.action === "list" || pluginsCommand.action === "inspect") &&
    isInternalMessageChannel(params.command.channel);
  const nonOwner = allowInternalReadOnly ? null : rejectNonOwnerCommand(params, "/plugins");
  if (nonOwner) {
    return nonOwner;
  }
  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/plugins",
    configKey: "plugins",
  });
  if (disabled) {
    return disabled;
  }
  if (pluginsCommand.action === "error") {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${pluginsCommand.message}` },
    };
  }

  const missingAdminScope = requireGatewayClientScopeForInternalChannel(params, {
    label: "/plugins write",
    allowedScopes: ["operator.admin"],
    missingText: "❌ /plugins install|enable|disable requires operator.admin for gateway clients.",
  });
  if (missingAdminScope) {
    return missingAdminScope;
  }

  if (pluginsCommand.action === "install") {
    const loadedConfig = await loadPluginCommandConfig();
    if (!loadedConfig.ok) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${loadedConfig.error}` },
      };
    }
    const installed = await installPluginFromPluginsCommand({
      raw: pluginsCommand.spec,
      snapshot: loadedConfig.snapshot,
    });
    if (!installed.ok) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${installed.error}` },
      };
    }
    return {
      shouldContinue: false,
      reply: {
        text: `🔌 Installed plugin "${installed.pluginId}". Restart the gateway to load plugins.`,
      },
    };
  }

  const loaded = await loadPluginCommandState(params.workspaceDir, {
    loadModules: pluginsCommand.action === "inspect",
  });
  if (!loaded.ok) {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${loaded.error}` },
    };
  }

  if (pluginsCommand.action === "list") {
    return {
      shouldContinue: false,
      reply: { text: formatPluginsList(loaded.report) },
    };
  }

  if (pluginsCommand.action === "inspect") {
    const installRecords = await loadInstalledPluginIndexInstallRecords();
    if (!pluginsCommand.name) {
      return {
        shouldContinue: false,
        reply: { text: formatPluginsList(loaded.report) },
      };
    }
    if (normalizeOptionalLowercaseString(pluginsCommand.name) === "all") {
      return {
        shouldContinue: false,
        reply: {
          text: renderJsonBlock(
            "🔌 Plugins",
            buildAllPluginInspectJson({ ...loaded, installRecords }),
          ),
        },
      };
    }
    const payload = buildPluginInspectJson({
      id: pluginsCommand.name,
      config: loaded.config,
      installRecords,
      report: loaded.report,
    });
    if (!payload) {
      return {
        shouldContinue: false,
        reply: { text: `🔌 No plugin named "${pluginsCommand.name}" found.` },
      };
    }
    return {
      shouldContinue: false,
      reply: {
        text: renderJsonBlock(`🔌 Plugin "${payload.inspect.plugin.id}"`, {
          ...payload.inspect,
          compatibilityWarnings: payload.compatibilityWarnings,
          install: payload.install,
        }),
      },
    };
  }

  const plugin = findPlugin(loaded.report, pluginsCommand.name);
  if (!plugin) {
    return {
      shouldContinue: false,
      reply: { text: `🔌 No plugin named "${pluginsCommand.name}" found.` },
    };
  }

  const next = setPluginEnabledInConfig(
    structuredClone(loaded.config),
    plugin.id,
    pluginsCommand.action === "enable",
  );
  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    const issue = validated.issues[0];
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Config invalid after /plugins ${pluginsCommand.action} (${issue.path}: ${issue.message}).`,
      },
    };
  }
  await writeConfigFile(validated.config);
  let registryWarning: string | undefined;
  await refreshPluginRegistryAfterConfigMutation({
    config: validated.config,
    reason: "policy-changed",
    logger: {
      warn: (message) => {
        registryWarning = message;
      },
    },
  });

  return {
    shouldContinue: false,
    reply: {
      text:
        `🔌 Plugin "${plugin.id}" ${pluginsCommand.action}d in ${loaded.path}. Restart the gateway to apply.` +
        (registryWarning ? `\n${registryWarning}` : ""),
    },
  };
};
