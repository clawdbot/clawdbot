// Codex plugin module implements command plugins management behavior.
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { canMutateCodexHost } from "./command-authorization.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import {
  buildCodexCommandPickerPresentation,
  type CodexCommandPickerButton,
} from "./command-presentation.js";

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

type CodexPluginConfigEntry = {
  enabled?: boolean;
  marketplaceName?: string;
  pluginName?: string;
  allow_destructive_actions?: boolean | "auto" | "ask";
};

export type CodexPluginsConfigBlock = {
  enabled?: boolean;
  plugins?: Record<string, CodexPluginConfigEntry>;
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
    if (!current[target]) {
      return {
        text: `Codex sub-plugin '${formatCodexDisplayText(target)}' is not configured. Run '/codex plugins list' to see configured plugins.`,
      };
    }
    await io.mutate((block) => {
      if (wantEnabled) {
        block.enabled = true;
      }
      block.plugins ??= {};
      block.plugins[target] = { ...block.plugins[target], enabled: wantEnabled };
    });
    return {
      text: `${formatCodexDisplayText(target)}: ${wantEnabled ? "enabled" : "disabled"} in openclaw.json. ${POLICY_REFRESH_HINT}`,
    };
  }

  return {
    text: `Unknown /codex plugins subcommand: ${formatCodexDisplayText(verb)}\n\n${buildPluginsHelp()}`,
  };
}

function buildPluginsMenuReply(): PluginCommandResult {
  const buttons: CodexCommandPickerButton[] = [
    { label: "list", command: "/codex plugins list" },
    { label: "enable", command: "/codex plugins enable" },
    { label: "disable", command: "/codex plugins disable" },
    { label: "help", command: "/codex plugins help" },
    { label: "back", command: "/codex" },
  ];
  const text = [
    "Codex sub-plugins. Pick a sub-action or type:",
    "",
    "  1. /codex plugins list",
    "  2. /codex plugins enable",
    "  3. /codex plugins disable",
    "  4. /codex plugins help",
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
    "Codex sub-plugin management (writes only to ~/.openclaw/openclaw.json, never to ~/.codex/config.toml):",
    "- /codex plugins                  (alias for list)",
    "- /codex plugins list             show all configured Codex sub-plugins",
    "- /codex plugins enable <name>    enable a configured sub-plugin",
    "- /codex plugins disable <name>   disable a configured sub-plugin",
  ].join("\n");
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
