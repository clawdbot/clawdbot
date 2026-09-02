import { renderMessagePresentationFallbackText } from "openclaw/plugin-sdk/interactive-runtime";
import type { PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { formatCodexDisplayText } from "./command-formatters.js";
import {
  buildCodexCommandPickerPresentation,
  type CodexCommandPickerButton,
} from "./command-presentation.js";
import {
  filterCodexMarketplacePlugins,
  type CodexAvailablePlugin,
} from "./plugin-marketplace-discovery.js";

const AVAILABLE_PAGE_SIZE = 10;

export function formatCodexAvailablePlugins(
  plugins: CodexAvailablePlugin[],
  warnings: string[],
  query: string,
  page: number,
): PluginCommandResult {
  const filtered = filterCodexMarketplacePlugins(plugins, query);
  const pageCount = Math.max(1, Math.ceil(filtered.length / AVAILABLE_PAGE_SIZE));
  const start = (page - 1) * AVAILABLE_PAGE_SIZE;
  const visible = filtered.slice(start, start + AVAILABLE_PAGE_SIZE);
  // The delimiter keeps a quoted query containing --page from becoming an option.
  const pageCommand = (target: number) =>
    `/codex plugins available --page ${target}${query ? ` -- '${query.replaceAll("'", "'\\''")}'` : ""}`;
  const buttons: CodexCommandPickerButton[] = [];
  const lines: string[] = [];
  if (filtered.length === 0) {
    lines.push(
      query
        ? `No Codex plugins match "${formatCodexDisplayText(query)}" in the returned catalogs. Try a shorter search or browse all plugins.`
        : "No Codex plugins were discovered for the current workspace.",
    );
  } else if (page > pageCount) {
    lines.push(
      `No plugin page ${page}. There are ${filtered.length} results across ${pageCount} pages.`,
    );
    buttons.push({ label: "First page", command: pageCommand(1) });
  } else {
    lines.push(
      `Showing ${start + 1}–${start + visible.length} of ${filtered.length}${query ? ` matches for "${formatCodexDisplayText(query)}"` : " plugins"} (page ${page}/${pageCount}).`,
    );
    if (page > 1) {
      buttons.push({ label: "Previous page", command: pageCommand(page - 1) });
    }
    if (page < pageCount) {
      buttons.push({ label: "Next page", command: pageCommand(page + 1) });
    }
    lines.push(
      ...visible.map((plugin) => {
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
    );
  }
  lines.push(
    ...warnings.map((warning) => `Warning: ${formatCodexDisplayText(warning)}`),
    "Search names, marketplaces, or descriptions: /codex plugins available <query>",
    "To authorize one plugin, an owner or operator.admin must send:",
    "/codex plugins install <plugin>@<marketplace>",
  );
  if (query) {
    buttons.push({ label: "Browse all plugins", command: "/codex plugins available" });
  }
  buttons.push({ label: "Plugin controls", command: "/codex plugins menu" });
  const presentation = buildCodexCommandPickerPresentation(
    "Discoverable Codex plugins",
    lines.join("\n"),
    buttons,
  );
  return {
    text: renderMessagePresentationFallbackText({ presentation }),
    presentation,
    presentationTextMode: "fallback",
  };
}
