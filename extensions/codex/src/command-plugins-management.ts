import {
  renderMessagePresentationFallbackText,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
// Codex plugin module implements command plugins management behavior.
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./app-server/config.js";
import { isOpenAiCuratedMarketplaceName } from "./app-server/plugin-inventory.js";
import type { v2 } from "./app-server/protocol.js";
import { canMutateCodexHost } from "./command-authorization.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import { buildCodexPluginAppLinks } from "./command-plugin-app-links.js";
import {
  describeConfiguredPluginIdentityConflict,
  marketplaceNamesRepresentSameCatalog,
  matchesConfiguredPluginIdentity,
  persistedPluginName,
  resolveConfiguredPluginKey,
  resolveCuratedMarketplaceAliases,
  resolveInstalledPluginKey,
  type CodexPluginConfigEntry,
  type CodexPluginsConfigBlock,
} from "./command-plugin-config.js";
import {
  formatCodexPluginReadiness,
  readCodexPluginReadiness,
} from "./command-plugins-readiness.js";
import type { CodexPluginCommandContext } from "./command-plugins-runtime.js";
import {
  buildCodexCommandPickerPresentation,
  type CodexCommandPickerButton,
} from "./command-presentation.js";
import {
  discoverCodexMarketplacePlugins,
  parseCodexPluginMarketplaceId,
  type CodexAvailablePlugin,
  type CodexPluginMarketplaceListRequest,
} from "./plugin-marketplace-discovery.js";

export type { CodexPluginsConfigBlock } from "./command-plugin-config.js";

/**
 * Lightweight read/write surface over the Openclaw config file. Plugged in by
 * the command registration site so this module stays decoupled from the
 * concrete `mutateConfigFile` import in tests.
 */
export type CodexPluginsManagementIO = {
  readConfig: () => Promise<{
    enabled?: boolean;
    plugins?: Record<string, CodexPluginConfigEntry>;
  }>;
  mutate: (update: (block: CodexPluginsConfigBlock) => void) => Promise<void>;
};

type CodexPluginsManagementRuntime = {
  workspaceDir: () => Promise<string>;
  list: CodexPluginMarketplaceListRequest;
  install: (params: v2.PluginInstallParams) => Promise<v2.PluginInstallResponse>;
  refresh?: (workspaceDir: string) => Promise<{ diagnostics: { message: string }[] }>;
  withContext?: <T>(run: (context: CodexPluginCommandContext) => Promise<T>) => Promise<T>;
};

// Plugin lifecycle changes (enable/disable) write to openclaw.json
// synchronously. The Codex app-server picks up the new policy when the next
// thread starts; in-flight conversations keep the old policy until /new or
// /reset. A full gateway restart is NOT needed.
const POLICY_REFRESH_HINT =
  "New Codex conversations pick this up automatically. Use /new or /reset to refresh the current one.";

export async function handleCodexPluginsSubcommand(
  ctx: PluginCommandContext,
  rest: string[],
  io: CodexPluginsManagementIO,
  runtime?: CodexPluginsManagementRuntime,
): Promise<PluginCommandResult> {
  const [verb = "list", ...args] = rest;
  const normalized = verb.toLowerCase();

  if (normalized === "menu") {
    if (args.length > 0) {
      return { text: "Usage: /codex plugins menu" };
    }
    return buildPluginsMenuReply();
  }

  if (normalized === "help") {
    if (args.length > 0) {
      return { text: "Usage: /codex plugins help" };
    }
    return { text: buildPluginsHelp() };
  }

  if (normalized === "list") {
    if (args.length > 0) {
      return { text: "Usage: /codex plugins list" };
    }
    const current = await io.readConfig();
    return {
      text: formatPluginList(current.plugins ?? {}, { globalEnabled: current.enabled === true }),
    };
  }

  if (normalized === "available") {
    if (args.length > 0) {
      return { text: "Usage: /codex plugins available" };
    }
    if (!canMutateCodexHost(ctx)) {
      return {
        text: "Only an owner or operator.admin gateway client can list available Codex plugins.",
      };
    }
    if (!runtime) {
      return { text: "Codex plugin discovery is unavailable for this command." };
    }
    try {
      const discovered = await discoverCodexMarketplacePlugins({
        request: runtime.list,
        workspaceDir: await runtime.workspaceDir(),
      });
      return { text: formatAvailablePlugins(discovered.plugins, discovered.warnings) };
    } catch (error) {
      return {
        text: `Could not list Codex plugins: ${formatCodexDisplayText(errorMessage(error))}`,
      };
    }
  }

  if (normalized === "status") {
    const requestedPlugin = args[0];
    const page = args[1] === undefined ? 1 : Number(args[1]);
    if (!requestedPlugin || args.length > 2 || !Number.isSafeInteger(page) || page < 1) {
      return {
        text: "Usage: /codex plugins status <configured-plugin> [page]. Use /codex plugins list to find a configured plugin.",
      };
    }
    if (!canMutateCodexHost(ctx)) {
      return {
        text: "Only an owner or operator.admin gateway client can inspect Codex plugin status.",
      };
    }
    if (!runtime?.withContext) {
      return {
        text: "Codex plugin status is unavailable. Check the configured Codex app-server, then run this command again.",
      };
    }
    return await runtime.withContext(async (context) => {
      const configured = resolveConfiguredPluginKey(context.current.plugins ?? {}, requestedPlugin);
      if (configured.status === "ambiguous" || configured.status === "mismatched") {
        return {
          text: describeConfiguredPluginIdentityConflict(requestedPlugin, configured.status),
        };
      }
      if (configured.status === "missing") {
        return {
          text: "This plugin is not explicitly configured. Use /codex plugins list, or /codex plugins available to find an install command.",
        };
      }
      return formatCodexPluginReadiness(
        await readCodexPluginReadiness({
          context,
          current: context.current,
          configKey: configured.configKey,
        }),
        page,
      );
    });
  }

  if (normalized === "install") {
    if (args.length !== 1 || !args[0]) {
      return { text: "Usage: /codex plugins install <plugin>@<marketplace>" };
    }
    if (!canMutateCodexHost(ctx)) {
      return {
        text: "Only an owner or operator.admin gateway client can run /codex plugins install.",
      };
    }
    if (!runtime) {
      return { text: "Codex plugin installation is unavailable for this command." };
    }
    return await installCodexPlugin(args[0], io, runtime);
  }

  const target = args[0];
  if (normalized === "enable" || normalized === "disable") {
    if (args.length === 0) {
      const current = await io.readConfig();
      return buildPluginNamePickerReply(normalized, current);
    }
    if (!target || args.length > 1) {
      return { text: `Usage: /codex plugins ${normalized} <name>` };
    }
    if (!canMutateCodexHost(ctx)) {
      return {
        text: `Only an owner or operator.admin gateway client can run /codex plugins ${normalized}.`,
      };
    }
    const wantEnabled = normalized === "enable";
    const current = (await io.readConfig()).plugins ?? {};
    const exact = current[target];
    const requested = parseCodexPluginMarketplaceId(target);
    const configured =
      exact && requested && !matchesConfiguredPluginIdentity(exact, requested, target)
        ? ({ status: "matched", configKey: target } as const)
        : resolveConfiguredPluginKey(current, target);
    if (configured.status === "ambiguous" || configured.status === "mismatched") {
      return {
        text: describeConfiguredPluginIdentityConflict(target, configured.status),
      };
    }
    if (configured.status === "missing") {
      return {
        text: `Codex sub-plugin '${formatCodexDisplayText(target)}' is not configured. Run '/codex plugins list' to see configured plugins.`,
      };
    }
    const configKey = configured.configKey;
    await io.mutate((block) => {
      if (wantEnabled) {
        block.enabled = true;
      }
      block.plugins ??= {};
      block.plugins[configKey] = { ...block.plugins[configKey], enabled: wantEnabled };
    });
    return {
      text: `${formatCodexDisplayText(configKey)}: ${wantEnabled ? "enabled" : "disabled"} in openclaw.json. ${POLICY_REFRESH_HINT}`,
    };
  }

  return {
    text: `Unknown /codex plugins subcommand: ${formatCodexDisplayText(verb)}\n\n${buildPluginsHelp()}`,
  };
}

function buildPluginsMenuReply(): PluginCommandResult {
  const buttons: CodexCommandPickerButton[] = [
    { label: "list", command: "/codex plugins list" },
    { label: "available", command: "/codex plugins available" },
    { label: "status", command: "/codex plugins status" },
    { label: "enable", command: "/codex plugins enable" },
    { label: "disable", command: "/codex plugins disable" },
    { label: "help", command: "/codex plugins help" },
    { label: "back", command: "/codex" },
  ];
  const text = [
    "Codex sub-plugins. Pick a sub-action or type:",
    "",
    "  1. /codex plugins list",
    "  2. /codex plugins available",
    "  3. /codex plugins status <configured-plugin>",
    "  4. /codex plugins enable",
    "  5. /codex plugins disable",
    "  6. /codex plugins help",
    "",
    "Type '/codex' to go back to the main menu.",
  ].join("\n");
  return {
    text,
    presentation: buildCodexCommandPickerPresentation(
      "Codex sub-plugins",
      "Pick a Codex sub-plugin action:",
      buttons,
    ),
  };
}

function buildPluginNamePickerReply(
  verb: "enable" | "disable",
  current: CodexPluginsConfigBlock,
): PluginCommandResult {
  const globalEnabled = current.enabled === true;
  const entries = Object.entries(current.plugins ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const eligible = entries.filter(([, entry]) => {
    const effectivelyEnabled = globalEnabled && entry.enabled !== false;
    return verb === "disable" ? effectivelyEnabled : !effectivelyEnabled;
  });

  if (eligible.length === 0) {
    const action = verb === "enable" ? "disabled" : "enabled";
    return {
      text: [
        `No configured ${action} Codex sub-plugins found.`,
        "",
        "Type '/codex plugins list' to inspect configured sub-plugins.",
        "Type '/codex plugins menu' to go back to the plugins menu.",
      ].join("\n"),
      presentation: buildCodexCommandPickerPresentation(
        "Codex sub-plugins",
        "Pick another Codex sub-plugin action:",
        [
          { label: "list", command: "/codex plugins list" },
          { label: "back", command: "/codex plugins menu" },
        ],
      ),
    };
  }

  const buttons: CodexCommandPickerButton[] = [
    ...eligible.map(([key]) => ({
      label: formatCodexDisplayText(key),
      command: `/codex plugins ${verb} ${key}`,
    })),
    { label: "back", command: "/codex plugins menu" },
  ];
  const text = [
    `Codex sub-plugins to ${verb}. Pick one or type:`,
    "",
    ...eligible.map(([key], index) => `  ${index + 1}. /codex plugins ${verb} ${key}`),
    "",
    ...(verb === "enable" && !globalEnabled
      ? ["Global codexPlugins.enabled is off; enabling one configured sub-plugin turns it on.", ""]
      : []),
    "Type '/codex plugins menu' to go back to the plugins menu.",
  ].join("\n");

  return {
    text,
    presentation: buildCodexCommandPickerPresentation(
      "Codex sub-plugins",
      `Pick a Codex sub-plugin to ${verb}:`,
      buttons,
    ),
  };
}

function buildPluginsHelp(): string {
  return [
    "Codex plugin discovery and owner-approved installation:",
    "- /codex plugins                            (alias for list)",
    "- /codex plugins list                       show explicitly configured plugins",
    "- /codex plugins available                  list discoverable Codex marketplaces",
    "- /codex plugins status <configured-plugin> [page]  inspect app readiness without refreshing",
    "- /codex plugins install <name>@<marketplace>  install and authorize one plugin",
    "- /codex plugins enable <name>              enable a configured plugin",
    "- /codex plugins disable <name>             disable a configured plugin",
    "Only an owner or operator.admin can discover, install, enable, or disable plugins.",
  ].join("\n");
}

async function installCodexPlugin(
  requestedId: string,
  io: CodexPluginsManagementIO,
  runtime: CodexPluginsManagementRuntime,
): Promise<PluginCommandResult> {
  const requested = parseCodexPluginMarketplaceId(requestedId);
  if (!requested) {
    return {
      text: "Invalid plugin identifier. Use /codex plugins install <plugin>@<marketplace> with ASCII letters, digits, underscores, or hyphens.",
    };
  }

  let plugin: CodexAvailablePlugin | undefined;
  let workspaceDir: string;
  try {
    workspaceDir = await runtime.workspaceDir();
    const discovered = await discoverCodexMarketplacePlugins({
      request: runtime.list,
      workspaceDir,
    });
    const matching = discovered.plugins.filter(
      (candidate) =>
        candidate.pluginName === requested.pluginName &&
        marketplaceNamesRepresentSameCatalog(candidate.marketplaceName, requested.marketplaceName),
    );
    if (matching.length > 1) {
      plugin = resolveCuratedMarketplaceAliases(matching, requested.marketplaceName);
      if (!plugin) {
        return {
          text: `Multiple available Codex plugins match '${formatCodexDisplayText(requestedId)}'; the marketplace identity must be unique.`,
        };
      }
    } else {
      plugin = matching[0];
    }
  } catch (error) {
    return {
      text: `Could not verify the requested Codex plugin: ${formatCodexDisplayText(errorMessage(error))}`,
    };
  }

  if (!plugin) {
    return {
      text: `${formatCodexDisplayText(requestedId)} was not found. Run /codex plugins available to inspect the current marketplaces.`,
    };
  }
  if (!plugin.available) {
    return {
      text: `${formatCodexDisplayText(requestedId)} is unavailable or disabled by its marketplace administrator.`,
    };
  }
  const alreadyInstalled = plugin.installed && plugin.enabled;
  if (!alreadyInstalled && !plugin.marketplacePath && plugin.remotePluginId) {
    if (plugin.mustShowInstallationInterstitial === true) {
      return {
        text: `${formatCodexDisplayText(requestedId)} requires a Codex installation confirmation that OpenClaw cannot display. Install it in Codex first, then rerun this command to authorize it here.`,
      };
    }
    if (plugin.mustShowInstallationInterstitial !== false) {
      return {
        text: `${formatCodexDisplayText(requestedId)} cannot be installed because Codex did not provide its required installation-confirmation policy. Install it in Codex first, then rerun this command to authorize it here.`,
      };
    }
  }

  try {
    const configured = resolveInstalledPluginKey((await io.readConfig()).plugins ?? {}, plugin);
    if (configured.status === "ambiguous" || configured.status === "mismatched") {
      return {
        text: describeConfiguredPluginIdentityConflict(requestedId, configured.status),
      };
    }
  } catch (error) {
    return {
      text: `Could not verify existing Codex plugin authorization: ${formatCodexDisplayText(errorMessage(error))}`,
    };
  }

  // Local marketplace roots are authenticated Codex catalog output, not model
  // input. Curated, bundled, and user-configured roots may live outside the
  // workspace; Codex validates the exact source against its managed policy.
  let result: v2.PluginInstallResponse | undefined;
  if (!alreadyInstalled) {
    const requestParams = plugin.marketplacePath
      ? { marketplacePath: plugin.marketplacePath, pluginName: plugin.pluginName }
      : plugin.remotePluginId
        ? { remoteMarketplaceName: plugin.marketplaceName, pluginName: plugin.remotePluginId }
        : undefined;
    if (!requestParams) {
      return {
        text: `${formatCodexDisplayText(requestedId)} cannot be installed because its marketplace did not provide a trusted local path or remote plugin identifier.`,
      };
    }
    try {
      result = await runtime.install(requestParams);
    } catch (error) {
      return {
        text: `Could not install ${formatCodexDisplayText(requestedId)}: ${formatCodexDisplayText(errorMessage(error))}`,
      };
    }
  }

  const selectedPlugin = plugin;
  try {
    await io.mutate((block) => {
      block.plugins ??= {};
      const configured = resolveInstalledPluginKey(block.plugins, selectedPlugin);
      if (configured.status === "ambiguous" || configured.status === "mismatched") {
        throw new Error(
          describeConfiguredPluginIdentityConflict(selectedPlugin.id, configured.status),
        );
      }
      const curated = isOpenAiCuratedMarketplaceName(selectedPlugin.marketplaceName);
      const canonicalId = curated
        ? `${selectedPlugin.pluginName}@${CODEX_PLUGINS_MARKETPLACE_NAME}`
        : selectedPlugin.id;
      const configKey = configured.status === "matched" ? configured.configKey : canonicalId;
      const existing = block.plugins[configKey];
      block.enabled = true;
      const updated = {
        ...existing,
        enabled: true,
        marketplaceName:
          existing?.marketplaceName ??
          (curated ? CODEX_PLUGINS_MARKETPLACE_NAME : selectedPlugin.marketplaceName),
        pluginName:
          existing?.pluginName ??
          (curated ? selectedPlugin.pluginName : persistedPluginName(selectedPlugin)),
      };
      block.plugins[configKey] = updated;
    });
  } catch (error) {
    return {
      text: `${formatCodexDisplayText(requestedId)} was installed in Codex but could not be authorized in OpenClaw and will not be exposed: ${formatCodexDisplayText(errorMessage(error))}`,
    };
  }

  let refreshWarning = "";
  if (runtime.refresh) {
    try {
      const refreshed = await runtime.refresh(workspaceDir);
      refreshWarning = refreshed.diagnostics
        .map((diagnostic) => ` ${formatCodexDisplayText(diagnostic.message)}`)
        .join("");
    } catch (error) {
      refreshWarning = ` Runtime refresh requires a new conversation: ${formatCodexDisplayText(errorMessage(error))}`;
    }
  }

  const appsNeedingAuth = result?.appsNeedingAuth ?? [];
  if (appsNeedingAuth.length > 0) {
    const authRequirement =
      appsNeedingAuth.length === 1
        ? "1 app still requires"
        : `${appsNeedingAuth.length} apps still require`;
    const presentation: MessagePresentation = {
      title: "Codex plugin app setup",
      tone: "warning",
      blocks: [
        {
          type: "text",
          text: `${formatCodexDisplayText(requestedId)} was installed and authorized, but ${authRequirement} connector authentication. Complete sign-in before using those apps.`,
        },
        ...buildCodexPluginAppLinks(appsNeedingAuth),
        { type: "context", text: `${refreshWarning.trim()} ${POLICY_REFRESH_HINT}`.trim() },
      ],
    };
    return {
      text: renderMessagePresentationFallbackText({ presentation }),
      presentation,
      presentationTextMode: "fallback",
    };
  }

  const status = alreadyInstalled
    ? "was already installed in Codex and is now authorized"
    : "was installed and authorized";
  return {
    text: `${formatCodexDisplayText(requestedId)} ${status}.${refreshWarning} ${POLICY_REFRESH_HINT}`,
  };
}

function formatAvailablePlugins(plugins: CodexAvailablePlugin[], warnings: string[]): string {
  if (plugins.length === 0) {
    return [
      "No Codex plugins were discovered for the current workspace.",
      ...warnings.map((warning) => `Warning: ${formatCodexDisplayText(warning)}`),
    ].join("\n");
  }
  return [
    "Discoverable Codex plugins:",
    ...plugins.slice(0, 30).map((plugin) => {
      const state = plugin.installed
        ? plugin.enabled
          ? "installed"
          : "installed, disabled"
        : plugin.available
          ? "available"
          : "unavailable";
      const description = plugin.description
        ? ` - ${formatCodexDisplayText(plugin.description)}`
        : "";
      return `- ${plugin.id} (${state})${description}`;
    }),
    ...(plugins.length > 30 ? ["- Additional plugins omitted."] : []),
    ...warnings.map((warning) => `Warning: ${formatCodexDisplayText(warning)}`),
    "To authorize one plugin, an owner or operator.admin must send:",
    "/codex plugins install <plugin>@<marketplace>",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatPluginList(
  plugins: Record<string, CodexPluginConfigEntry>,
  options: { globalEnabled?: boolean } = {},
): string {
  const globalEnabled = options.globalEnabled === true;
  const keys = Object.keys(plugins).toSorted();
  if (keys.length === 0) {
    return "No Codex sub-plugins configured under plugins.entries.codex.config.codexPlugins.plugins";
  }
  const rows = keys.map((key) => {
    const entry = plugins[key] ?? {};
    const state = globalEnabled && entry.enabled !== false ? "ON " : "OFF";
    const displayKey = formatCodexDisplayText(key);
    const pluginName = formatCodexDisplayText(entry.pluginName ?? key);
    const marketplace = formatCodexDisplayText(entry.marketplaceName ?? "?");
    return { displayKey, state, pluginName, marketplace };
  });
  const keyW = Math.max(...rows.map((r) => r.displayKey.length));
  const pluginW = Math.max(...rows.map((r) => r.pluginName.length));
  return [
    "Codex sub-plugins in Openclaw config (~/.openclaw/openclaw.json):",
    "",
    ...rows.map(
      (r) =>
        `  ${r.state}  ${r.displayKey.padEnd(keyW)}  ${r.pluginName.padEnd(pluginW)}  [${r.marketplace}]`,
    ),
    "",
    ...(globalEnabled
      ? []
      : ["Global codexPlugins.enabled is off; configured sub-plugins are inactive.", ""]),
    "New Codex conversations pick up policy changes automatically; /new or /reset to refresh the current one.",
  ].join("\n");
}
