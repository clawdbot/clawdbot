import { getRuntimeConfig } from "../config/config.js";
import { formatPluginSourceForTable, resolvePluginSourceRoots } from "../plugins/source-display.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { quietPluginJsonLogger } from "./plugins-command-helpers.js";
import { formatPluginLine } from "./plugins-list-format.js";

export type PluginsListOptions = {
  json?: boolean;
  enabled?: boolean;
  verbose?: boolean;
};

export async function runPluginsListCommand(
  opts: PluginsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const { buildPluginRegistrySnapshotReport } = await import("../plugins/status.js");
  const cfg = getRuntimeConfig();
  const report = buildPluginRegistrySnapshotReport({
    config: cfg,
    ...(opts.json ? { logger: quietPluginJsonLogger } : {}),
  });
  const list = opts.enabled ? report.plugins.filter((p) => p.enabled) : report.plugins;

  if (opts.json) {
    const payload = {
      workspaceDir: report.workspaceDir,
      registry: {
        source: report.registrySource,
        diagnostics: report.registryDiagnostics,
      },
      plugins: list,
      diagnostics: report.diagnostics,
    };
    writeRuntimeJson(runtime, payload);
    return;
  }

  if (list.length === 0) {
    runtime.log(theme.muted("No plugins found."));
    return;
  }

  const enabled = list.filter((p) => p.enabled).length;
  runtime.log(`${theme.heading("Plugins")} ${theme.muted(`(${enabled}/${list.length} enabled)`)}`);

  if (!opts.verbose) {
    const tableWidth = getTerminalTableWidth();
    const sourceRoots = resolvePluginSourceRoots({
      workspaceDir: report.workspaceDir,
    });
    const usedRoots = new Set<keyof typeof sourceRoots>();
    const rows = list.map((plugin) => {
      const desc = plugin.description ? theme.muted(plugin.description) : "";
      const formattedSource = formatPluginSourceForTable(plugin, sourceRoots);
      if (formattedSource.rootKey) {
        usedRoots.add(formattedSource.rootKey);
      }
      const sourceLine = desc ? `${formattedSource.value}\n${desc}` : formattedSource.value;
      return {
        Name: plugin.name || plugin.id,
        ID: plugin.name && plugin.name !== plugin.id ? plugin.id : "",
        Format: plugin.format ?? "openclaw",
        Status:
          plugin.status === "error"
            ? theme.error("error")
            : plugin.enabled
              ? theme.success("enabled")
              : theme.warn("disabled"),
        Source: sourceLine,
        Version: plugin.version ?? "",
      };
    });

    if (usedRoots.size > 0) {
      runtime.log(theme.muted("Source roots:"));
      for (const key of ["stock", "workspace", "global"] as const) {
        if (!usedRoots.has(key)) {
          continue;
        }
        const dir = sourceRoots[key];
        if (!dir) {
          continue;
        }
        runtime.log(`  ${theme.command(`${key}:`)} ${theme.muted(dir)}`);
      }
      runtime.log("");
    }

    runtime.log(
      renderTable({
        width: tableWidth,
        columns: [
          { key: "Name", header: "Name", minWidth: 14, flex: true },
          { key: "ID", header: "ID", minWidth: 10, flex: true },
          { key: "Format", header: "Format", minWidth: 9 },
          { key: "Status", header: "Status", minWidth: 10 },
          { key: "Source", header: "Source", minWidth: 26, flex: true },
          { key: "Version", header: "Version", minWidth: 8 },
        ],
        rows,
      }).trimEnd(),
    );
    return;
  }

  const lines: string[] = [];
  for (const plugin of list) {
    lines.push(formatPluginLine(plugin, true));
    lines.push("");
  }
  runtime.log(lines.join("\n").trim());
}
