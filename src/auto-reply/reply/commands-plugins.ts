// Implements plugin command listing and configuration helpers.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { readConfigFileSnapshot, readConfigFileSnapshotForWrite } from "../../config/config.js";
import { assertConfigWriteAllowedInCurrentMode } from "../../config/nix-mode-write-guard.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
  type ConfigSnapshotForInstallPersist,
} from "../../plugins/install-persistence.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import type { PluginRecord } from "../../plugins/registry.js";
import {
  buildAllPluginInspectReports,
  buildPluginDiagnosticsReport,
  buildPluginInspectReport,
  buildPluginRegistrySnapshotReport,
  formatPluginCompatibilityNotice,
  type PluginStatusReport,
} from "../../plugins/status.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScope,
} from "./command-gates.js";
import { installPluginFromPluginsCommand } from "./commands-plugins-install.js";
import type { CommandHandler } from "./commands-types.js";
import { AutoReplyConfigMutationError, setPluginEnabledFromCommand } from "./config-mutations.js";
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

function isPluginsWriteAction(action: string): boolean {
  return action === "install" || action === "enable" || action === "disable";
}

function hasGatewayAdminScope(params: Parameters<CommandHandler>[0]): boolean {
  return params.ctx.GatewayClientScopes?.includes("operator.admin") === true;
}

function rejectNixModePluginWrite(): {
  shouldContinue: false;
  reply: { text: string };
} | null {
  try {
    assertConfigWriteAllowedInCurrentMode();
    return null;
  } catch (error) {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${formatErrorMessage(error)}` },
    };
  }
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
  const prepared = await readConfigFileSnapshotForWrite();
  const snapshot = prepared.snapshot;
  if (!snapshot.valid) {
    return {
      ok: false,
      path: snapshot.path,
      error: "Config file is invalid; fix it before using /plugins.",
    };
  }
  const writeOptions = selectInstallMutationWriteOptions(prepared.writeOptions);
  const { pluginMutation } = resolveInstallConfigMutationPreflights({
    parsed: (snapshot.parsed ?? {}) as Record<string, unknown>,
    snapshotPath: snapshot.path,
    writeOptions,
  });
  if (pluginMutation.mode === "blocked") {
    return {
      ok: false,
      path: snapshot.path,
      error: pluginMutation.reason,
    };
  }
  return {
    ok: true,
    path: snapshot.path,
    snapshot: {
      config: structuredClone(snapshot.sourceConfig),
      baseHash: snapshot.hash,
      writeOptions,
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

  if (isPluginsWriteAction(pluginsCommand.action)) {
    const missingAdminScope = requireGatewayClientScope(params, {
      label: "/plugins write",
      allowedScopes: ["operator.admin"],
      missingText:
        "❌ /plugins install|enable|disable requires operator.admin for gateway clients.",
    });
    if (missingAdminScope) {
      return missingAdminScope;
    }
    if (!params.command.senderIsOwner && !hasGatewayAdminScope(params)) {
      const nonOwner = rejectNonOwnerCommand(params, "/plugins write");
      if (nonOwner) {
        return nonOwner;
      }
    }
    const nixModeWrite = rejectNixModePluginWrite();
    if (nixModeWrite) {
      return nixModeWrite;
    }
  }

  if (pluginsCommand.action === "install") {
    return await withPluginLifecycleLease({}, async () => {
      const loadedConfig = await loadPluginCommandConfig();
      if (!loadedConfig.ok) {
        return {
          shouldContinue: false,
          reply: { text: `⚠️ ${loadedConfig.error}` },
        };
      }
      const installed = await installPluginFromPluginsCommand({
        raw: pluginsCommand.spec,
        force: pluginsCommand.force,
        config: loadedConfig.snapshot.config,
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
          text: [
            `🔌 Installed plugin "${installed.pluginId}". Gateway restart will load the new plugin source.`,
            ...(installed.warnings ?? []).map((warning) => `⚠️ ${warning}`),
          ].join("\n"),
        },
      };
    });
  }

  const handleLoadedCommand = async () => {
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

    let registryWarning: string | undefined;
    try {
      const committedConfig = await setPluginEnabledFromCommand({
        pluginId: plugin.id,
        enabled: pluginsCommand.action === "enable",
        action: pluginsCommand.action,
      });
      await refreshPluginRegistryAfterConfigMutation({
        config: committedConfig,
        reason: "policy-changed",
        logger: {
          warn: (message) => {
            registryWarning = message;
          },
        },
      });
    } catch (error) {
      if (error instanceof AutoReplyConfigMutationError) {
        return { shouldContinue: false, reply: { text: `⚠️ ${error.message}` } };
      }
      throw error;
    }

    return {
      shouldContinue: false,
      reply: {
        text:
          `🔌 Plugin "${plugin.id}" ${pluginsCommand.action}d in ${loaded.path}. Gateway reload will apply it to new agent turns.` +
          (registryWarning ? `\n${registryWarning}` : ""),
      },
    };
  };

  if (pluginsCommand.action === "enable" || pluginsCommand.action === "disable") {
    return await withPluginLifecycleLease({}, handleLoadedCommand);
  }
  return await handleLoadedCommand();
};
