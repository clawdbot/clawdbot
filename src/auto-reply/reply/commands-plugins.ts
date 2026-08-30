// Implements plugin command listing and configuration helpers.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolvePluginCapabilityConsentCliOptions } from "../../cli/plugin-capability-consent.js";
import { readConfigFileSnapshot, readConfigFileSnapshotForWrite } from "../../config/config.js";
import { assertConfigWriteAllowedInCurrentMode } from "../../config/nix-mode-write-guard.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
  type ConfigSnapshotForInstallPersist,
} from "../../plugins/install-persistence.js";
import type { InstalledPluginIndex } from "../../plugins/installed-plugin-index.js";
import { resolveInstalledPluginPackageOwnership } from "../../plugins/installed-plugin-package-ownership.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
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
  commandReply,
  defineAuthorizedTextCommand,
  rejectNonOwnerCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScope,
} from "./command-gates.js";
import {
  formatPluginCommandCapabilityConsentError,
  installPluginFromPluginsCommand,
} from "./commands-plugins-install.js";
import type { CommandHandler } from "./commands-types.js";
import { AutoReplyConfigMutationError, setPluginEnabledFromCommand } from "./config-mutations.js";
import { parsePluginsCommand } from "./plugins-commands.js";

function renderJsonBlock(label: string, value: unknown): string {
  return `${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function buildPluginInspectJson(
  inspect: ReturnType<typeof buildAllPluginInspectReports>[number],
  index: InstalledPluginIndex,
) {
  const ownership = resolveInstalledPluginPackageOwnership(index, inspect.plugin.id);
  return {
    inspect,
    compatibilityWarnings: inspect.compatibility.map((warning) => ({
      code: warning.code,
      severity: warning.severity,
      message: formatPluginCompatibilityNotice(warning),
    })),
    install: ownership.ok ? ownership.value.installRecord : null,
  };
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

export const handlePluginsCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/plugins", match: parsePluginsCommand },
  async (params, pluginsCommand) => {
    const disabled = requireCommandFlagEnabled(params.cfg, {
      label: "/plugins",
      configKey: "plugins",
    });
    if (disabled) {
      return disabled;
    }
    if (pluginsCommand.action === "error") {
      return commandReply(`⚠️ ${pluginsCommand.message}`);
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
          return commandReply(`⚠️ ${loadedConfig.error}`);
        }
        const installed = await installPluginFromPluginsCommand({
          raw: pluginsCommand.spec,
          acceptCapabilities: pluginsCommand.acceptCapabilities,
          force: pluginsCommand.force,
          snapshot: loadedConfig.snapshot,
        });
        if (!installed.ok) {
          return commandReply(`⚠️ ${installed.error}`);
        }
        return commandReply(
          [
            `🔌 Installed plugin "${installed.pluginId}". Gateway restart will load the new plugin source.`,
            ...(installed.warnings ?? []).map((warning) => `⚠️ ${warning}`),
          ].join("\n"),
        );
      });
    }

    const handleLoadedCommand = async () => {
      const snapshot = await readConfigFileSnapshot();
      if (!snapshot.valid) {
        return commandReply("⚠️ Config file is invalid; fix it before using /plugins.");
      }
      const config = structuredClone(snapshot.resolved);
      const reportParams = { config, workspaceDir: params.workspaceDir };

      if (pluginsCommand.action === "inspect") {
        const metadataSnapshot = loadPluginMetadataSnapshot(reportParams);
        const report = buildPluginDiagnosticsReport({ ...reportParams, metadataSnapshot });
        if (!pluginsCommand.name) {
          return commandReply(formatPluginsList(report));
        }
        if (normalizeOptionalLowercaseString(pluginsCommand.name) === "all") {
          const reports = buildAllPluginInspectReports({ config, report }).map((inspect) =>
            buildPluginInspectJson(inspect, metadataSnapshot.index),
          );
          return commandReply(renderJsonBlock("🔌 Plugins", reports));
        }
        const inspect = buildPluginInspectReport({
          id: pluginsCommand.name,
          config,
          report,
        });
        if (!inspect) {
          return commandReply(`🔌 No plugin named "${pluginsCommand.name}" found.`);
        }
        const payload = buildPluginInspectJson(inspect, metadataSnapshot.index);
        return commandReply(
          renderJsonBlock(`🔌 Plugin "${inspect.plugin.id}"`, {
            ...inspect,
            compatibilityWarnings: payload.compatibilityWarnings,
            install: payload.install,
          }),
        );
      }

      const report = buildPluginRegistrySnapshotReport(reportParams);
      if (pluginsCommand.action === "list") {
        return commandReply(formatPluginsList(report));
      }
      const plugin = findPlugin(report, pluginsCommand.name);
      if (!plugin) {
        return commandReply(`🔌 No plugin named "${pluginsCommand.name}" found.`);
      }

      let registryWarning: string | undefined;
      try {
        const committedConfig = await setPluginEnabledFromCommand({
          pluginId: plugin.id,
          enabled: pluginsCommand.action === "enable",
          action: pluginsCommand.action,
          ...resolvePluginCapabilityConsentCliOptions({
            acceptCapabilities:
              pluginsCommand.action === "enable" && pluginsCommand.acceptCapabilities,
            action: "enable",
            allowPrompt: false,
          }),
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
        const consentError = formatPluginCommandCapabilityConsentError(
          error,
          `/plugins enable ${plugin.id}`,
        );
        if (consentError) {
          return commandReply(`⚠️ ${consentError}`);
        }
        if (error instanceof AutoReplyConfigMutationError) {
          return commandReply(`⚠️ ${error.message}`);
        }
        throw error;
      }

      return commandReply(
        `🔌 Plugin "${plugin.id}" ${pluginsCommand.action}d in ${snapshot.path}. Gateway reload will apply it to new agent turns.` +
          (registryWarning ? `\n${registryWarning}` : ""),
      );
    };

    if (pluginsCommand.action === "enable" || pluginsCommand.action === "disable") {
      return await withPluginLifecycleLease({}, handleLoadedCommand);
    }
    return await handleLoadedCommand();
  },
);
